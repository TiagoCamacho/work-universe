import * as vscode from 'vscode';
import { UniverseStore } from '../model/store';
import { ALL_WORKSPACES, Universe, Workspace } from '../model/types';
import { sameUri } from './paths';
import { captureTabs, closeTabs, restoreTabs, tabUri } from './tabSession';
import { applyWorkspaceColor } from './theme';
import { UniverseFiles } from './workspaceFile';

export interface WindowState {
	/** The universe open in this window, if any. */
	universe?: Universe;
	/** Ids of the universe workspaces currently loaded as folders 1..n. */
	activeIds: string[];
	/** More than one workspace loaded (the "search whole universe" mode). */
	allMode: boolean;
	/** Folder 0 is the universe's anchor. */
	healthy: boolean;
}

const FOLDER_CHANGE_TIMEOUT_MS = 5000;

/** Swaps the active workspace of a universe window in place, keeping folder 0 (the anchor) fixed. */
export class Switcher implements vscode.Disposable {
	private queue: Promise<unknown> = Promise.resolve();
	private switching = false;
	private warnedUnhealthy = false;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly _onDidChangeState = new vscode.EventEmitter<void>();
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		private readonly store: UniverseStore,
		readonly files: UniverseFiles,
	) {
		this.disposables.push(
			this._onDidChangeState,
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				if (!this.switching) {
					this.checkHealth();
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
		return this.files.universeIdOf(vscode.workspace.workspaceFile, this.store.getUniverses());
	}

	getWindowState(): WindowState {
		const id = this.currentUniverseId();
		const universe = id ? this.store.getUniverse(id) : undefined;
		if (!universe) {
			return { activeIds: [], allMode: false, healthy: true };
		}
		const folders = vscode.workspace.workspaceFolders ?? [];
		const healthy = !!folders[0] && sameUri(folders[0].uri, this.files.anchor(universe.id));
		const loaded = folders.slice(healthy ? 1 : 0);
		const activeIds = universe.workspaces
			.filter(w => loaded.some(f => sameUri(f.uri, w.uri)))
			.map(w => w.id);
		return { universe, activeIds, allMode: activeIds.length > 1, healthy };
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
		await this.serialize(() => this.switchInPlace(found.universe, [found.workspace], false));
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
		await this.serialize(() => this.switchInPlace(universe, universe.workspaces, true));
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
		const file = await this.files.ensureWorkspaceFile(universe, [initial]);
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
		await this.files.ensureAnchor(id);
		const pending = await this.store.takePending(id);
		if (pending?.workspaceId === ALL_WORKSPACES) {
			await this.showAll(id);
		} else if (pending) {
			await this.switchTo(pending.workspaceId);
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
		await this.files.writeWorkspaceFile(universe, [active]);
	}

	// ---- internals -------------------------------------------------------

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

	private async switchInPlace(universe: Universe, targets: Workspace[], allMode: boolean): Promise<void> {
		const state = this.getWindowState();
		if (!state.healthy) {
			this.warnedUnhealthy = false;
			this.checkHealth();
			return;
		}
		const loadedUris = (vscode.workspace.workspaceFolders ?? []).slice(1).map(f => f.uri);
		const targetUris = targets.map(w => vscode.Uri.parse(w.uri));
		const unchanged =
			loadedUris.length === targetUris.length && loadedUris.every((u, i) => sameUri(u, targetUris[i]));
		if (unchanged) {
			await applyWorkspaceColor(allMode ? undefined : targets[0].color);
			return;
		}

		const leaving = loadedUris.filter(u => !targetUris.some(t => sameUri(t, u)));
		const capture = captureTabs(leaving);
		const outgoingId = !state.allMode && state.activeIds.length === 1 ? state.activeIds[0] : undefined;

		// Entering "all" mode keeps the current tabs; otherwise tabs of leaving folders are closed.
		let toClose = allMode ? [] : capture.tabs;
		const dirty = toClose.filter(t => t.isDirty);
		if (dirty.length) {
			const decision = await this.resolveDirty(dirty);
			if (decision === 'cancel') {
				return;
			}
			if (decision === 'keepOpen') {
				toClose = toClose.filter(t => !t.isDirty);
			}
		}

		if (outgoingId) {
			await this.store.setSession(outgoingId, capture.session);
		}

		this.switching = true;
		try {
			await closeTabs(toClose);
			await this.replaceFolders(targets);
		} finally {
			this.switching = false;
		}

		await this.store.setActiveWorkspace(universe.id, allMode ? ALL_WORKSPACES : targets[0].id);
		await applyWorkspaceColor(allMode ? undefined : targets[0].color);
		if (!allMode) {
			await restoreTabs(this.store.getSession(targets[0].id));
		}
		this._onDidChangeState.fire();
	}

	private async replaceFolders(targets: Workspace[]): Promise<void> {
		const count = (vscode.workspace.workspaceFolders?.length ?? 1) - 1;
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
		const ok = vscode.workspace.updateWorkspaceFolders(
			1,
			count,
			...targets.map(w => ({ uri: vscode.Uri.parse(w.uri), name: w.name })),
		);
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
