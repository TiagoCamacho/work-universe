import * as vscode from 'vscode';
import { ActionRunner } from '../actions/actionRunner';
import { ActionStore } from '../actions/actionStore';
import { CustomAction } from '../actions/types';
import { FileTargets } from '../fileCommands';
import { UniverseStore } from '../model/store';
import { Workspace } from '../model/types';
import { logError, markLate } from '../perf';
import { SolutionModel, SolutionRow, solutionRootKey } from '../solution/solutionModel';
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

/** The only commands a message from the webview is allowed to run. */
const WEBVIEW_COMMANDS = new Set(['workUniverse.files.rename', 'workUniverse.files.delete']);

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
	| { type: 'listMany'; items: { key: string; uri: string; root: string; rootKey?: string }[] }
	| { type: 'painted' }
	| { type: 'mode' }
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
		private readonly solutions: SolutionModel,
	) {
		const onState = () => {
			this.syncRoots();
			void this.postState();
		};
		this.disposables.push(
			store.onDidChange(onState),
			switcher.onDidChangeState(onState),
			model.onDidChange(keys => {
				solutions.filesChanged();
				this.post({ type: 'refresh', keys });
			}),
			solutions.onDidChange(() => this.post({ type: 'refresh' })),
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

	/**
	 * Paths arriving from the webview (messages, right-click context) are not trusted as they
	 * are: a path is only used if it lies inside one of this universe's workspaces. The webview
	 * runs only our own script, so this is a second line of defence, in case a bug ever let
	 * something else run in it.
	 */
	private safeUri(value: unknown): vscode.Uri | undefined {
		if (typeof value !== 'string') {
			return undefined;
		}
		let uri: vscode.Uri;
		try {
			uri = vscode.Uri.parse(value, true);
		} catch {
			return undefined;
		}
		if (/(^|\/)\.\.(\/|$)/.test(uri.path)) {
			return undefined; // "…/../…" could climb out of the workspace
		}
		const workspaces = this.switcher.getWindowState().universe?.workspaces ?? [];
		return workspaces.some(w => isInside(uri, w.uri)) || this.solutions.isAllowed(uri) ? uri : undefined;
	}

	fromArg(arg: unknown): FileTarget | undefined {
		const a = arg as { uri?: unknown; root?: unknown; webviewSection?: unknown } | undefined;
		const uri = this.safeUri(a?.uri);
		const root = this.safeUri(a?.root);
		if (!a || !uri || !root) {
			return undefined;
		}
		return {
			uri,
			root,
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
		const active = (state.universe?.workspaces ?? []).filter(w => state.activeIds.includes(w.id));
		const roots = active.map(w => vscode.Uri.parse(w.uri));
		if (this.model.setRoots(roots)) {
			this.selection = [];
		}
		const solutionOf = (w: Workspace) => ({ sln: vscode.Uri.parse(w.solution!), folder: vscode.Uri.parse(w.uri) });
		// Every solution of the universe is known (a tab click asks for its tree before the switch);
		// only the ones on screen are watched.
		this.solutions.track(
			active.filter(w => w.solution).map(solutionOf),
			(state.universe?.workspaces ?? []).filter(w => w.solution).map(solutionOf),
		);
	}

	/** "Open Project File" / "Open Solution File" from the context menu of the solution tree. */
	async openSolutionFile(arg: unknown): Promise<void> {
		const uri = this.safeUri((arg as { file?: unknown } | undefined)?.file);
		if (uri) {
			await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
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
				// A workspace shown as a solution has its own tree, so it gets its own root key.
				key: w.solution ? solutionRootKey(w.solution) : uriKey(uri),
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

	private solutionRow(r: SolutionRow) {
		const themed = !r.ci;
		return {
			...r,
			icon: !themed ? undefined : r.iconOf ? this.icons.fileIcon(r.iconOf) : r.dir ? this.icons.folderIcon(r.name, false) : this.icons.fileIcon(r.name),
			iconOpen: themed && r.dir && !r.iconOf ? this.icons.folderIcon(r.name, true) : undefined,
			iconOf: undefined,
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
				// Folders outside the universe's workspaces are answered with an empty list.
				const items = (Array.isArray(msg.items) ? msg.items : []).slice(0, 2000);
				const lists = await Promise.all(
					items.map(async i => {
						// Nodes of a solution tree are answered by the solution model, from the nodes
						// it handed out itself.
						if (this.solutions.isRoot(i?.rootKey)) {
							try {
								return (await this.solutions.list(String(i.rootKey), String(i.key))).map(r => this.solutionRow(r));
							} catch (err) {
								logError('could not list solution node', err);
								return [];
							}
						}
						if (typeof i?.rootKey === 'string' && i.rootKey.endsWith('#sln')) {
							return []; // a solution that is no longer part of the universe: never list it as a folder
						}
						const uri = this.safeUri(i?.uri);
						const root = this.safeUri(i?.root);
						return uri && root ? (await this.model.list(uri, root)).map(e => this.toRow(e)) : [];
					}),
				);
				const payload = items.map((item, n) => ({ key: String(item?.key), rows: lists[n] }));
				this.ensureIcons(payload.flatMap(l => l.rows.flatMap(r => [r.icon, r.iconOpen])));
				this.post({ type: 'childrenMany', lists: payload });
				break;
			}
			case 'mode':
				await vscode.commands.executeCommand('workUniverse.setUniverseMode');
				break;
			case 'painted':
				markLate('switch', 'panelPainted');
				break;
			case 'open': {
				const uri = this.safeUri(msg.uri);
				if (uri) {
					await vscode.commands.executeCommand('vscode.open', uri, {
						preview: !!msg.preview,
						preserveFocus: !!msg.preview,
					});
				}
				break;
			}
			case 'select':
				this.selection = (Array.isArray(msg.items) ? msg.items : [])
					.map(i => this.toTarget(i))
					.filter((t): t is FileTarget => !!t);
				break;
			case 'command': {
				// The webview may only trigger these two commands, never an arbitrary one.
				if (!WEBVIEW_COMMANDS.has(msg.id)) {
					break;
				}
				const target = msg.target ? this.toTarget(msg.target) : undefined;
				await vscode.commands.executeCommand(
					msg.id,
					target
						? {
								uri: target.uri.toString(),
								root: target.root.toString(),
								webviewSection: target.isRoot ? 'root' : target.isDirectory ? 'folder' : 'file',
							}
						: undefined,
				);
				break;
			}
			case 'runAction': {
				const single = this.switcher.activeWorkspace();
				const action = this.shownActions[msg.index];
				if (single && action) {
					await this.actionRunner.run(single.workspace, action, this.activeColor);
				}
				break;
			}
			case 'move': {
				const sources = (Array.isArray(msg.sources) ? msg.sources : []).map(s => this.safeUri(s));
				const target = this.safeUri(msg.target);
				// All or nothing: one path outside the universe cancels the move.
				if (target && sources.length && sources.every(s => !!s)) {
					await vscode.commands.executeCommand('workUniverse.files.move', sources, target);
				}
				break;
			}
		}
	}

	private toTarget(t: WireTarget): FileTarget | undefined {
		const uri = this.safeUri(t?.uri);
		const root = this.safeUri(t?.root);
		return uri && root ? { uri, root, isDirectory: !!t.dir, isRoot: !!t.isRoot } : undefined;
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
		const state = this.switcher.getWindowState();
		const active = (state.universe?.workspaces ?? []).filter(w => state.activeIds.includes(w.id));
		if (active.some(w => w.solution)) {
			void this.solutions.revealChain(uri).then(
				found => {
					if (found) {
						this.post({ type: 'reveal', key: found.key, rootKey: found.rootKey, chain: found.chain.map(key => ({ key })) });
					} else {
						this.revealInFolders(uri, active.filter(w => !w.solution).map(w => vscode.Uri.parse(w.uri)));
					}
				},
				err => logError('could not reveal in solution', err),
			);
			return;
		}
		this.revealInFolders(uri, this.model.getRoots());
	}

	private revealInFolders(uri: vscode.Uri, roots: readonly vscode.Uri[]): void {
		const root = roots.find(r => isInside(uri, r));
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
