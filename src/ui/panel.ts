import * as vscode from 'vscode';
import { ActionRunner } from '../actions/actionRunner';
import { ActionStore } from '../actions/actionStore';
import { CustomAction } from '../actions/types';
import { FileTargets } from '../fileCommands';
import { UniverseStore } from '../model/store';
import { Workspace } from '../model/types';
import { markLate } from '../perf';
import { isInside, sameUri, uriKey } from '../universe/paths';
import { Switcher } from '../universe/switcher';
import { DecorationSource } from './decorations';
import { FileEntry, FileModel, FileTarget } from './fileModel';
import { IconThemeResolver } from './iconTheme';
import { panelHtml } from './panelHtml';
import { DEFAULT_WORKSPACE_ICON } from './util';

export const PANEL_VIEW_ID = 'workUniverse.panel';

/**
 * After a switch, git needs a moment to open the new folder's repository. During this time the
 * webview keeps showing the decorations it cached for that workspace instead of an empty set.
 */
const DECORATION_GRACE_MS = 1200;

interface WireTarget {
	uri: string;
	root: string;
	dir: boolean;
	isRoot?: boolean;
}

type Message =
	| { type: 'ready' }
	| { type: 'switch'; workspaceId: string }
	| { type: 'add' }
	| { type: 'searchAll' }
	| { type: 'reorder'; workspaceIds: string[] }
	| { type: 'openUniverse'; universeId: string }
	| { type: 'create' }
	| { type: 'listMany'; items: { key: string; uri: string; root: string }[] }
	| { type: 'painted' }
	| { type: 'open'; uri: string; preview: boolean }
	| { type: 'select'; items: WireTarget[] }
	| { type: 'command'; id: string; target?: WireTarget }
	| { type: 'move'; sources: string[]; target: string }
	| { type: 'runAction'; index: number };

/**
 * The whole Work Universe sidebar in one webview: a tab strip of workspaces on top and an
 * Explorer-like file tree of the active workspace below it.
 */
export class UniversePanel implements vscode.WebviewViewProvider, FileTargets, vscode.Disposable {
	private view?: vscode.WebviewView;
	private selection: FileTarget[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	/** Actions currently shown as buttons (only when exactly one workspace is active). */
	private shownActions: CustomAction[] = [];
	private activeColor: string | undefined;

	/** Bumped on every state request; only the newest one gets posted. */
	private stateRun = 0;
	/** Last state / decorations sent, to skip identical posts. */
	private lastState?: string;
	private lastDecorations?: string;
	private lastWorkspaceKey?: string;
	/** Icon classes whose CSS the webview already has. */
	private readonly sentIcons = new Set<string>();
	/** Workspaces the webview has received decorations for (it caches them per workspace). */
	private readonly decorated = new Set<string>();
	private decorationGraceUntil = 0;
	private decorationTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly store: UniverseStore,
		private readonly switcher: Switcher,
		private readonly model: FileModel,
		private readonly icons: IconThemeResolver,
		private readonly decorations: DecorationSource,
		private readonly actionStore: ActionStore,
		private readonly actionRunner: ActionRunner,
	) {
		const onState = () => {
			this.syncRoots();
			void this.postState();
		};
		this.disposables.push(
			store.onDidChange(onState),
			switcher.onDidChangeState(onState),
			model.onDidChange(keys => this.post({ type: 'refresh', keys })),
			decorations.onDidChange(() => this.postDecorations()),
			icons.onDidChange(() => {
				if (this.view) {
					this.view.webview.options = this.webviewOptions();
				}
				this.resetIcons();
				void this.postState(true);
				this.post({ type: 'refresh' });
			}),
			vscode.window.onDidChangeActiveTextEditor(e => this.reveal(e)),
			actionRunner.onDidChangeRunning(() => void this.postState()),
			actionStore.onDidChange(id => {
				if (this.switcher.activeWorkspace()?.workspace.id === id) {
					void this.postState();
				}
			}),
		);
		this.syncRoots();
		this.warmActions();
	}

	dispose(): void {
		clearTimeout(this.decorationTimer);
		this.disposables.forEach(d => d.dispose());
	}

	/** Reads every workspace's actions file ahead of time, so the first switch doesn't wait for it. */
	private warmActions(): void {
		for (const workspace of this.switcher.getWindowState().universe?.workspaces ?? []) {
			void this.actionStore.get(workspace.id);
		}
	}

	// ---- FileTargets -------------------------------------------------------

	fromArg(arg: unknown): FileTarget | undefined {
		const a = arg as { uri?: unknown; root?: unknown; webviewSection?: unknown } | undefined;
		if (!a || typeof a.uri !== 'string' || typeof a.root !== 'string') {
			return undefined;
		}
		return {
			uri: vscode.Uri.parse(a.uri),
			root: vscode.Uri.parse(a.root),
			isDirectory: a.webviewSection !== 'file',
			isRoot: a.webviewSection === 'root',
		};
	}

	selected(): FileTarget[] {
		return this.selection;
	}

	roots(): readonly vscode.Uri[] {
		return this.model.getRoots();
	}

	changed(): void {
		this.model.changed();
	}

	collapseAll(): void {
		this.post({ type: 'collapseAll' });
	}

	// ---- webview -----------------------------------------------------------

	private webviewOptions(): vscode.WebviewOptions {
		return {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicons'), ...this.icons.resourceRoots],
		};
	}

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this.view = view;
		await this.icons.ready();
		view.webview.options = this.webviewOptions();
		// VS Code renders a single-view container header as "CONTAINER: VIEW TITLE" (or just the
		// container name when the view title is empty); extensions can't show only a custom title.
		view.title = '';
		view.webview.html = panelHtml(view.webview, vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicons', 'codicon.css'));
		view.webview.onDidReceiveMessage((msg: Message) => this.onMessage(msg), undefined, this.disposables);
		view.onDidChangeVisibility(() => view.visible && this.reveal(vscode.window.activeTextEditor), undefined, this.disposables);
		view.onDidDispose(() => (this.view = undefined), undefined, this.disposables);
	}

	private post(message: unknown): void {
		this.view?.webview.postMessage(message);
	}

	private syncRoots(): void {
		const state = this.switcher.getWindowState();
		const roots = (state.universe?.workspaces ?? [])
			.filter(w => state.activeIds.includes(w.id))
			.map(w => vscode.Uri.parse(w.uri));
		if (this.model.setRoots(roots)) {
			this.selection = [];
		}
	}

	/**
	 * Sends the panel its state. Calls made in the same tick collapse into one message, and a
	 * message identical to the previous one is not sent at all (unless `force`).
	 */
	private async postState(force = false): Promise<void> {
		if (!this.view) {
			return;
		}
		const run = ++this.stateRun;
		const single = this.switcher.activeWorkspace();
		const file = single ? await this.actionStore.get(single.workspace.id) : await Promise.resolve({ actions: [], active_color: undefined });
		if (run !== this.stateRun || !this.view) {
			return; // a newer request is on its way
		}
		this.shownActions = file.actions;
		this.activeColor = file.active_color;
		const state = this.switcher.getWindowState();
		const universe = state.universe;
		const active = universe?.workspaces.filter(w => state.activeIds.includes(w.id)) ?? [];
		const workspaceKey = state.allMode ? '*all*' : active[0]?.id ?? '';
		const rootOf = (w: Workspace) => {
			const uri = vscode.Uri.parse(w.uri);
			return {
				key: uriKey(uri),
				uri: uri.toString(),
				name: w.name,
				icon: this.icons.folderIcon(w.name, false, true),
				iconOpen: this.icons.folderIcon(w.name, true, true),
			};
		};
		const roots = active.map(rootOf);
		const payload = {
			type: 'state',
			inUniverse: !!universe,
			allMode: state.allMode,
			mode: state.mode,
			workspaceKey,
			hasIconTheme: this.icons.hasTheme,
			hidesArrows: this.icons.hidesArrows,
			roots,
			tabs: (universe?.workspaces ?? []).map(w => ({
				id: w.id,
				name: w.name,
				icon: w.icon ?? DEFAULT_WORKSPACE_ICON,
				color: w.color,
				active: !state.allMode && state.activeIds.includes(w.id),
				// Lets the webview start loading a workspace the moment its tab is clicked.
				root: rootOf(w),
			})),
			actions: this.shownActions.map((a, index) => ({
				index,
				label: a.label,
				icon: a.icon,
				color: a.color,
				detail: a.command ?? a.vscodeCommand,
				running: !!single && this.actionRunner.isRunning(single.workspace.id, a.label),
			})),
			activeColor: this.activeColor,
			activeWorkspaceId: single?.workspace.id,
			universes: this.store.getUniverses().map(u => ({ id: u.id, name: u.name, count: u.workspaces.length })),
		};
		const json = JSON.stringify(payload);
		if (force || json !== this.lastState) {
			this.lastState = json;
			this.ensureIcons(payload.tabs.flatMap(t => [t.root.icon, t.root.iconOpen]));
			this.post(payload);
		}
		if (workspaceKey !== this.lastWorkspaceKey) {
			this.lastWorkspaceKey = workspaceKey;
			markLate('switch', 'panelPosted');
			this.onWorkspaceShown(workspaceKey);
		}
	}

	/** Called when the panel starts showing another workspace. */
	private onWorkspaceShown(workspaceKey: string): void {
		// The webview already has decorations for a workspace it showed before; give git time to
		// catch up before replacing them. A first visit has nothing to keep, so it posts right away.
		this.lastDecorations = undefined;
		this.decorationGraceUntil = this.decorated.has(workspaceKey) ? Date.now() + DECORATION_GRACE_MS : 0;
		this.postDecorations();
		this.reveal(vscode.window.activeTextEditor);
	}

	/** Sends the CSS of icon classes the webview hasn't seen yet. */
	private ensureIcons(classes: (string | undefined)[]): void {
		if (!this.view) {
			return;
		}
		const fresh = new Set<string>();
		for (const cls of classes) {
			if (cls && !this.sentIcons.has(cls)) {
				this.sentIcons.add(cls);
				fresh.add(cls);
			}
		}
		if (fresh.size) {
			this.post({ type: 'icons', css: this.icons.rulesFor(this.view.webview, fresh), append: true });
		}
	}

	private resetIcons(): void {
		this.sentIcons.clear();
		if (this.view) {
			this.post({ type: 'icons', css: this.icons.baseCss(this.view.webview), append: false });
		}
	}

	private postDecorations(): void {
		clearTimeout(this.decorationTimer);
		const wait = this.decorationGraceUntil - Date.now();
		if (wait > 0) {
			this.decorationTimer = setTimeout(() => this.postDecorations(), wait);
			return;
		}
		const map = this.decorations.compute(this.model.getRoots());
		const json = JSON.stringify(map);
		if (json !== this.lastDecorations) {
			this.lastDecorations = json;
			if (this.lastWorkspaceKey !== undefined) {
				this.decorated.add(this.lastWorkspaceKey);
			}
			this.post({ type: 'decorations', map, workspaceKey: this.lastWorkspaceKey });
		}
	}

	private toRow(e: FileEntry) {
		return {
			key: uriKey(e.uri),
			uri: e.uri.toString(),
			name: e.name,
			dir: e.isDirectory,
			icon: e.isDirectory ? this.icons.folderIcon(e.name, false) : this.icons.fileIcon(e.name),
			iconOpen: e.isDirectory ? this.icons.folderIcon(e.name, true) : undefined,
		};
	}

	private async onMessage(msg: Message): Promise<void> {
		const state = this.switcher.getWindowState();
		switch (msg.type) {
			case 'ready':
				// A fresh webview knows nothing: resend everything.
				this.lastState = this.lastDecorations = this.lastWorkspaceKey = undefined;
				this.decorated.clear();
				this.resetIcons();
				await this.postState(true);
				break;
			case 'switch':
				await this.switcher.switchTo(msg.workspaceId);
				// The webview switched on its own when clicked; if the switch was cancelled
				// (unsaved files, broken window) this puts it back.
				await this.postState(true);
				break;
			case 'add':
				if (state.universe) {
					await vscode.commands.executeCommand('workUniverse.addWorkspace', { type: 'universe', universe: state.universe });
				}
				break;
			case 'searchAll':
				if (state.universe) {
					await this.switcher.showAll(state.universe.id);
				}
				break;
			case 'reorder':
				if (state.universe) {
					await this.store.reorderWorkspaces(state.universe.id, msg.workspaceIds);
				}
				break;
			case 'openUniverse': {
				const universe = this.store.getUniverse(msg.universeId);
				if (universe) {
					await this.switcher.openUniverse(universe, universe.activeWorkspaceId ?? universe.workspaces[0]?.id);
				}
				break;
			}
			case 'create':
				await vscode.commands.executeCommand('workUniverse.createUniverse');
				break;
			case 'listMany': {
				// Every requested folder is read in parallel and answered in one message.
				const lists = await this.model.listMany(
					msg.items.map(i => ({ uri: vscode.Uri.parse(i.uri), root: vscode.Uri.parse(i.root) })),
				);
				const payload = msg.items.map((item, n) => ({ key: item.key, rows: lists[n].map(e => this.toRow(e)) }));
				this.ensureIcons(payload.flatMap(l => l.rows.flatMap(r => [r.icon, r.iconOpen])));
				this.post({ type: 'childrenMany', lists: payload });
				break;
			}
			case 'painted':
				markLate('switch', 'panelPainted');
				break;
			case 'open':
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(msg.uri), {
					preview: msg.preview,
					preserveFocus: msg.preview,
				});
				break;
			case 'select':
				this.selection = msg.items.map(i => this.toTarget(i));
				break;
			case 'command':
				await vscode.commands.executeCommand(
					msg.id,
					msg.target
						? {
								uri: msg.target.uri,
								root: msg.target.root,
								webviewSection: msg.target.isRoot ? 'root' : msg.target.dir ? 'folder' : 'file',
							}
						: undefined,
				);
				break;
			case 'runAction': {
				const single = this.switcher.activeWorkspace();
				const action = this.shownActions[msg.index];
				if (single && action) {
					await this.actionRunner.run(single.workspace, action, this.activeColor);
				}
				break;
			}
			case 'move':
				await vscode.commands.executeCommand(
					'workUniverse.files.move',
					msg.sources.map(s => vscode.Uri.parse(s)),
					vscode.Uri.parse(msg.target),
				);
				break;
		}
	}

	private toTarget(t: WireTarget): FileTarget {
		return { uri: vscode.Uri.parse(t.uri), root: vscode.Uri.parse(t.root), isDirectory: t.dir, isRoot: t.isRoot };
	}

	/** Expands the tree down to the active editor's file and selects it, like the Explorer. */
	private reveal(editor: vscode.TextEditor | undefined): void {
		if (!editor || !this.view?.visible) {
			return;
		}
		if (!vscode.workspace.getConfiguration('workUniverse').get<boolean>('autoReveal', true)) {
			return;
		}
		const uri = editor.document.uri;
		const root = this.model.getRoots().find(r => isInside(uri, r));
		if (!root || sameUri(uri, root)) {
			return;
		}
		const chain: { key: string; uri: string }[] = [];
		let dir = vscode.Uri.joinPath(uri, '..');
		while (isInside(dir, root) && !sameUri(dir, root)) {
			chain.unshift({ key: uriKey(dir), uri: dir.toString() });
			dir = vscode.Uri.joinPath(dir, '..');
		}
		this.post({ type: 'reveal', key: uriKey(uri), rootKey: uriKey(root), chain });
	}
}
