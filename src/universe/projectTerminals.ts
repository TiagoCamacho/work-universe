import * as vscode from 'vscode';
import { waitForShellIntegration } from '../actions/actionRunner';
import { Workspace } from '../model/types';
import { logError } from '../perf';
import { isInside, uriKey } from './paths';
import { Switcher } from './switcher';

export const PROJECT_TERMINAL_PROFILE_ID = 'workUniverse.projectTerminal';

/** Set on every project terminal so it is recognized even after `cd`-ing elsewhere. */
const WORKSPACE_ENV = 'WORK_UNIVERSE_WORKSPACE_ID';
/** One-off marker telling a freshly opened terminal apart from one VS Code revived after a reload. */
const NONCE_ENV = 'WORK_UNIVERSE_TERMINAL_NONCE';

interface Settings {
	followSwitch: boolean;
	autoOpen: boolean;
	hidePanelWhenNone: boolean;
	startupCommand: string;
}

/**
 * Terminals rooted in a project. Every terminal in the window stays in VS Code's one terminal
 * list (extensions can't hide a terminal once it exists), so instead the terminal of the active
 * project is brought to the front on every switch. Nothing is ever closed: whatever runs in another
 * project's terminal (an AI CLI, a dev server) keeps running.
 *
 * A terminal belongs to a project when it was opened as a project terminal, or when it started
 * inside the project's folder (terminals opened by hand and action terminals count too).
 */
export class ProjectTerminals implements vscode.Disposable {
	/** Last terminal used in each workspace, by workspace id. */
	private readonly lastUsed = new Map<string, vscode.Terminal>();
	/** Nonces of terminals opened by this window that still have to run the startup command. */
	private readonly awaitingStartup = new Set<string>();
	/** Workspaces whose terminal you hid; they stay hidden on the way back until you show one again. */
	private readonly hiddenByUser = new Set<string>();
	private lastActiveId?: string;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly switcher: Switcher) {
		this.disposables.push(
			switcher.onDidChangeState(() => this.onStateChanged()),
			vscode.window.onDidChangeActiveTerminal(t => t && this.remember(t)),
			vscode.window.onDidOpenTerminal(t => {
				this.unhide(t);
				this.onOpened(t);
			}),
			// Running something in a terminal means it is in use, so its project shows it again.
			vscode.window.onDidStartTerminalShellExecution(e => this.unhide(e.terminal)),
			vscode.window.onDidCloseTerminal(t => {
				for (const [id, terminal] of this.lastUsed) {
					if (terminal === t) {
						this.lastUsed.delete(id);
					}
				}
			}),
		);
	}

	/** Adds "Project Terminal" to the Terminal panel's + menu (once per extension host). */
	registerProfile(): vscode.Disposable {
		return vscode.window.registerTerminalProfileProvider(PROJECT_TERMINAL_PROFILE_ID, {
			provideTerminalProfile: () => {
				const workspace = this.switcher.activeWorkspace()?.workspace;
				if (!workspace) {
					vscode.window.showWarningMessage('Work Universe: switch to a single workspace to open its project terminal.');
					return undefined;
				}
				return new vscode.TerminalProfile(this.options(workspace));
			},
		});
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	/** Opens a new terminal rooted in `workspace` (the active one by default) and shows it. */
	open(workspace = this.switcher.activeWorkspace()?.workspace, preserveFocus = false): vscode.Terminal | undefined {
		if (!workspace) {
			vscode.window.showWarningMessage('Work Universe: switch to a single workspace to open its project terminal.');
			return undefined;
		}
		const terminal = vscode.window.createTerminal(this.options(workspace));
		this.lastUsed.set(workspace.id, terminal);
		terminal.show(preserveFocus);
		return terminal;
	}

	/**
	 * Runs one of VS Code's own panel/terminal toggles (Ctrl+`, Ctrl+J are bound to this) and
	 * remembers whether you hid or showed the active project's terminal. The keybindings' `when`
	 * clauses know whether the terminal is showing, which extensions can't read themselves.
	 */
	async toggle(command: string, hiding: boolean): Promise<void> {
		const active = this.switcher.activeWorkspace()?.workspace;
		if (active) {
			if (hiding) {
				this.hiddenByUser.add(active.id);
			} else {
				this.hiddenByUser.delete(active.id);
			}
		}
		await vscode.commands.executeCommand(command);
	}

	/** You hid this workspace's terminal, and haven't shown one of its terminals since. */
	isHiddenByUser(workspace: Workspace): boolean {
		return this.hiddenByUser.has(workspace.id);
	}

	/** Visible terminals of `workspace`, oldest first. */
	terminalsOf(workspace: Workspace): vscode.Terminal[] {
		const workspaces = this.switcher.getWindowState().universe?.workspaces ?? [workspace];
		return vscode.window.terminals.filter(t => this.ownerOf(t, workspaces)?.id === workspace.id);
	}

	/** The terminal to bring up for `workspace`: the one used last, else the newest one. */
	terminalFor(workspace: Workspace): vscode.Terminal | undefined {
		const last = this.lastUsed.get(workspace.id);
		if (last && last.exitStatus === undefined && vscode.window.terminals.includes(last)) {
			return last;
		}
		return this.terminalsOf(workspace).at(-1);
	}

	// ---- internals -------------------------------------------------------

	private settings(): Settings {
		const config = vscode.workspace.getConfiguration('workUniverse.projectTerminals');
		return {
			followSwitch: config.get<boolean>('followSwitch', true),
			autoOpen: config.get<boolean>('autoOpen', false),
			hidePanelWhenNone: config.get<boolean>('hidePanelWhenNone', true),
			startupCommand: config.get<string>('startupCommand', '').trim(),
		};
	}

	private options(workspace: Workspace): vscode.TerminalOptions {
		const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
		this.awaitingStartup.add(nonce);
		return {
			name: workspace.name,
			cwd: vscode.Uri.parse(workspace.uri),
			iconPath: new vscode.ThemeIcon(workspace.icon ?? 'terminal'),
			env: { [WORKSPACE_ENV]: workspace.id, [NONCE_ENV]: nonce },
		};
	}

	private onStateChanged(): void {
		const active = this.switcher.activeWorkspace()?.workspace;
		if (!active || active.id === this.lastActiveId) {
			return;
		}
		this.lastActiveId = active.id;
		const settings = this.settings();
		if (!settings.followSwitch) {
			return;
		}
		const terminal = this.hiddenByUser.has(active.id) ? undefined : this.terminalFor(active);
		if (terminal) {
			// Brings the terminal to the front of the panel without taking the keyboard from the editor.
			terminal.show(true);
		} else if (settings.autoOpen && !this.hiddenByUser.has(active.id)) {
			this.open(active, true);
		} else if (settings.hidePanelWhenNone && this.showsOtherProject(active)) {
			// Extensions can't hide a single terminal, so the panel goes. Already closed: a no-op.
			void vscode.commands.executeCommand('workbench.action.closePanel');
		}
	}

	/** The terminal in front belongs to a project other than `workspace`. */
	private showsOtherProject(workspace: Workspace): boolean {
		const front = vscode.window.activeTerminal;
		const owner = front && this.ownerOf(front, this.switcher.getWindowState().universe?.workspaces ?? []);
		return !!owner && owner.id !== workspace.id;
	}

	private remember(terminal: vscode.Terminal): void {
		const owner = this.ownerOf(terminal, this.switcher.getWindowState().universe?.workspaces ?? []);
		if (owner) {
			this.lastUsed.set(owner.id, terminal);
			this.hiddenByUser.delete(owner.id);
		}
	}

	private unhide(terminal: vscode.Terminal): void {
		const owner = this.ownerOf(terminal, this.switcher.getWindowState().universe?.workspaces ?? []);
		if (owner) {
			this.hiddenByUser.delete(owner.id);
		}
	}

	/** Runs the startup command in project terminals this window just opened (not revived ones). */
	private onOpened(terminal: vscode.Terminal): void {
		const nonce = envOf(terminal)?.[NONCE_ENV];
		if (!nonce || !this.awaitingStartup.delete(nonce)) {
			return;
		}
		const { startupCommand } = this.settings();
		if (!startupCommand) {
			return;
		}
		void (async () => {
			const integration = terminal.shellIntegration ?? (await waitForShellIntegration(terminal));
			if (terminal.exitStatus !== undefined) {
				return;
			}
			if (integration) {
				integration.executeCommand(startupCommand);
			} else {
				terminal.sendText(startupCommand, true);
			}
		})().catch(err => logError('running the project terminal startup command failed', err));
	}

	/** The workspace a terminal belongs to, if any. Hidden (headless) terminals belong to none. */
	private ownerOf(terminal: vscode.Terminal, workspaces: readonly Workspace[]): Workspace | undefined {
		const options = terminal.creationOptions as vscode.TerminalOptions;
		if (options.hideFromUser || terminal.exitStatus !== undefined) {
			return undefined;
		}
		const tagged = envOf(terminal)?.[WORKSPACE_ENV];
		const byTag = tagged ? workspaces.find(w => w.id === tagged) : undefined;
		if (byTag) {
			return byTag;
		}
		const cwd = cwdOf(terminal);
		if (!cwd) {
			return undefined;
		}
		// The deepest folder wins, in case one project lives inside another.
		return workspaces
			.filter(w => isInside(cwd, w.uri))
			.sort((a, b) => uriKey(b.uri).length - uriKey(a.uri).length)[0];
	}
}

function envOf(terminal: vscode.Terminal): { [key: string]: string | null | undefined } | undefined {
	return (terminal.creationOptions as vscode.TerminalOptions).env;
}

/** Where a terminal started; falls back to the shell's current folder (shell integration). */
function cwdOf(terminal: vscode.Terminal): vscode.Uri | undefined {
	const cwd = (terminal.creationOptions as vscode.TerminalOptions).cwd;
	if (cwd) {
		return typeof cwd === 'string' ? vscode.Uri.file(cwd) : cwd;
	}
	return terminal.shellIntegration?.cwd;
}
