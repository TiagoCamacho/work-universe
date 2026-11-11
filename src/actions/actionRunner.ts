import * as path from 'path';
import * as vscode from 'vscode';
import { Workspace } from '../model/types';
import { CustomAction } from './types';

interface Entry {
	key: string;
	terminal: vscode.Terminal;
	workspace: Workspace;
	action: CustomAction;
	activeColor?: string;
	statusItem?: vscode.StatusBarItem;
}

/** How long to wait for shell integration before falling back to `sendText`. */
const SHELL_INTEGRATION_TIMEOUT_MS = 3000;

/**
 * Runs custom actions: VS Code commands directly, shell commands in one terminal per action.
 * Tracks which actions are running (via shell integration) so the UI can color them and show
 * optional status bar items.
 */
export class ActionRunner implements vscode.Disposable {
	private readonly entries = new Map<string, Entry>();
	private readonly running = new Set<string>();
	private readonly _onDidChangeRunning = new vscode.EventEmitter<void>();
	readonly onDidChangeRunning = this._onDidChangeRunning.event;
	private readonly disposables: vscode.Disposable[] = [this._onDidChangeRunning];

	constructor() {
		this.disposables.push(
			vscode.window.onDidCloseTerminal(t => {
				const entry = this.entryOf(t);
				if (entry) {
					this.entries.delete(entry.key);
					this.setRunning(entry, false);
				}
			}),
			vscode.window.onDidStartTerminalShellExecution(e => {
				const entry = this.entryOf(e.terminal);
				if (entry) {
					this.setRunning(entry, true);
				}
			}),
			vscode.window.onDidEndTerminalShellExecution(e => {
				const entry = this.entryOf(e.terminal);
				if (entry) {
					this.setRunning(entry, false);
				}
			}),
		);
	}

	dispose(): void {
		for (const entry of this.entries.values()) {
			entry.statusItem?.dispose();
		}
		this.disposables.forEach(d => d.dispose());
	}

	static terminalName(workspace: Workspace, action: CustomAction): string {
		return `${workspace.name}: ${action.label}`;
	}

	static key(workspaceId: string, label: string): string {
		return workspaceId + '\u0000' + label;
	}

	/** The terminal currently owned by an action, if any. */
	terminalFor(workspace: Workspace, action: CustomAction): vscode.Terminal | undefined {
		return this.entries.get(ActionRunner.key(workspace.id, action.label))?.terminal;
	}

	isRunning(workspaceId: string, label: string): boolean {
		return this.running.has(ActionRunner.key(workspaceId, label));
	}

	/** Brings up the terminal of a running action (status bar click). */
	showTerminal(key: string): void {
		this.entries.get(key)?.terminal.show();
	}

	async run(workspace: Workspace, action: CustomAction, activeColor?: string): Promise<void> {
		try {
			if (action.vscodeCommand) {
				await vscode.commands.executeCommand(action.vscodeCommand, ...(action.args ?? []));
				return;
			}
			if (action.command) {
				await this.runShell(workspace, action, activeColor);
			}
		} catch (err) {
			vscode.window.showErrorMessage(
				`Work Universe: action "${action.label}" failed: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	private entryOf(terminal: vscode.Terminal): Entry | undefined {
		for (const entry of this.entries.values()) {
			if (entry.terminal === terminal) {
				return entry;
			}
		}
		return undefined;
	}

	private async runShell(workspace: Workspace, action: CustomAction, activeColor?: string): Promise<void> {
		const key = ActionRunner.key(workspace.id, action.label);
		let entry = this.entries.get(key);
		if (entry && entry.terminal.exitStatus !== undefined) {
			entry = undefined;
		}

		if (entry && this.running.has(key)) {
			const choice = await vscode.window.showQuickPick(
				[
					{ label: '$(debug-restart) Restart', description: 'Stop the running command and run it again', value: 'restart' },
					{ label: '$(terminal) Show terminal', value: 'show' },
					{ label: '$(debug-stop) Stop', description: 'Close its terminal', value: 'stop' },
				],
				{ placeHolder: `"${action.label}" is running` },
			);
			if (!choice) {
				return;
			}
			if (choice.value === 'show') {
				entry.terminal.show();
				return;
			}
			entry.terminal.dispose();
			this.entries.delete(key);
			this.setRunning(entry, false);
			if (choice.value === 'stop') {
				return;
			}
			entry = undefined;
		}

		if (!entry) {
			const terminal = vscode.window.createTerminal({
				name: ActionRunner.terminalName(workspace, action),
				cwd: this.cwd(workspace, action),
				env: action.env,
				iconPath: new vscode.ThemeIcon(action.icon),
				hideFromUser: !!action.headless,
			});
			entry = { key, terminal, workspace, action, activeColor };
			this.entries.set(key, entry);
		} else {
			entry.action = action;
			entry.workspace = workspace;
			entry.activeColor = activeColor;
		}

		if (!action.headless) {
			entry.terminal.show(true);
		}
		this.setRunning(entry, true);
		await this.execute(entry.terminal, action.command!);
	}

	/** Prefers shell integration (gives reliable start/end events); falls back to `sendText`. */
	private async execute(terminal: vscode.Terminal, command: string): Promise<void> {
		const integration = terminal.shellIntegration ?? (await waitForShellIntegration(terminal));
		if (integration) {
			integration.executeCommand(command);
		} else {
			terminal.sendText(command, true);
		}
	}

	private setRunning(entry: Entry, running: boolean): void {
		const changed = running ? !this.running.has(entry.key) : this.running.has(entry.key);
		if (running) {
			this.running.add(entry.key);
		} else {
			this.running.delete(entry.key);
		}
		this.updateStatusItem(entry, running);
		if (changed) {
			this._onDidChangeRunning.fire();
		}
	}

	private updateStatusItem(entry: Entry, running: boolean): void {
		if (!running || !entry.action.show_status_bar) {
			entry.statusItem?.dispose();
			entry.statusItem = undefined;
			return;
		}
		const item = (entry.statusItem ??= vscode.window.createStatusBarItem(
			'workUniverse.action.' + entry.key,
			vscode.StatusBarAlignment.Left,
			99,
		));
		item.name = `Work Universe: ${entry.action.label}`;
		item.text = `$(${entry.action.icon}) ${entry.action.label}`;
		item.tooltip = `${entry.action.label} is running in ${entry.workspace.name}. Click to show its terminal.`;
		item.color = entry.activeColor;
		item.command = { command: 'workUniverse.showActionTerminal', title: 'Show terminal', arguments: [entry.key] };
		item.show();
	}

	private cwd(workspace: Workspace, action: CustomAction): vscode.Uri {
		const root = vscode.Uri.parse(workspace.uri);
		if (!action.cwd) {
			return root;
		}
		return path.isAbsolute(action.cwd) ? vscode.Uri.file(action.cwd) : vscode.Uri.joinPath(root, action.cwd);
	}
}

function waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			listener.dispose();
			resolve(undefined);
		}, SHELL_INTEGRATION_TIMEOUT_MS);
		const listener = vscode.window.onDidChangeTerminalShellIntegration(e => {
			if (e.terminal === terminal) {
				clearTimeout(timer);
				listener.dispose();
				resolve(e.shellIntegration);
			}
		});
	});
}
