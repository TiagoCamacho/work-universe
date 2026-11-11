import * as vscode from 'vscode';
import { isInside, sameUri } from '../universe/paths';
import { isHexColor } from '../universe/theme';
import { isSafeId } from '../universe/workspaceFile';
import { parseJsonc } from '../ui/util';
import { ActionsFile, CustomAction, DEFAULT_ACTION_ICON } from './types';

export const ACTIONS_FILE_SUFFIX = '.wu-actions.json';

export interface ValidationResult extends ActionsFile {
	errors: string[];
}

const COLOR_HINT = 'must be a hex color like #3fb950';

/** "#abc" / "#aabbcc" → the color; "none" or missing → undefined; anything else → error. */
function readActiveColor(value: unknown, errors: string[]): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'string' && value.trim().toLowerCase() === 'none') {
		return undefined;
	}
	if (typeof value === 'string' && isHexColor(value)) {
		return value.trim();
	}
	errors.push(`"active_color" ${COLOR_HINT} or "none"`);
	return undefined;
}

/** Validates parsed action-file content; invalid entries are skipped with an error message. */
export function validateActions(json: unknown): ValidationResult {
	const errors: string[] = [];
	const root = json as { actions?: unknown; active_color?: unknown } | undefined;
	const active_color = readActiveColor(root?.active_color, errors);
	const list = root?.actions as Record<string, unknown>[] | undefined;
	if (!Array.isArray(list)) {
		return { actions: [], active_color, errors: json === undefined ? [] : [...errors, '"actions" must be an array'] };
	}
	const actions: CustomAction[] = [];
	list.forEach((raw, i) => {
		const where = `actions[${i}]`;
		if (!raw || typeof raw !== 'object') {
			errors.push(`${where}: must be an object`);
			return;
		}
		const label = typeof raw.label === 'string' ? raw.label.trim() : '';
		if (!label) {
			errors.push(`${where}: "label" is required`);
			return;
		}
		const hasCommand = typeof raw.command === 'string' && raw.command.trim() !== '';
		const hasVscode = typeof raw.vscodeCommand === 'string' && raw.vscodeCommand.trim() !== '';
		if (hasCommand === hasVscode) {
			errors.push(`${where} ("${label}"): set exactly one of "command" or "vscodeCommand"`);
			return;
		}
		const action: CustomAction = {
			label,
			icon: typeof raw.icon === 'string' && raw.icon.trim() ? raw.icon.trim() : DEFAULT_ACTION_ICON,
		};
		if (hasCommand) {
			action.command = (raw.command as string).trim();
		} else {
			action.vscodeCommand = (raw.vscodeCommand as string).trim();
			if (raw.args !== undefined) {
				action.args = Array.isArray(raw.args) ? raw.args : [raw.args];
			}
		}
		if (typeof raw.cwd === 'string' && raw.cwd.trim()) {
			action.cwd = raw.cwd.trim();
		}
		if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
			action.env = Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]));
		}
		if (typeof raw.color === 'string') {
			if (isHexColor(raw.color)) {
				action.color = raw.color.trim();
			} else {
				errors.push(`${where} ("${label}"): "color" ${COLOR_HINT}`);
			}
		}
		for (const flag of ['headless', 'show_status_bar'] as const) {
			if (raw[flag] === undefined) {
				continue;
			}
			if (typeof raw[flag] === 'boolean') {
				action[flag] = raw[flag] as boolean;
			} else {
				errors.push(`${where} ("${label}"): "${flag}" must be true or false`);
			}
		}
		actions.push(action);
	});
	return { actions, active_color, errors };
}

/** Initial content of an actions file: a comment documenting every property, then the actions. */
export function actionsFileTemplate(workspaceName: string, actions: CustomAction[]): string {
	const header = [
		`// Work Universe: custom actions for "${workspaceName}"`,
		'// Every entry in "actions" becomes an icon button under the workspace tabs.',
		'// Save this file (Ctrl+S) and the buttons update immediately. Autocomplete: Ctrl+Space.',
		'//',
		'// Top level',
		'//   active_color     Hex color (e.g. "#3fb950") given to the icons of actions that are running.',
		'//                    "none" keeps the normal colors.',
		'//',
		'// Each action',
		'//   label            (required) Name of the action. Shown as the tooltip and as the terminal name.',
		'//   icon             Codicon name, e.g. "play", "beaker", "tools", "rocket". Default: "terminal".',
		"//   command          Shell command to run in the action's own terminal, in the workspace folder.",
		'//   vscodeCommand    A VS Code command id to run instead of a shell command',
		'//                    (e.g. "typescript.restartTsServer"). Use either command or vscodeCommand.',
		'//   args             Arguments passed to vscodeCommand, e.g. ["arg1", 2].',
		'//   cwd              Working directory, relative to the workspace folder (e.g. "packages/api").',
		'//   env              Extra environment variables, e.g. { "PORT": "3000" }.',
		'//   color            Hex color of the icon when idle (e.g. "#d29922").',
		'//   headless         true runs the command without showing its terminal.',
		'//                    Press the button again while it runs to show or restart it.',
		'//   show_status_bar  true shows the icon and label in the status bar while the command runs.',
		'//                    Click it to bring up the terminal.',
	].join('\n');
	const body = actions.map(a => '\t\t' + JSON.stringify(a, null, '\t').split('\n').join('\n\t\t')).join(',\n');
	return `${header}\n{\n\t"active_color": "none",\n\t"actions": [\n${body}\n\t]\n}\n`;
}

/** Per-workspace action files in the extension's storage (never inside the project). */
export class ActionStore implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<string>();
	/** Fires with the workspace id whose actions changed. */
	readonly onDidChange = this._onDidChange.event;
	private readonly disposables: vscode.Disposable[] = [this._onDidChange];
	private readonly cache = new Map<string, ActionsFile>();
	private readonly reported = new Map<string, string>();

	constructor(private readonly storageRoot: vscode.Uri) {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.dir, '*' + ACTIONS_FILE_SUFFIX),
		);
		const changed = (uri: vscode.Uri) => {
			const id = this.idOf(uri);
			if (id) {
				this.cache.delete(id);
				this._onDidChange.fire(id);
			}
		};
		this.disposables.push(
			watcher,
			watcher.onDidChange(changed),
			watcher.onDidCreate(changed),
			watcher.onDidDelete(changed),
			// The watcher may be slow or unavailable outside the workspace; saves are the main signal.
			vscode.workspace.onDidSaveTextDocument(doc => changed(doc.uri)),
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	get dir(): vscode.Uri {
		return vscode.Uri.joinPath(this.storageRoot, 'actions');
	}

	fileFor(workspaceId: string): vscode.Uri {
		if (!isSafeId(workspaceId)) {
			throw new Error('Invalid workspace id.');
		}
		return vscode.Uri.joinPath(this.dir, workspaceId + ACTIONS_FILE_SUFFIX);
	}

	private idOf(uri: vscode.Uri): string | undefined {
		const name = uri.path.split('/').pop() ?? '';
		if (!name.endsWith(ACTIONS_FILE_SUFFIX) || !isInside(uri, this.dir)) {
			return undefined;
		}
		const id = name.slice(0, -ACTIONS_FILE_SUFFIX.length);
		return sameUri(this.fileFor(id), uri) ? id : undefined;
	}

	async exists(workspaceId: string): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(this.fileFor(workspaceId));
			return true;
		} catch {
			return false;
		}
	}

	/** Valid actions + settings of a workspace (empty if there is no file). Problems are shown once per change. */
	async get(workspaceId: string): Promise<ActionsFile> {
		const cached = this.cache.get(workspaceId);
		if (cached) {
			return cached;
		}
		const file = this.fileFor(workspaceId);
		let text: string | undefined;
		try {
			text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
		} catch {
			// no file yet
		}
		let result: ValidationResult = { actions: [], errors: [] };
		if (text !== undefined && text.trim()) {
			try {
				result = validateActions(parseJsonc(text));
			} catch (err) {
				result = { actions: [], errors: [`invalid JSON (${err instanceof Error ? err.message : err})`] };
			}
		}
		const content: ActionsFile = { actions: result.actions, active_color: result.active_color };
		this.cache.set(workspaceId, content);
		this.report(workspaceId, file, result.errors);
		return content;
	}

	private report(workspaceId: string, file: vscode.Uri, errors: string[]): void {
		const summary = errors.join('\n');
		if (this.reported.get(workspaceId) === summary) {
			return;
		}
		this.reported.set(workspaceId, summary);
		if (errors.length) {
			vscode.window
				.showWarningMessage(`Work Universe: some custom actions were skipped. ${errors.slice(0, 3).join('; ')}`, 'Open File')
				.then(choice => choice && vscode.window.showTextDocument(file));
		}
	}

	/** Writes a new, commented actions file. */
	async write(workspaceId: string, workspaceName: string, actions: CustomAction[]): Promise<vscode.Uri> {
		const file = this.fileFor(workspaceId);
		await vscode.workspace.fs.createDirectory(this.dir);
		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(actionsFileTemplate(workspaceName, actions)));
		this.cache.delete(workspaceId);
		this._onDidChange.fire(workspaceId);
		return file;
	}

	async delete(workspaceId: string): Promise<void> {
		try {
			await vscode.workspace.fs.delete(this.fileFor(workspaceId), { useTrash: false });
		} catch {
			// nothing to delete
		}
		this.cache.delete(workspaceId);
		this.reported.delete(workspaceId);
		this._onDidChange.fire(workspaceId);
	}
}
