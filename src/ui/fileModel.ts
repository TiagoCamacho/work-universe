import * as path from 'path';
import * as vscode from 'vscode';
import { sameUri, uriKey } from '../universe/paths';
import { compileExcludes, isExcluded } from './glob';

export interface FileEntry {
	uri: vscode.Uri;
	name: string;
	isDirectory: boolean;
}

/** A file or folder the file commands act on. */
export interface FileTarget {
	uri: vscode.Uri;
	isDirectory: boolean;
	/** Workspace folder the target belongs to. */
	root: vscode.Uri;
	isRoot?: boolean;
}

const REFRESH_DEBOUNCE_MS = 150;
/** Above this many changed folders in one burst (e.g. `npm install`), refresh everything instead. */
const MAX_DIRTY_FOLDERS = 200;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Lists directories (respecting `files.exclude`) and watches the roots for created/deleted files. */
export class FileModel implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<string[] | undefined>();
	/**
	 * Fires with the keys (`uriKey`) of the folders whose content changed, or `undefined` when
	 * everything should be re-read.
	 */
	readonly onDidChange = this._onDidChange.event;
	private readonly disposables: vscode.Disposable[] = [this._onDidChange];
	private watchers: vscode.Disposable[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private roots: vscode.Uri[] = [];
	/** Folders changed since the last event; `undefined` means "all of them". */
	private dirty: Set<string> | undefined = new Set();
	/** Compiled `files.exclude` per root; cleared when the configuration changes. */
	private readonly excludes = new Map<string, RegExp[]>();

	constructor() {
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('files.exclude') || e.affectsConfiguration('workUniverse.showExcludedFiles')) {
					this.excludes.clear();
					this.changed();
				}
			}),
			// Folder settings can differ per root, and roots come and go on every switch.
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.excludes.clear()),
		);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.watchers.forEach(w => w.dispose());
		this.disposables.forEach(d => d.dispose());
	}

	getRoots(): readonly vscode.Uri[] {
		return this.roots;
	}

	/** Returns true if the roots actually changed. */
	setRoots(roots: vscode.Uri[]): boolean {
		if (roots.length === this.roots.length && roots.every((r, i) => sameUri(r, this.roots[i]))) {
			return false;
		}
		this.roots = roots;
		this.watchers.forEach(w => w.dispose());
		this.watchers = roots.map(root => {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'), false, true, false);
			const onEvent = (uri: vscode.Uri) => this.changed(vscode.Uri.joinPath(uri, '..'));
			watcher.onDidCreate(onEvent);
			watcher.onDidDelete(onEvent);
			return watcher;
		});
		return true;
	}

	/**
	 * Debounced change notification. With a folder, only that folder is reported; without one,
	 * everything is (also used after our own file operations).
	 */
	changed(folder?: vscode.Uri): void {
		if (!folder) {
			this.dirty = undefined;
		} else if (this.dirty) {
			this.dirty.add(uriKey(folder));
			if (this.dirty.size > MAX_DIRTY_FOLDERS) {
				this.dirty = undefined;
			}
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			const keys = this.dirty ? [...this.dirty] : undefined;
			this.dirty = new Set();
			this._onDidChange.fire(keys);
		}, REFRESH_DEBOUNCE_MS);
	}

	private excludesFor(root: vscode.Uri): RegExp[] {
		const key = uriKey(root);
		let compiled = this.excludes.get(key);
		if (!compiled) {
			const showExcluded = vscode.workspace.getConfiguration('workUniverse').get<boolean>('showExcludedFiles', false);
			compiled = showExcluded
				? []
				: compileExcludes(vscode.workspace.getConfiguration('files', root).get<Record<string, unknown>>('exclude'));
			this.excludes.set(key, compiled);
		}
		return compiled;
	}

	async list(dir: vscode.Uri, root: vscode.Uri): Promise<FileEntry[]> {
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			return [];
		}
		const excludes = this.excludesFor(root);
		const base = path.posix.relative(root.path, dir.path);
		const result: FileEntry[] = [];
		for (const [name, type] of entries) {
			if (excludes.length && isExcluded(base ? `${base}/${name}` : name, excludes)) {
				continue;
			}
			result.push({ uri: vscode.Uri.joinPath(dir, name), name, isDirectory: (type & vscode.FileType.Directory) !== 0 });
		}
		return result.sort((a, b) =>
			a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : collator.compare(a.name, b.name),
		);
	}

	/** Lists several folders at once, in parallel. */
	listMany(dirs: { uri: vscode.Uri; root: vscode.Uri }[]): Promise<FileEntry[][]> {
		return Promise.all(dirs.map(d => this.list(d.uri, d.root)));
	}
}
