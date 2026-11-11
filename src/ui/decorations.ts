import * as vscode from 'vscode';
import { isInside, uriKey } from '../universe/paths';

export interface Decoration {
	/** Short badge shown on the right, e.g. `M`, `U`, `2`. */
	badge?: string;
	/** CSS color, e.g. `var(--vscode-gitDecoration-modifiedResourceForeground)`. */
	color?: string;
	tooltip?: string;
	faded?: boolean;
}

// Subset of the built-in git extension API (extensions/git/src/api/git.d.ts).
interface GitChange {
	uri: vscode.Uri;
	status: number;
}
interface GitRepository {
	state: {
		workingTreeChanges: GitChange[];
		indexChanges: GitChange[];
		mergeChanges: GitChange[];
		untrackedChanges?: GitChange[];
		onDidChange: vscode.Event<void>;
	};
}
interface GitApi {
	repositories: GitRepository[];
	onDidOpenRepository: vscode.Event<GitRepository>;
	onDidCloseRepository: vscode.Event<GitRepository>;
}

const color = (name: string) => `var(--vscode-${name.replace(/\./g, '-')})`;

type GitStyle = { badge: string; color: string; label: string; priority: number; faded?: boolean };

function gitStyle(status: number): GitStyle | undefined {
	switch (status) {
		case 0: // INDEX_MODIFIED
		case 5: // MODIFIED
		case 11: // TYPE_CHANGED
			return { badge: 'M', color: color('gitDecoration.modifiedResourceForeground'), label: 'Modified', priority: 3 };
		case 1: // INDEX_ADDED
		case 4: // INDEX_COPIED
		case 9: // INTENT_TO_ADD
			return { badge: 'A', color: color('gitDecoration.addedResourceForeground'), label: 'Added', priority: 2 };
		case 2: // INDEX_DELETED
		case 6: // DELETED
			return { badge: 'D', color: color('gitDecoration.deletedResourceForeground'), label: 'Deleted', priority: 2 };
		case 3: // INDEX_RENAMED
		case 10: // INTENT_TO_RENAME
			return { badge: 'R', color: color('gitDecoration.renamedResourceForeground'), label: 'Renamed', priority: 2 };
		case 7: // UNTRACKED
			return { badge: 'U', color: color('gitDecoration.untrackedResourceForeground'), label: 'Untracked', priority: 1 };
		case 8: // IGNORED
			return { badge: '', color: color('gitDecoration.ignoredResourceForeground'), label: 'Ignored', priority: 0, faded: true };
		default:
			if (status >= 12 && status <= 18) {
				return { badge: '!', color: color('gitDecoration.conflictingResourceForeground'), label: 'Conflict', priority: 5 };
			}
			return undefined;
	}
}

const DEBOUNCE_MS = 200;

/**
 * Explorer-like decorations for the webview tree: git status (via the built-in git extension)
 * and problems (diagnostics). Folders containing decorated files get their color and a dot.
 */
export class DecorationSource implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private readonly disposables: vscode.Disposable[] = [this._onDidChange];
	private readonly repoListeners = new Map<GitRepository, vscode.Disposable>();
	private git?: GitApi;
	private timer?: ReturnType<typeof setTimeout>;

	constructor() {
		this.disposables.push(vscode.languages.onDidChangeDiagnostics(() => this.schedule()));
		this.initGit();
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.repoListeners.forEach(d => d.dispose());
		this.disposables.forEach(d => d.dispose());
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this._onDidChange.fire(), DEBOUNCE_MS);
	}

	private async initGit(): Promise<void> {
		try {
			const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
			if (!ext) {
				return;
			}
			const exports = ext.isActive ? ext.exports : await ext.activate();
			this.git = exports.getAPI(1);
			const watch = (repo: GitRepository) => {
				if (!this.repoListeners.has(repo)) {
					this.repoListeners.set(repo, repo.state.onDidChange(() => this.schedule()));
				}
			};
			this.git.repositories.forEach(watch);
			this.disposables.push(
				this.git.onDidOpenRepository(repo => {
					watch(repo);
					this.schedule();
				}),
				this.git.onDidCloseRepository(repo => {
					this.repoListeners.get(repo)?.dispose();
					this.repoListeners.delete(repo);
					this.schedule();
				}),
			);
			this.schedule();
		} catch (err) {
			console.warn('[work-universe] git decorations unavailable', err);
		}
	}

	/** Decorations keyed by `uriKey`, for everything inside `roots`. */
	compute(roots: readonly vscode.Uri[]): Record<string, Decoration> {
		const files = new Map<string, { uri: vscode.Uri; git?: GitStyle; errors: number; warnings: number }>();
		const entry = (uri: vscode.Uri) => {
			const key = uriKey(uri);
			let e = files.get(key);
			if (!e) {
				e = { uri, errors: 0, warnings: 0 };
				files.set(key, e);
			}
			return e;
		};
		const inRoots = (uri: vscode.Uri) => roots.some(r => isInside(uri, r));

		for (const repo of this.git?.repositories ?? []) {
			const s = repo.state;
			// Later lists win: index < working tree < merge conflicts.
			for (const list of [s.indexChanges, s.untrackedChanges ?? [], s.workingTreeChanges, s.mergeChanges]) {
				for (const change of list) {
					const style = gitStyle(change.status);
					if (style && inRoots(change.uri)) {
						const e = entry(change.uri);
						if (!e.git || style.priority >= e.git.priority) {
							e.git = style;
						}
					}
				}
			}
		}
		for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
			if (!inRoots(uri)) {
				continue;
			}
			const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
			const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
			if (errors || warnings) {
				const e = entry(uri);
				e.errors = errors;
				e.warnings = warnings;
			}
		}

		const result: Record<string, Decoration> = {};
		const folderPriority = new Map<string, number>();
		for (const [key, e] of files) {
			const problemColor = e.errors
				? color('list.errorForeground')
				: e.warnings
					? color('list.warningForeground')
					: undefined;
			const count = e.errors || e.warnings;
			const badge = [count ? String(count) : '', e.git?.badge ?? ''].filter(Boolean).join(', ');
			const tooltip = [
				e.errors ? `${e.errors} error${e.errors > 1 ? 's' : ''}` : '',
				e.warnings ? `${e.warnings} warning${e.warnings > 1 ? 's' : ''}` : '',
				e.git?.label ?? '',
			]
				.filter(Boolean)
				.join(', ');
			result[key] = { badge, color: problemColor ?? e.git?.color, tooltip, faded: e.git?.faded };

			// Propagate a color + dot to parent folders (up to the workspace root), like the Explorer.
			if (e.git?.faded) {
				continue;
			}
			const priority = e.errors ? 10 : e.warnings ? 9 : e.git?.priority ?? 0;
			const folderColor = problemColor ?? e.git?.color;
			const root = roots.find(r => isInside(e.uri, r));
			let parent = vscode.Uri.joinPath(e.uri, '..');
			while (root && isInside(parent, root) && uriKey(parent) !== uriKey(root)) {
				const pk = uriKey(parent);
				if ((folderPriority.get(pk) ?? -1) < priority) {
					folderPriority.set(pk, priority);
					result[pk] = { badge: '•', color: folderColor, tooltip: 'Contains changed or problem files' };
				}
				parent = vscode.Uri.joinPath(parent, '..');
			}
		}
		return result;
	}
}
