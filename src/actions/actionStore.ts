import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { Workspace } from '../model/types';
import { isInside, sameUri, uriKey } from '../universe/paths';
import { isHexColor } from '../universe/theme';
import { isSafeId } from '../universe/workspaceFile';
import { parseJsonc } from '../ui/util';
import { ActionsFile, CustomAction, DEFAULT_ACTION_ICON } from './types';

export const ACTIONS_FILE_SUFFIX = '.wu-actions.json';
/** Optional actions file inside a project, relative to its folder. When present it replaces the stored actions. */
export const PROJECT_ACTIONS_FILE = '.vscode/work-universe.json';

/** Where a project's actions come from. */
export type ActionsSource = 'project' | 'stored';

/** The project folder of a `<folder>/.vscode/work-universe.json` uri, or undefined for any other uri. */
export function folderOfProjectFile(uri: vscode.Uri): vscode.Uri | undefined {
	const parts = uri.path.split('/');
	if (parts.length < 3 || parts.at(-1)?.toLowerCase() !== 'work-universe.json' || parts.at(-2)?.toLowerCase() !== '.vscode') {
		return undefined;
	}
	return uri.with({ path: parts.slice(0, -2).join('/') || '/' });
}

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

/** What an actions file belongs to: a project folder (the id only finds files written by older versions). */
export type ActionsOwner = Pick<Workspace, 'id' | 'uri'>;

/**
 * Stable file key of a project folder: the same folder always gets the same actions,
 * also after it is removed and added again, or when it is in more than one universe.
 */
export function actionsKey(owner: Pick<Workspace, 'uri'>): string {
	return createHash('sha256').update(uriKey(owner.uri)).digest('hex').slice(0, 32);
}

/** A project's actions, plus the file they were read from. */
export interface ResolvedActions extends ActionsFile {
	source: ActionsSource;
	file: vscode.Uri;
}

/**
 * Per-project-folder actions. They are kept in the extension's storage, unless the project has its
 * own `.vscode/work-universe.json`: that file then replaces them completely (only in a trusted window,
 * since a file that comes with a repository decides what the buttons run).
 */
export class ActionStore implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<string>();
	/** Fires with the key ({@link actionsKey}) of the folder whose actions changed. */
	readonly onDidChange = this._onDidChange.event;
	private readonly disposables: vscode.Disposable[] = [this._onDidChange];
	private readonly cache = new Map<string, ResolvedActions>();
	private readonly reported = new Map<string, string>();
	/** One watcher per project folder whose actions were read, for its `.vscode/work-universe.json`. */
	private readonly projectWatchers = new Map<string, vscode.Disposable>();
	private untrustedNoticeShown = false;

	constructor(private readonly storageRoot: vscode.Uri) {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.dir, '*' + ACTIONS_FILE_SUFFIX),
		);
		this.disposables.push(
			watcher,
			watcher.onDidChange(uri => this.changed(uri)),
			watcher.onDidCreate(uri => this.changed(uri)),
			watcher.onDidDelete(uri => this.changed(uri)),
			// The watcher may be slow or unavailable outside the workspace; saves are the main signal.
			vscode.workspace.onDidSaveTextDocument(doc => this.changed(doc.uri)),
			// Project files are only read in a trusted window, so granting trust can change every project's buttons.
			vscode.workspace.onDidGrantWorkspaceTrust(() => {
				for (const key of [...this.cache.keys()]) {
					this.invalidate(key);
				}
			}),
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.projectWatchers.forEach(d => d.dispose());
		this.projectWatchers.clear();
	}

	private changed(uri: vscode.Uri): void {
		const folder = folderOfProjectFile(uri);
		const key = folder ? actionsKey({ uri: folder.toString() }) : this.keyOf(uri);
		if (key) {
			this.invalidate(key);
		}
	}

	private invalidate(key: string): void {
		this.cache.delete(key);
		this._onDidChange.fire(key);
	}

	/** `<folder>/.vscode/work-universe.json` of a project (whether or not it exists). */
	projectFileFor(owner: Pick<Workspace, 'uri'>): vscode.Uri {
		return vscode.Uri.joinPath(vscode.Uri.parse(owner.uri), PROJECT_ACTIONS_FILE);
	}

	private watchProject(key: string, owner: Pick<Workspace, 'uri'>): void {
		if (this.projectWatchers.has(key)) {
			return;
		}
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.parse(owner.uri), PROJECT_ACTIONS_FILE),
		);
		const changed = () => this.invalidate(key);
		this.projectWatchers.set(
			key,
			vscode.Disposable.from(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed)),
		);
	}

	/**
	 * The file a project's actions are read from: its `.vscode/work-universe.json` when that exists
	 * and the window is trusted, else the file in the extension's storage.
	 */
	async sourceOf(owner: Pick<Workspace, 'uri'>): Promise<{ source: ActionsSource; file: vscode.Uri; ignoredProjectFile?: vscode.Uri }> {
		const projectFile = this.projectFileFor(owner);
		const stored = { source: 'stored' as const, file: this.fileFor(owner) };
		if (!(await this.isFile(projectFile))) {
			return stored;
		}
		return vscode.workspace.isTrusted ? { source: 'project', file: projectFile } : { ...stored, ignoredProjectFile: projectFile };
	}

	get dir(): vscode.Uri {
		return vscode.Uri.joinPath(this.storageRoot, 'actions');
	}

	fileFor(owner: Pick<Workspace, 'uri'>): vscode.Uri {
		return this.fileOfKey(actionsKey(owner));
	}

	private fileOfKey(key: string): vscode.Uri {
		if (!isSafeId(key)) {
			throw new Error('Invalid actions file key.');
		}
		return vscode.Uri.joinPath(this.dir, key + ACTIONS_FILE_SUFFIX);
	}

	private keyOf(uri: vscode.Uri): string | undefined {
		const name = uri.path.split('/').pop() ?? '';
		if (!name.endsWith(ACTIONS_FILE_SUFFIX) || !isInside(uri, this.dir)) {
			return undefined;
		}
		const key = name.slice(0, -ACTIONS_FILE_SUFFIX.length);
		return isSafeId(key) && sameUri(this.fileOfKey(key), uri) ? key : undefined;
	}

	/**
	 * Up to 0.0.5 the file was named after the workspace's random id, which changes when a folder
	 * is removed and added again. Renames such files to the folder's key; an existing folder file wins.
	 */
	async migrate(owners: readonly ActionsOwner[]): Promise<void> {
		for (const owner of owners) {
			if (!isSafeId(owner.id)) {
				continue;
			}
			const legacy = this.fileOfKey(owner.id);
			const key = actionsKey(owner);
			const target = this.fileOfKey(key);
			if (sameUri(legacy, target) || !(await this.isFile(legacy)) || (await this.isFile(target))) {
				continue;
			}
			try {
				await vscode.workspace.fs.rename(legacy, target, { overwrite: false });
				this.cache.delete(key);
				this._onDidChange.fire(key);
			} catch {
				// left as it is; tried again on the next activation
			}
		}
	}

	private async isFile(file: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(file);
			return true;
		} catch {
			return false;
		}
	}

	/** True if the project has actions in the extension's storage (its project file is not looked at). */
	exists(owner: Pick<Workspace, 'uri'>): Promise<boolean> {
		return this.isFile(this.fileFor(owner));
	}

	/**
	 * Valid actions + settings of a project folder (empty if there is no file), from its project
	 * file if it has one. Problems are shown once per change.
	 */
	async get(owner: Pick<Workspace, 'uri'>): Promise<ResolvedActions> {
		const key = actionsKey(owner);
		const cached = this.cache.get(key);
		if (cached) {
			return cached;
		}
		this.watchProject(key, owner);
		const { source, file, ignoredProjectFile } = await this.sourceOf(owner);
		if (ignoredProjectFile) {
			this.noticeUntrusted(ignoredProjectFile);
		}
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
		const content: ResolvedActions = { actions: result.actions, active_color: result.active_color, source, file };
		this.cache.set(key, content);
		this.report(key, file, result.errors);
		return content;
	}

	private noticeUntrusted(file: vscode.Uri): void {
		if (this.untrustedNoticeShown) {
			return;
		}
		this.untrustedNoticeShown = true;
		vscode.window
			.showInformationMessage(
				`Work Universe: ${vscode.workspace.asRelativePath(file)} is ignored until you trust this window, because it decides what the action buttons run.`,
				'Manage Trust',
			)
			.then(choice => choice && vscode.commands.executeCommand('workbench.trust.manage'));
	}

	private report(key: string, file: vscode.Uri, errors: string[]): void {
		const summary = errors.join('\n');
		if (this.reported.get(key) === summary) {
			return;
		}
		this.reported.set(key, summary);
		if (errors.length) {
			vscode.window
				.showWarningMessage(`Work Universe: some custom actions were skipped. ${errors.slice(0, 3).join('; ')}`, 'Open File')
				.then(choice => choice && vscode.window.showTextDocument(file));
		}
	}

	/** Writes a new, commented actions file in the extension's storage, or in the project with `toProject`. */
	async write(owner: Pick<Workspace, 'uri'>, workspaceName: string, actions: CustomAction[], toProject = false): Promise<vscode.Uri> {
		const key = actionsKey(owner);
		const file = toProject ? this.projectFileFor(owner) : this.fileOfKey(key);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'));
		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(actionsFileTemplate(workspaceName, actions)));
		this.invalidate(key);
		return file;
	}

	/** Deletes the actions kept in the extension's storage. A project file is never deleted. */
	async delete(owner: Pick<Workspace, 'uri'>): Promise<void> {
		const key = actionsKey(owner);
		try {
			await vscode.workspace.fs.delete(this.fileOfKey(key), { useTrash: false });
		} catch {
			// nothing to delete
		}
		this.cache.delete(key);
		this.reported.delete(key);
		this._onDidChange.fire(key);
	}
}
