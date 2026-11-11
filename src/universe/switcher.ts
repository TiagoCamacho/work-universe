import * as vscode from 'vscode';
import { UniverseStore, newId } from '../model/store';
import { ALL_WORKSPACES, Universe, UniverseMode, Workspace } from '../model/types';
import { logError, Timeline, timeline } from '../perf';
import { planFolderEdits } from './folderPlan';
import { sameUri, uriKey } from './paths';
import { captureTabs, closeTabs, restoreTabs, tabUri } from './tabSession';
import { applyWorkspaceColor } from './theme';
import { ANCHOR_PREFIX, UniverseFiles } from './workspaceFile';

export interface WindowState {
	/** The universe open in this window, if any. */
	universe?: Universe;
	/** Ids of the universe workspaces currently loaded as folders 1..n. */
	activeIds: string[];
	/** More than one workspace loaded (the "search whole universe" mode). */
	allMode: boolean;
	/** Folder 0 is the universe's anchor. */
	healthy: boolean;
	/** How the universe uses the window (see `Switcher.setMode`). */
	mode: UniverseMode;
}

interface SwitchRequest {
	universe: Universe;
	targets: Workspace[];
	allMode: boolean;
	/** When the switch was asked for (`performance.now()`), to log how long it waited in the queue. */
	requestedAt?: number;
}

const FOLDER_CHANGE_TIMEOUT_MS = 5000;

/** Swaps the active workspace of a universe window in place, keeping folder 0 (the anchor) fixed. */
export class Switcher implements vscode.Disposable {
	private queue: Promise<unknown> = Promise.resolve();
	private switching = false;
	private warnedUnhealthy = false;
	/** The universe of this window; fixed for the window's lifetime once known. */
	private universeId?: string;
	/** Target of a switch that has started but whose folder change hasn't landed yet. */
	private pending?: { universeId: string; ids: string[]; allMode: boolean };
	/** Most recent switch requested while another one is running; older ones are dropped. */
	private next?: SwitchRequest;
	private loop?: Promise<void>;
	/** Workspaces whose tab restore was cut short; their saved session must not be overwritten. */
	private readonly incomplete = new Set<string>();
	/** Active workspace in "together" mode, where it can't be read from the window's folders. */
	private togetherActiveId?: string;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly _onDidChangeState = new vscode.EventEmitter<void>();
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		private readonly store: UniverseStore,
		readonly files: UniverseFiles,
	) {
		this.disposables.push(
			this._onDidChangeState,
			// Workspaces added to or removed from a "together" universe are loaded or unloaded.
			store.onDidChange(() => {
				if (!this.switching && this.getWindowState().universe?.mode === 'together') {
					this.serialize(() => this.syncTogether()).catch(err => logError('updating the folders failed', err));
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				if (!this.switching) {
					this.checkHealth();
					this.adoptUnknownFolders();
					this._onDidChangeState.fire();
				}
			}),
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	// ---- state -----------------------------------------------------------

	currentUniverseId(): string | undefined {
		return (this.universeId ??= this.files.universeIdOf(vscode.workspace.workspaceFile, this.store.getUniverses()));
	}

	getWindowState(): WindowState {
		const id = this.currentUniverseId();
		const universe = id ? this.store.getUniverse(id) : undefined;
		if (!universe) {
			return { activeIds: [], allMode: false, healthy: true, mode: 'isolated' };
		}
		const folders = vscode.workspace.workspaceFolders ?? [];
		const healthy = !!folders[0] && sameUri(folders[0].uri, this.files.anchor(universe));
		const mode: UniverseMode = universe.mode ?? 'isolated';
		if (this.pending?.universeId === universe.id) {
			// A switch is under way: report where it is going, so the UI updates before VS Code is done.
			return { universe, activeIds: this.pending.ids, allMode: this.pending.allMode, healthy, mode };
		}
		if (mode === 'together') {
			// Every folder is loaded, so the active workspace is the one this window remembers.
			const active = this.togetherActive(universe);
			return { universe, activeIds: active ? [active.id] : [], allMode: false, healthy, mode };
		}
		const activeIds = this.loadedIds(universe, healthy);
		return { universe, activeIds, allMode: activeIds.length > 1, healthy, mode };
	}

	/** Ids of the workspaces that are really loaded as window folders right now. */
	private loadedIds(universe: Universe, healthy: boolean): string[] {
		const loaded = (vscode.workspace.workspaceFolders ?? []).slice(healthy ? 1 : 0);
		return universe.workspaces.filter(w => loaded.some(f => sameUri(f.uri, w.uri))).map(w => w.id);
	}

	/** The single active workspace in this window, if exactly one is loaded. */
	activeWorkspace(): { universe: Universe; workspace: Workspace } | undefined {
		const state = this.getWindowState();
		if (!state.universe || state.activeIds.length !== 1) {
			return undefined;
		}
		const workspace = state.universe.workspaces.find(w => w.id === state.activeIds[0]);
		return workspace ? { universe: state.universe, workspace } : undefined;
	}

	// ---- public actions --------------------------------------------------

	async switchTo(workspaceId: string): Promise<void> {
		const found = this.store.findWorkspace(workspaceId);
		if (!found) {
			vscode.window.showErrorMessage('Work Universe: that workspace no longer exists.');
			return;
		}
		if (this.currentUniverseId() !== found.universe.id) {
			await this.openUniverse(found.universe, workspaceId);
			return;
		}
		await this.request({ universe: found.universe, targets: [found.workspace], allMode: false });
	}

	/** Loads every workspace of the universe so VS Code's search covers all of them. */
	async showAll(universeId: string, openSearch = true): Promise<void> {
		const universe = this.store.getUniverse(universeId);
		if (!universe?.workspaces.length) {
			vscode.window.showWarningMessage('Work Universe: add a workspace to this universe first.');
			return;
		}
		if (this.currentUniverseId() !== universe.id) {
			await this.openUniverse(universe, ALL_WORKSPACES);
			return;
		}
		if (universe.mode === 'together') {
			// Everything is loaded already: just search without the active workspace's scope.
			if (openSearch) {
				await vscode.commands.executeCommand('workbench.action.findInFiles', { filesToInclude: '' });
			}
			return;
		}
		await this.request({ universe, targets: universe.workspaces, allMode: true });
		if (openSearch) {
			await vscode.commands.executeCommand('workbench.action.findInFiles');
		}
	}

	/** Cycles through the workspaces of the universe open in this window. */
	async cycle(step: 1 | -1): Promise<void> {
		const state = this.getWindowState();
		const workspaces = state.universe?.workspaces ?? [];
		if (workspaces.length < 2) {
			return;
		}
		const current = state.allMode ? -1 : workspaces.findIndex(w => w.id === state.activeIds[0]);
		const next = (current + step + workspaces.length) % workspaces.length;
		await this.switchTo(workspaces[next].id);
	}

	/** Opens a universe in this window (one reload) and activates `workspaceId` there. */
	async openUniverse(universe: Universe, workspaceId: string): Promise<void> {
		if (!universe.workspaces.length) {
			vscode.window.showWarningMessage(`Work Universe: "${universe.name}" has no workspaces yet.`);
			return;
		}
		const initial =
			universe.workspaces.find(w => w.id === universe.activeWorkspaceId) ??
			universe.workspaces.find(w => w.id === workspaceId) ??
			universe.workspaces[0];
		const file = await this.files.ensureWorkspaceFile(universe, universe.mode === 'together' ? universe.workspaces : [initial]);
		await this.store.setPending({ universeId: universe.id, workspaceId, createdAt: Date.now() });
		await vscode.commands.executeCommand('vscode.openFolder', file, { forceNewWindow: false });
	}

	/** Re-applies the folder names of loaded workspaces (after a rename). */
	async refreshFolderNames(): Promise<void> {
		const state = this.getWindowState();
		if (!state.universe || !state.healthy) {
			return;
		}
		const folders = vscode.workspace.workspaceFolders ?? [];
		const loaded = folders
			.slice(1)
			.map(f => state.universe!.workspaces.find(w => sameUri(w.uri, f.uri)));
		const stale = folders.slice(1).some((f, i) => loaded[i] && loaded[i]!.name !== f.name);
		if (stale && loaded.every(w => !!w)) {
			await this.serialize(() => this.replaceFolders(loaded as Workspace[]));
		}
	}

	/** Re-applies the color of the active workspace (after a color change). */
	async refreshColor(): Promise<void> {
		const active = this.activeWorkspace();
		if (active || this.getWindowState().allMode) {
			await applyWorkspaceColor(active?.workspace.color);
		}
	}

	/** Called once on activation: finishes a pending switch and sanity-checks the window. */
	async onActivated(): Promise<void> {
		const id = this.currentUniverseId();
		await vscode.commands.executeCommand('setContext', 'workUniverse.inUniverse', !!id);
		if (!id) {
			return;
		}
		const imported = !this.store.getUniverse(id);
		if (imported) {
			await this.importOpenUniverse(id);
		}
		const universe = this.store.getUniverse(id);
		if (!universe) {
			return;
		}
		await this.files.ensureAnchor(universe);
		await vscode.commands.executeCommand('setContext', 'workUniverse.together', universe.mode === 'together');
		if (universe.mode === 'together') {
			await this.serialize(() => this.syncTogether());
		}
		const pending = await this.store.takePending(id);
		if (pending?.workspaceId === ALL_WORKSPACES) {
			await this.showAll(id);
		} else if (pending) {
			await this.switchTo(pending.workspaceId);
		} else if (imported && this.getWindowState().allMode) {
			// A freshly imported file listing several folders: narrow to the first one.
			await this.switchTo(universe.workspaces[0].id);
		} else {
			const state = this.getWindowState();
			if (state.universe && state.activeIds.length === 1) {
				await this.store.setActiveWorkspace(state.universe.id, state.activeIds[0]);
			}
			await this.refreshColor();
			this.checkHealth();
		}
		this._onDidChangeState.fire();
	}

	/** Rewrites the universe window's folders as anchor + active workspace. May restart extensions. */
	async repair(): Promise<void> {
		const id = this.currentUniverseId();
		const universe = id ? this.store.getUniverse(id) : undefined;
		if (!universe?.workspaces.length) {
			return;
		}
		const state = this.getWindowState();
		const active =
			universe.workspaces.find(w => w.id === state.activeIds[0]) ??
			universe.workspaces.find(w => w.id === universe.activeWorkspaceId) ??
			universe.workspaces[0];
		this.warnedUnhealthy = false;
		await this.files.writeWorkspaceFile(universe, universe.mode === 'together' ? universe.workspaces : [active]);
	}

	// ---- internals -------------------------------------------------------

	/**
	 * Registers the universe of an opened .code-workspace that carries a `workUniverse.universeId`
	 * this machine doesn't know yet (e.g. the dev fixture, or a file copied from elsewhere).
	 */
	private async importOpenUniverse(id: string): Promise<void> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const file = vscode.workspace.workspaceFile;
		if (!file || folders.length < 2) {
			return;
		}
		// Only a workspace file laid out like ours is taken over: its first folder must be the
		// "◈ …" header. Any other file that merely carries the setting is left alone.
		if (!folders[0].name.startsWith(ANCHOR_PREFIX)) {
			return;
		}
		const configuredName = vscode.workspace.getConfiguration('workUniverse').get<string>('universeName');
		const name = configuredName || folders[0].name.replace(ANCHOR_PREFIX, '').trim() || 'Universe';
		const universe: Universe = {
			id,
			name,
			createdAt: Date.now(),
			anchor: folders[0].uri.toString(),
			workspaceFile: file.toString(),
			workspaces: folders.slice(1).map(f => ({ id: newId(), name: f.name, uri: f.uri.toString() })),
		};
		universe.activeWorkspaceId = universe.workspaces[0]?.id;
		await this.store.importUniverse(universe);
	}

	/**
	 * Folders added to the window by other means (e.g. "Add Folder to Workspace…") become
	 * workspaces of the universe, and the window switches to the new one.
	 */
	private async adoptUnknownFolders(): Promise<void> {
		const state = this.getWindowState();
		if (!state.universe || !state.healthy) {
			return;
		}
		const unknown = (vscode.workspace.workspaceFolders ?? [])
			.slice(1)
			.filter(f => !state.universe!.workspaces.some(w => sameUri(w.uri, f.uri)));
		if (!unknown.length) {
			return;
		}
		const added = await this.store.addWorkspaces(
			state.universe.id,
			unknown.map(f => ({ uri: f.uri, name: f.name })),
		);
		if (added.length) {
			await this.switchTo(added[added.length - 1].id);
		}
	}

	/**
	 * Queues a switch. Only one folder change can run at a time, so while one is running just the
	 * latest request is kept: clicking A, B, C quickly goes straight from A to C.
	 */
	private request(req: SwitchRequest): Promise<void> {
		req.requestedAt = performance.now();
		this.next = req;
		this.loop ??= this.serialize(() => this.drain());
		return this.loop;
	}

	private async drain(): Promise<void> {
		try {
			while (this.next) {
				const req = this.next;
				this.next = undefined;
				await this.switchInPlace(req);
			}
		} finally {
			this.loop = undefined;
		}
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private checkHealth(): void {
		const state = this.getWindowState();
		if (state.universe && !state.healthy && !this.warnedUnhealthy) {
			this.warnedUnhealthy = true;
			vscode.window
				.showWarningMessage(
					`Work Universe: the "${state.universe.name}" header folder was removed or moved, so switching would restart all extensions.`,
					'Repair',
				)
				.then(choice => {
					if (choice === 'Repair') {
						this.repair();
					}
				});
		}
	}

	private async switchInPlace({ universe: requested, targets, allMode, requestedAt }: SwitchRequest): Promise<void> {
		// Time spent waiting for a previous switch to finish (0 when nothing was running).
		const waited = requestedAt === undefined ? 0 : Math.round(performance.now() - requestedAt);
		// The request may have waited in the queue; use the universe as it is now.
		const universe = this.store.getUniverse(requested.id) ?? requested;
		const healthy = this.getWindowState().healthy;
		if (!healthy) {
			this.warnedUnhealthy = false;
			this.checkHealth();
			return;
		}
		if (universe.mode === 'together') {
			if (!allMode) {
				await this.switchTogether(universe, targets[0], waited);
			}
			return;
		}
		const loadedUris = (vscode.workspace.workspaceFolders ?? []).slice(1).map(f => f.uri);
		const targetUris = targets.map(w => vscode.Uri.parse(w.uri));
		const target = allMode ? undefined : targets[0];
		const unchanged =
			loadedUris.length === targetUris.length && loadedUris.every((u, i) => sameUri(u, targetUris[i]));
		if (unchanged) {
			await applyWorkspaceColor(target?.color);
			return;
		}

		const loadedIds = this.loadedIds(universe, healthy);
		const outgoingId = loadedIds.length === 1 ? loadedIds[0] : undefined;
		const leaving = loadedUris.filter(u => !targetUris.some(t => sameUri(t, u)));
		const capture = captureTabs(leaving);

		// Entering "all" mode keeps the current tabs; otherwise tabs of leaving folders are closed.
		const toClose = await this.tabsToClose(allMode ? [] : capture.tabs);
		if (!toClose) {
			return;
		}

		// 1. The UI goes first: from here on the panel and status bar show the target.
		const timing = timeline('switch');
		this.pending = { universeId: universe.id, ids: targets.map(w => w.id), allMode };
		this._onDidChangeState.fire();
		timing.mark('state');

		// 2. Storage writes run in the background (they were measured at 25–145 ms on a real machine).
		if (outgoingId && !this.incomplete.delete(outgoingId)) {
			this.background('saving the tab session failed', this.store.setSession(outgoingId, capture.session));
		}

		// 3. The folder swap and the editor tabs run side by side.
		this.switching = true;
		const folders = this.replaceFolders(targets).finally(() => {
			this.switching = false;
			timing.mark('folders');
		});
		const tabs = this.swapTabs(target, toClose, timing);
		tabs.catch(() => undefined); // awaited below; avoids an unhandled rejection if folders fail first

		try {
			await folders;
		} finally {
			this.pending = undefined;
		}

		// 4. After the folder change has landed: remember it, tint the window, finish the tabs.
		this.background(
			'saving the active workspace failed',
			this.store.setActiveWorkspace(universe.id, target?.id ?? ALL_WORKSPACES),
		);
		const results = await Promise.allSettled([
			tabs,
			// Only writes the workspace file when the color actually differs from what is applied.
			applyWorkspaceColor(target?.color).then(wrote => timing.mark(wrote ? 'colorWritten' : 'colorSkipped')),
		]);
		this.logFailures(results);
		this._onDidChangeState.fire();
		timing.done(this.describe(target, toClose.length, waited, 'isolated'));
	}

	// ---- "together" mode: every folder stays loaded, a switch only swaps the tabs ----

	/** The active workspace of a universe whose folders are all kept loaded. */
	private togetherActive(universe: Universe): Workspace | undefined {
		const byId = (id?: string) => universe.workspaces.find(w => w.id === id);
		return byId(this.togetherActiveId) ?? byId(universe.activeWorkspaceId) ?? universe.workspaces[0];
	}

	/** Makes folders 1..n of the window exactly `desired` (no-op if they already are). */
	private async loadFolders(desired: Workspace[]): Promise<void> {
		const loaded = (vscode.workspace.workspaceFolders ?? []).slice(1);
		const same =
			loaded.length === desired.length &&
			loaded.every((f, i) => sameUri(f.uri, desired[i].uri) && f.name === desired[i].name);
		if (same) {
			return;
		}
		this.switching = true;
		try {
			await this.replaceFolders(desired);
		} finally {
			this.switching = false;
		}
	}

	/** In "together" mode, keeps the window's folders equal to the universe's workspaces. */
	private async syncTogether(): Promise<void> {
		const state = this.getWindowState();
		if (state.universe?.mode === 'together' && state.healthy) {
			await this.loadFolders(state.universe.workspaces);
		}
	}

	/**
	 * Changes how a universe uses the window:
	 * - `isolated`: only the active workspace's folder is loaded; search, source control and the
	 *   Explorer follow it, and every switch changes the window's folders.
	 * - `together`: every folder stays loaded; a switch only swaps the panel and the editor tabs.
	 */
	async setMode(universeId: string, mode: UniverseMode): Promise<void> {
		const isCurrent = this.currentUniverseId() === universeId;
		const active = isCurrent ? this.activeWorkspace()?.workspace : undefined;
		if (isCurrent && active) {
			// Keep reporting the same active workspace while the folders are rearranged.
			this.pending = { universeId, ids: [active.id], allMode: false };
			this.togetherActiveId = active.id;
		}
		try {
			await this.store.updateUniverse(universeId, u => {
				u.mode = mode;
			});
			if (!isCurrent) {
				return;
			}
			await vscode.commands.executeCommand('setContext', 'workUniverse.together', mode === 'together');
			const universe = this.store.getUniverse(universeId);
			if (universe && this.getWindowState().healthy) {
				const desired = mode === 'together' ? universe.workspaces : [active ?? this.togetherActive(universe)].filter(w => !!w);
				await this.serialize(() => this.loadFolders(desired as Workspace[]));
			}
		} finally {
			this.pending = undefined;
			this._onDidChangeState.fire();
		}
	}

	/** Opens the Search view. In "together" mode it is scoped to the active workspace's folder. */
	async searchActive(): Promise<void> {
		const state = this.getWindowState();
		const active = this.activeWorkspace();
		await vscode.commands.executeCommand(
			'workbench.action.findInFiles',
			state.mode === 'together' && active ? { filesToInclude: './' + active.workspace.name } : undefined,
		);
	}

	/** A switch in "together" mode: the folders don't change, only the tabs (and the panel) do. */
	private async switchTogether(universe: Universe, target: Workspace, waited: number): Promise<void> {
		await this.loadFolders(universe.workspaces);
		const outgoing = this.togetherActive(universe);
		if (outgoing?.id === target.id) {
			this.togetherActiveId = target.id;
			await applyWorkspaceColor(target.color);
			return;
		}
		const capture = captureTabs(outgoing ? [vscode.Uri.parse(outgoing.uri)] : []);
		const toClose = await this.tabsToClose(capture.tabs);
		if (!toClose) {
			return;
		}

		const timing = timeline('switch');
		this.togetherActiveId = target.id;
		this._onDidChangeState.fire();
		timing.mark('state');

		if (outgoing && !this.incomplete.delete(outgoing.id)) {
			this.background('saving the tab session failed', this.store.setSession(outgoing.id, capture.session));
		}
		this.background('saving the active workspace failed', this.store.setActiveWorkspace(universe.id, target.id));
		const results = await Promise.allSettled([
			this.swapTabs(target, toClose, timing),
			applyWorkspaceColor(target.color).then(wrote => timing.mark(wrote ? 'colorWritten' : 'colorSkipped')),
		]);
		this.logFailures(results);
		this._onDidChangeState.fire();
		timing.done(this.describe(target, toClose.length, waited, 'together'));
	}

	// ---- shared by both modes ----

	/** Tabs to close for a switch, after asking about unsaved ones. `undefined` = switch cancelled. */
	private async tabsToClose(tabs: vscode.Tab[]): Promise<vscode.Tab[] | undefined> {
		const dirty = tabs.filter(t => t.isDirty);
		if (!dirty.length) {
			return tabs;
		}
		const decision = await this.resolveDirty(dirty);
		if (decision === 'cancel') {
			return undefined;
		}
		return decision === 'keepOpen' ? tabs.filter(t => !t.isDirty) : tabs;
	}

	/**
	 * Opens the target's saved tabs and closes the old ones. The target's active editor comes
	 * first, then the old tabs close, so the editor area is never empty.
	 */
	private async swapTabs(target: Workspace | undefined, toClose: vscode.Tab[], timing: Timeline): Promise<void> {
		let closed = false;
		const closeOld = async () => {
			if (!closed) {
				closed = true;
				await closeTabs(toClose);
			}
		};
		if (target) {
			const complete = await restoreTabs(this.store.getSession(target.id), {
				onFirstShown: () => {
					timing.mark('firstEditor');
					return closeOld();
				},
				// The other tabs are restored alongside the folder change. Holding them back until
				// it had landed was tried on a real project: the folder change got no faster and
				// the tabs came back several hundred ms later.
				isCancelled: () => !!this.next,
			});
			if (!complete) {
				this.incomplete.add(target.id);
			}
		}
		await closeOld();
		timing.mark('tabs');
	}

	/** Storage writes run in the background: neither this switch nor the next one waits for them. */
	private background(what: string, write: Promise<unknown>): void {
		void write.catch(err => logError(what, err));
	}

	private logFailures(results: PromiseSettledResult<unknown>[]): void {
		for (const r of results) {
			if (r.status === 'rejected') {
				logError('switch step failed', r.reason);
			}
		}
	}

	/** Log detail of a switch. The tab counts make lines comparable: more tabs take longer. */
	private describe(target: Workspace | undefined, closed: number, waited: number, mode: UniverseMode): string {
		const restored = target
			? (this.store.getSession(target.id)?.groups ?? []).reduce((n, g) => n + g.tabs.length, 0)
			: 0;
		return `→ ${target?.name ?? 'all'} [${mode}, restored ${restored} tabs, closed ${closed}, waited ${waited}ms for the previous switch]`;
	}

	/**
	 * Makes folders 1..n of the window `targets`. Folders that are loaded before and after stay
	 * untouched: removing and re-adding one makes language servers (C# Dev Kit, …) reload every
	 * project in it, and a second switch during that reload left them with all projects failed.
	 */
	private async replaceFolders(targets: Workspace[]): Promise<void> {
		// The name is part of the key: VS Code can only rename a folder by replacing it.
		const key = (uri: vscode.Uri | string, name: string) => uriKey(uri) + '\n' + name;
		const loaded = (vscode.workspace.workspaceFolders ?? []).slice(1).map(f => key(f.uri, f.name));
		const edits = planFolderEdits(loaded, targets.map(w => key(w.uri, w.name)));
		for (const edit of edits) {
			// Folder 0 is the anchor, so every index is shifted by one.
			await this.updateFolders(
				edit.start + 1,
				edit.deleteCount,
				edit.insert.map(i => ({ uri: vscode.Uri.parse(targets[i].uri), name: targets[i].name })),
			);
		}
	}

	/** One folder update, resolved once VS Code reports it (the next update must wait for that). */
	private async updateFolders(start: number, deleteCount: number, add: { uri: vscode.Uri; name: string }[]): Promise<void> {
		const changed = new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				listener.dispose();
				resolve();
			}, FOLDER_CHANGE_TIMEOUT_MS);
			const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
				clearTimeout(timer);
				listener.dispose();
				resolve();
			});
		});
		const ok = vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...add);
		if (!ok) {
			throw new Error('VS Code rejected the workspace folder update.');
		}
		await changed;
	}

	private async resolveDirty(dirty: vscode.Tab[]): Promise<'save' | 'keepOpen' | 'cancel'> {
		let policy = vscode.workspace.getConfiguration('workUniverse').get<string>('dirtyFiles', 'prompt');
		if (policy === 'prompt') {
			const names = dirty.map(t => t.label).slice(0, 5).join(', ');
			const choice = await vscode.window.showWarningMessage(
				`${dirty.length} unsaved file(s) in this workspace: ${names}`,
				{ modal: true, detail: 'Save them before switching, or keep them open as tabs in the next workspace.' },
				'Save All',
				'Keep Open',
			);
			policy = choice === 'Save All' ? 'save' : choice === 'Keep Open' ? 'keepOpen' : 'cancel';
		}
		if (policy === 'save') {
			for (const tab of dirty) {
				const uri = tabUri(tab);
				const doc =
					vscode.workspace.textDocuments.find(d => uri && sameUri(d.uri, uri)) ??
					vscode.workspace.notebookDocuments.find(d => uri && sameUri(d.uri, uri));
				if (doc && !(await doc.save())) {
					return 'cancel';
				}
			}
			return 'save';
		}
		return policy === 'keepOpen' ? 'keepOpen' : 'cancel';
	}
}
