import * as path from 'path';
import * as vscode from 'vscode';
import { logError } from '../perf';
import { isInside, uriKey } from '../universe/paths';
import { FileModel } from '../ui/fileModel';
import { globToRegExp } from '../ui/glob';
import { conventionalParent, ParsedProject, parseProject, parseSolution, SolutionEntry } from './parse';

/**
 * A row of the Solution Explorer tree, as sent to the webview. Real files and folders are keyed
 * by `uriKey` (so git decorations, reveal and file-watcher refreshes work as in the folder view);
 * nodes that only exist in the solution (solution folders, projects, dependencies) have keys
 * starting with the solution's root key.
 */
export interface SolutionRow {
	key: string;
	uri: string;
	name: string;
	dir: boolean;
	/** File name to take the icon theme's icon from (e.g. the .csproj for a project). */
	iconOf?: string;
	/** Codicon that always replaces the theme icon. */
	ci?: string;
	/** Codicon used when there is no file icon theme. */
	fb?: string;
	/** A file that has other files nested under it. */
	nest?: boolean;
	/** Not a file or folder on disk: can't be selected for file operations, dragged or opened. */
	virt?: boolean;
	/** Context menu section (`webviewSection`). */
	section?: string;
	/** Project or solution file, for "Open Project File". */
	file?: string;
	/** Folder key whose file-watcher refresh also refreshes this node. */
	alias?: string;
	/** Folder that files dropped on this node go to. */
	drop?: string;
	/** Expanded the first time it appears. */
	open?: boolean;
	desc?: string;
	/** Extra tooltip text, e.g. why a project is unavailable. */
	tip?: string;
	faded?: boolean;
}

type Desc =
	| { k: 'folder'; id: string }
	| { k: 'project'; id: string }
	| { k: 'deps'; id: string }
	| { k: 'group'; id: string; group: string }
	| { k: 'dir'; id: string; rel: string }
	| { k: 'nest'; id: string; rel: string; name: string };

interface Shown {
	name: string;
	uri: vscode.Uri;
	dir: boolean;
}

interface LoadedProject {
	entry: SolutionEntry;
	file: vscode.Uri;
	dir: vscode.Uri;
	info?: ParsedProject;
	/** Files are listed from disk (SDK-style) rather than only from the project's items. */
	globbing: boolean;
	/** Items shown at a place set by the project file, keyed by lower-case display folder. */
	explicit: Map<string, Map<string, Shown>>;
	/** Lower-case relative paths explicitly included (they win over `Remove`). */
	included: Set<string>;
	/** Lower-case display path -> lower-case name of the file it is nested under. */
	dependent: Map<string, string>;
	removes: Map<string, RegExp[]>;
	isWeb: boolean;
}

interface LoadedSolution {
	sln: vscode.Uri;
	dir: vscode.Uri;
	name: string;
	entries: SolutionEntry[];
	byId: Map<string, SolutionEntry>;
	projects: Map<string, LoadedProject>;
	/** Why a project could not be loaded, by entry id. */
	failures: Map<string, string>;
}

interface Tracked {
	sln: vscode.Uri;
	folder: vscode.Uri;
	watcher: vscode.Disposable;
}

interface DirState {
	top: Shown[];
	/** lower-case parent name -> nested files. */
	nested: Map<string, Shown[]>;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const PROJECT_FILES = '{sln,slnx,csproj,vbproj,fsproj,vcxproj,vcxitems,shproj,projitems,sqlproj,njsproj,pyproj,esproj,props,targets}';
const SPECIAL_FOLDERS = ['properties', 'my project', 'wwwroot'];
const RELOAD_DEBOUNCE_MS = 300;

/** Key of the tree root of a workspace shown as a solution. */
export function solutionRootKey(sln: vscode.Uri | string): string {
	return uriKey(sln) + '#sln';
}

/** Solution files in `folder` and its sub-folders, up to `depth` levels down. */
export async function findSolutionFiles(folder: vscode.Uri, depth = 2): Promise<vscode.Uri[]> {
	const found: vscode.Uri[] = [];
	const skip = /^(\.|node_modules$|bin$|obj$|packages$)/i;
	const walk = async (dir: vscode.Uri, level: number) => {
		let entries: [string, vscode.FileType][] = [];
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		} catch {
			return;
		}
		const subdirs: vscode.Uri[] = [];
		for (const [name, type] of entries) {
			if (type & vscode.FileType.Directory) {
				if (level < depth && !skip.test(name)) {
					subdirs.push(vscode.Uri.joinPath(dir, name));
				}
			} else if (/\.slnx?$/i.test(name)) {
				found.push(vscode.Uri.joinPath(dir, name));
			}
		}
		await Promise.all(subdirs.map(d => walk(d, level + 1)));
	};
	await walk(folder, 0);
	return found.sort((a, b) => a.path.split('/').length - b.path.split('/').length || collator.compare(a.path, b.path));
}

/** Builds the Visual Studio-like Solution Explorer tree of the workspaces that show a solution. */
export class SolutionModel implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	/** Fires when a solution or project file changed and the tree should be re-read. */
	readonly onDidChange = this._onDidChange.event;

	/** Solutions on screen: their files are watched. */
	private readonly tracked = new Map<string, Tracked>();
	/**
	 * Every solution of the universe, on screen or not. The webview asks for a workspace's tree the
	 * moment its tab is clicked, before the host has switched, so solutions must be known ahead.
	 */
	private readonly known = new Map<string, { sln: vscode.Uri; folder: vscode.Uri }>();
	private readonly cache = new Map<string, Promise<LoadedSolution | undefined>>();
	private readonly loaded = new Map<string, LoadedSolution>();
	/** Per solution root key: the nodes handed to the webview, so it can ask for their children. */
	private readonly registry = new Map<string, Map<string, Desc>>();
	private readonly dirCache = new Map<string, DirState>();
	private reloadTimer?: ReturnType<typeof setTimeout>;
	private readonly decoder = new TextDecoder();

	constructor(private readonly files: FileModel) {}

	dispose(): void {
		clearTimeout(this.reloadTimer);
		this.tracked.forEach(t => t.watcher.dispose());
		this._onDidChange.dispose();
	}

	/**
	 * Sets every solution of the universe (`all`) and the ones on screen (`shown`), whose files are
	 * watched while they are.
	 */
	track(shown: { sln: vscode.Uri; folder: vscode.Uri }[], all: { sln: vscode.Uri; folder: vscode.Uri }[] = shown): void {
		this.known.clear();
		for (const s of [...all, ...shown]) {
			this.known.set(solutionRootKey(s.sln), s);
		}
		const solutions = shown;
		const wanted = new Map(solutions.map(s => [solutionRootKey(s.sln), s]));
		for (const [key, t] of this.tracked) {
			if (!wanted.has(key)) {
				t.watcher.dispose();
				this.tracked.delete(key);
				this.forget(key);
			}
		}
		for (const [key, s] of wanted) {
			if (this.tracked.has(key)) {
				continue;
			}
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.joinPath(s.sln, '..'), `**/*.${PROJECT_FILES}`),
			);
			const onEvent = () => this.reload(key);
			watcher.onDidChange(onEvent);
			watcher.onDidCreate(onEvent);
			watcher.onDidDelete(onEvent);
			this.tracked.set(key, { ...s, watcher });
		}
	}

	isRoot(key: unknown): boolean {
		return typeof key === 'string' && this.known.has(key);
	}

	/** True if `uri` belongs to a project of a solution on screen (projects may live outside the workspace folder). */
	isAllowed(uri: vscode.Uri): boolean {
		for (const sol of this.loaded.values()) {
			for (const p of sol.projects.values()) {
				if (isInside(uri, p.dir)) {
					return true;
				}
				for (const shown of p.explicit.values()) {
					for (const s of shown.values()) {
						if (!s.dir && isInside(uri, s.uri)) {
							return true;
						}
					}
				}
			}
		}
		return false;
	}

	private forget(rootKey: string): void {
		this.cache.delete(rootKey);
		this.loaded.delete(rootKey);
		for (const k of [...this.dirCache.keys()]) {
			if (k.startsWith(rootKey + '|')) {
				this.dirCache.delete(k);
			}
		}
	}

	private reload(rootKey: string): void {
		this.forget(rootKey);
		clearTimeout(this.reloadTimer);
		this.reloadTimer = setTimeout(() => this._onDidChange.fire(), RELOAD_DEBOUNCE_MS);
	}

	/** Drops cached folder listings (after files were created or deleted). */
	filesChanged(): void {
		this.dirCache.clear();
	}

	private load(rootKey: string): Promise<LoadedSolution | undefined> {
		const t = this.known.get(rootKey);
		if (!t) {
			return Promise.resolve(undefined);
		}
		let p = this.cache.get(rootKey);
		if (!p) {
			p = this.read(t.sln).then(
				sol => {
					if (this.cache.get(rootKey) === p) {
						this.loaded.set(rootKey, sol);
					}
					return sol;
				},
				err => {
					logError(`could not read solution ${t.sln.fsPath}`, err);
					return undefined;
				},
			);
			this.cache.set(rootKey, p);
		}
		return p;
	}

	/** Reads a text file; Visual Studio sometimes saves solutions and projects as UTF-16. */
	private async readText(uri: vscode.Uri): Promise<string> {
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes[0] === 0xff && bytes[1] === 0xfe) {
			return new TextDecoder('utf-16le').decode(bytes);
		}
		if (bytes[0] === 0xfe && bytes[1] === 0xff) {
			return new TextDecoder('utf-16be').decode(bytes);
		}
		return this.decoder.decode(bytes);
	}

	private async read(sln: vscode.Uri): Promise<LoadedSolution> {
		const dir = vscode.Uri.joinPath(sln, '..');
		const parsed = parseSolution(await this.readText(sln), sln.path);
		const sol: LoadedSolution = {
			sln,
			dir,
			name: path.posix.basename(sln.path).replace(/\.slnx?$/i, ''),
			entries: parsed.entries,
			byId: new Map(parsed.entries.map(e => [e.id, e])),
			projects: new Map(),
			failures: new Map(),
		};
		await Promise.all(
			parsed.entries
				.filter(e => e.kind === 'project')
				.map(async entry => {
					if (!entry.path || /^[a-z][a-z0-9+.-]+:\/\//i.test(entry.path)) {
						sol.failures.set(entry.id, entry.path ? `hosted at ${entry.path}` : 'no path in the solution');
						return;
					}
					const file = vscode.Uri.joinPath(dir, entry.path);
					let info: ParsedProject | undefined;
					if (!entry.isFolderProject) {
						try {
							info = parseProject(await this.readText(file));
						} catch (err) {
							const stat = await Promise.resolve(vscode.workspace.fs.stat(file)).catch(() => undefined);
							if (stat && stat.type & vscode.FileType.Directory) {
								// A web site project listed without a trailing slash: it is a folder.
								entry = { ...entry, isFolderProject: true };
							} else {
								const reason =
									err instanceof vscode.FileSystemError && err.code === 'FileNotFound'
										? `file not found: ${file.fsPath}`
										: `could not read ${file.fsPath}: ${err instanceof Error ? err.message : String(err)}`;
								sol.failures.set(entry.id, reason);
								logError(`solution ${path.posix.basename(sln.path)}: project "${entry.name}"`, reason);
								return;
							}
						}
					}
					sol.projects.set(entry.id, this.prepare(entry, file, info));
				}),
		);
		return sol;
	}

	private prepare(entry: SolutionEntry, file: vscode.Uri, info: ParsedProject | undefined): LoadedProject {
		const dir = entry.isFolderProject ? file : vscode.Uri.joinPath(file, '..');
		const globbing = !!entry.isFolderProject || (!!info?.sdk && info.defaultItems);
		const p: LoadedProject = {
			entry,
			file,
			dir,
			info,
			globbing,
			explicit: new Map(),
			included: new Set(),
			dependent: new Map(),
			removes: new Map(),
			isWeb: /\.(Web|Razor|BlazorWebAssembly)\b/i.test(info?.sdk ?? ''),
		};
		if (!info) {
			return p;
		}
		for (const r of info.removes) {
			const list = p.removes.get(r.type.toLowerCase()) ?? [];
			list.push(globToRegExp(r.pattern));
			p.removes.set(r.type.toLowerCase(), list);
		}
		for (const [updated, parent] of info.updates) {
			p.dependent.set(updated, path.posix.basename(parent).toLowerCase());
		}
		const addShown = (display: string, target: vscode.Uri, isDir: boolean) => {
			const parts = display.split('/').filter(Boolean);
			if (!parts.length || parts.some(s => s === '..')) {
				return;
			}
			// Every folder on the way is shown too.
			for (let i = 0; i < parts.length; i++) {
				const folder = parts.slice(0, i).join('/').toLowerCase();
				const last = i === parts.length - 1;
				const map = p.explicit.get(folder) ?? new Map<string, Shown>();
				p.explicit.set(folder, map);
				const key = parts[i].toLowerCase();
				if (!map.has(key)) {
					map.set(key, {
						name: parts[i],
						uri: last ? target : vscode.Uri.joinPath(dir, ...parts.slice(0, i + 1)),
						dir: last ? isDir : true,
					});
				}
			}
		};
		for (const item of info.items) {
			if (/[*?]/.test(item.path)) {
				continue; // wildcards: only SDK globbing (from disk) is supported
			}
			const isFolder = item.type.toLowerCase() === 'folder' || item.path.endsWith('/');
			const itemPath = item.path.replace(/\/$/, '');
			const outside = itemPath.startsWith('../') || /^[A-Za-z]:\//.test(itemPath) || itemPath.startsWith('/');
			const target = /^[A-Za-z]:\//.test(itemPath) ? vscode.Uri.file(itemPath) : vscode.Uri.joinPath(dir, itemPath);
			const display = item.link ?? (outside ? path.posix.basename(itemPath) : itemPath);
			if (!outside) {
				p.included.add(itemPath.toLowerCase());
			}
			if (item.dependentUpon) {
				p.dependent.set(display.toLowerCase(), path.posix.basename(item.dependentUpon).toLowerCase());
			}
			// SDK projects show their folder from disk; only items placed elsewhere are added.
			if (!globbing || item.link || outside || isFolder) {
				addShown(display, target, isFolder);
			}
		}
		return p;
	}

	// ---------------------------------------------------------------------------- listing

	private register(rootKey: string, key: string, desc: Desc): void {
		let map = this.registry.get(rootKey);
		if (!map) {
			map = new Map();
			this.registry.set(rootKey, map);
		}
		map.set(key, desc);
	}

	/** Children of the node `key` in the tree whose root is `rootKey`. */
	async list(rootKey: string, key: string): Promise<SolutionRow[]> {
		const sol = await this.load(rootKey);
		if (!sol) {
			return [];
		}
		if (key === rootKey) {
			return [this.solutionRow(rootKey, sol)];
		}
		if (key === rootKey + ':s') {
			return this.entryRows(rootKey, sol, undefined);
		}
		const desc = this.registry.get(rootKey)?.get(key);
		if (!desc) {
			return [];
		}
		if (desc.k === 'folder') {
			return this.entryRows(rootKey, sol, desc.id);
		}
		const p = sol.projects.get(desc.id);
		if (!p) {
			return [];
		}
		switch (desc.k) {
			case 'project':
				return this.projectRows(rootKey, sol, p);
			case 'deps':
				return this.depsRows(rootKey, p);
			case 'group':
				return this.leafRows(rootKey, p, desc.group);
			case 'dir':
				return this.dirRows(rootKey, sol, p, desc.rel);
			case 'nest': {
				const state = await this.dirState(rootKey, sol, p, desc.rel);
				return this.fileRows(rootKey, p, desc.rel, state, state.nested.get(desc.name) ?? []);
			}
		}
	}

	private solutionRow(rootKey: string, sol: LoadedSolution): SolutionRow {
		const projects = [...sol.projects.values()];
		const total = sol.entries.filter(e => e.kind === 'project').length;
		const available = projects.filter(p => p.info || p.entry.isFolderProject).length;
		return {
			key: rootKey + ':s',
			uri: sol.sln.toString(),
			name: `Solution '${sol.name}' (${available} of ${total} project${total === 1 ? '' : 's'})`,
			dir: true,
			virt: true,
			section: 'solution',
			file: sol.sln.toString(),
			iconOf: path.posix.basename(sol.sln.path),
			fb: 'library',
			alias: uriKey(sol.dir),
			drop: sol.dir.toString(),
			open: true,
		};
	}

	/** Solution folders, projects and solution items under a solution folder (or the solution). */
	private entryRows(rootKey: string, sol: LoadedSolution, parent: string | undefined): SolutionRow[] {
		const children = sol.entries.filter(e => e.parent === parent && (e.parent === undefined || sol.byId.has(e.parent)));
		// Entries whose parent is missing from the solution are shown at the top level.
		if (parent === undefined) {
			children.push(...sol.entries.filter(e => e.parent !== undefined && !sol.byId.has(e.parent)));
		}
		children.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : collator.compare(a.name, b.name)));
		const rows: SolutionRow[] = [];
		for (const e of children) {
			if (e.kind === 'folder') {
				const key = `${rootKey}:f:${e.id}`;
				this.register(rootKey, key, { k: 'folder', id: e.id });
				rows.push({ key, uri: sol.dir.toString(), name: e.name, dir: true, virt: true, section: 'slnFolder' });
				continue;
			}
			const p = sol.projects.get(e.id);
			const key = `${rootKey}:p:${e.id}`;
			if (!p || (!p.info && !p.entry.isFolderProject)) {
				rows.push({
					key,
					uri: sol.dir.toString(),
					name: e.name,
					desc: '(unavailable)',
					tip: sol.failures.get(e.id) ?? 'the project could not be loaded',
					dir: false,
					virt: true,
					faded: true,
					section: 'slnFolder',
					iconOf: e.path ? path.posix.basename(e.path) : undefined,
					fb: 'project',
				});
				continue;
			}
			this.register(rootKey, key, { k: 'project', id: e.id });
			rows.push({
				key,
				uri: p.dir.toString(),
				name: e.name,
				dir: true,
				virt: true,
				section: 'project',
				file: p.entry.isFolderProject ? undefined : p.file.toString(),
				iconOf: p.entry.isFolderProject ? undefined : path.posix.basename(p.file.path),
				fb: 'project',
				alias: uriKey(p.dir),
				drop: p.dir.toString(),
			});
		}
		if (parent !== undefined) {
			const entry = sol.byId.get(parent);
			for (const f of entry?.files ?? []) {
				const uri = vscode.Uri.joinPath(sol.dir, f);
				rows.push({ key: uriKey(uri), uri: uri.toString(), name: path.posix.basename(f), dir: false });
			}
		}
		return rows;
	}

	private async projectRows(rootKey: string, sol: LoadedSolution, p: LoadedProject): Promise<SolutionRow[]> {
		const rows: SolutionRow[] = [];
		const info = p.info;
		if (info && (info.sdk || this.groups(p).length)) {
			const key = `${rootKey}:d:${p.entry.id}`;
			this.register(rootKey, key, { k: 'deps', id: p.entry.id });
			rows.push({
				key,
				uri: p.dir.toString(),
				name: info.sdk ? 'Dependencies' : 'References',
				dir: true,
				virt: true,
				ci: 'references',
				section: 'virtual',
			});
		}
		return [...rows, ...(await this.dirRows(rootKey, sol, p, ''))];
	}

	/** Dependency groups like Visual Studio's: frameworks, packages, projects, assemblies, COM. */
	private groups(p: LoadedProject): { id: string; label: string; icon: string; items: string[] }[] {
		const info = p.info;
		if (!info) {
			return [];
		}
		const frameworks = new Set<string>(info.frameworks);
		if (info.sdk) {
			for (const tfm of info.targetFrameworks) {
				if (/^netstandard/i.test(tfm)) {
					frameworks.add('NETStandard.Library');
				} else if (/^(netcoreapp|net\d{1,2}\.\d)/i.test(tfm) || /^net[5-9]\d*$|^net\d{2,}$/i.test(tfm.split('-')[0])) {
					frameworks.add('Microsoft.NETCore.App');
				}
			}
			if (p.isWeb) {
				frameworks.add('Microsoft.AspNetCore.App');
			}
			if (info.useWpf || info.useWindowsForms || /WindowsDesktop/i.test(info.sdk)) {
				frameworks.add('Microsoft.WindowsDesktop.App');
			}
		}
		const withVersion = (r: { name: string; version?: string }) => (r.version ? `${r.name} (${r.version})` : r.name);
		const projectName = (rel: string) => path.posix.basename(rel).replace(/\.[^.]+$/, '');
		const groups = [
			{ id: 'fw', label: 'Frameworks', icon: 'layers', items: [...frameworks] },
			{ id: 'pkg', label: 'Packages', icon: 'package', items: info.packages.map(withVersion) },
			{ id: 'prj', label: 'Projects', icon: 'project', items: info.projects.map(projectName) },
			{ id: 'asm', label: 'Assemblies', icon: 'library', items: info.assemblies.map(a => a.name) },
			{ id: 'com', label: 'COM', icon: 'plug', items: info.com },
		];
		for (const g of groups) {
			g.items = [...new Set(g.items)].sort(collator.compare);
		}
		return groups.filter(g => g.items.length);
	}

	private depsRows(rootKey: string, p: LoadedProject): SolutionRow[] {
		const groups = this.groups(p);
		if (!p.info?.sdk) {
			// Old-style projects show one flat "References" list.
			const leaves = groups.flatMap(g => g.items.map(name => ({ name, icon: g.icon, group: g.id })));
			leaves.sort((a, b) => collator.compare(a.name, b.name));
			return leaves.map((l, i) => this.leaf(rootKey, p, l.group + i, l.name, l.icon));
		}
		return groups.map(g => {
			const key = `${rootKey}:g:${p.entry.id}:${g.id}`;
			this.register(rootKey, key, { k: 'group', id: p.entry.id, group: g.id });
			return { key, uri: p.dir.toString(), name: g.label, dir: true, virt: true, ci: g.icon, section: 'virtual' };
		});
	}

	private leafRows(rootKey: string, p: LoadedProject, group: string): SolutionRow[] {
		const g = this.groups(p).find(x => x.id === group);
		return (g?.items ?? []).map((name, i) => this.leaf(rootKey, p, group + i, name, g!.icon));
	}

	private leaf(rootKey: string, p: LoadedProject, id: string, name: string, icon: string): SolutionRow {
		return { key: `${rootKey}:l:${p.entry.id}:${id}`, uri: p.dir.toString(), name, dir: false, virt: true, ci: icon, section: 'virtual' };
	}

	/** Item type a file belongs to by default in an SDK-style project (for `Remove` patterns). */
	private naturalType(p: LoadedProject, rel: string): string {
		const ext = path.posix.extname(rel).toLowerCase();
		if (ext === '.cs' || ext === '.vb' || ext === '.fs') {
			return 'compile';
		}
		if (ext === '.resx') {
			return 'embeddedresource';
		}
		if (p.isWeb && (/^wwwroot\//i.test(rel) || ['.json', '.config', '.cshtml', '.razor'].includes(ext))) {
			return 'content';
		}
		if (ext === '.xaml' && p.info?.useWpf) {
			return 'page';
		}
		return 'none';
	}

	private removed(p: LoadedProject, rel: string, type = this.naturalType(p, rel)): boolean {
		const lower = rel.toLowerCase();
		if (p.included.has(lower)) {
			return false;
		}
		return (p.removes.get(type) ?? []).some(re => re.test(rel));
	}

	/** What a project folder shows: files from disk (SDK) and/or items, with nesting applied. */
	private async dirState(rootKey: string, sol: LoadedSolution, p: LoadedProject, rel: string): Promise<DirState> {
		const cacheKey = `${rootKey}|${p.entry.id}|${rel.toLowerCase()}`;
		const cached = this.dirCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		const physical = rel ? vscode.Uri.joinPath(p.dir, ...rel.split('/')) : p.dir;
		const all = new Map<string, Shown>();
		if (p.globbing) {
			const otherProjects = new Set(
				[...sol.projects.values()].filter(o => o !== p && o.info).map(o => uriKey(o.dir)),
			);
			const t = this.known.get(rootKey);
			for (const e of await this.files.list(physical, t?.folder ?? sol.dir)) {
				const lower = e.name.toLowerCase();
				const relPath = rel ? `${rel}/${e.name}` : e.name;
				if (e.isDirectory) {
					if (
						(!rel && (lower === 'bin' || lower === 'obj')) ||
						lower.startsWith('.') ||
						lower === 'node_modules' ||
						otherProjects.has(uriKey(e.uri)) ||
						(this.removed(p, `${relPath}/x.cs`, 'compile') && this.removed(p, `${relPath}/x.txt`, 'none'))
					) {
						continue;
					}
				} else if (/\.(user|sln|slnx|vssscc)$|\.[^.]*proj$/i.test(lower) || this.removed(p, relPath)) {
					continue;
				}
				all.set(lower, { name: e.name, uri: e.uri, dir: e.isDirectory });
			}
		}
		for (const [lower, shown] of p.explicit.get(rel.toLowerCase()) ?? []) {
			if (!all.has(lower)) {
				all.set(lower, shown);
			}
		}

		// Nesting: DependentUpon first, then (SDK-style only) Visual Studio's naming conventions.
		const fileNames = new Set([...all.values()].filter(s => !s.dir).map(s => s.name.toLowerCase()));
		const parentOf = new Map<string, string>();
		for (const s of all.values()) {
			if (s.dir) {
				continue;
			}
			const lower = s.name.toLowerCase();
			const relLower = rel ? `${rel.toLowerCase()}/${lower}` : lower;
			let parent = p.dependent.get(relLower);
			if (parent && (!fileNames.has(parent) || parent === lower)) {
				parent = undefined;
			}
			if (!parent && p.info?.sdk) {
				parent = conventionalParent(s.name, fileNames);
			}
			if (parent) {
				parentOf.set(lower, parent);
			}
		}
		// A file nested (indirectly) under itself would disappear; break such cycles.
		for (const start of [...parentOf.keys()]) {
			const seen = new Set([start]);
			let cur = parentOf.get(start);
			while (cur && parentOf.has(cur)) {
				if (seen.has(cur)) {
					parentOf.delete(start);
					break;
				}
				seen.add(cur);
				cur = parentOf.get(cur);
			}
		}

		const sortShown = (list: Shown[], top: boolean) =>
			list.sort((a, b) => {
				if (a.dir !== b.dir) {
					return a.dir ? -1 : 1;
				}
				if (top && a.dir) {
					const sa = SPECIAL_FOLDERS.indexOf(a.name.toLowerCase());
					const sb = SPECIAL_FOLDERS.indexOf(b.name.toLowerCase());
					if (sa !== sb) {
						return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb);
					}
				}
				return collator.compare(a.name, b.name);
			});
		const state: DirState = { top: [], nested: new Map() };
		for (const s of all.values()) {
			const parent = s.dir ? undefined : parentOf.get(s.name.toLowerCase());
			if (parent) {
				const list = state.nested.get(parent) ?? [];
				list.push(s);
				state.nested.set(parent, list);
			} else {
				state.top.push(s);
			}
		}
		sortShown(state.top, !rel);
		state.nested.forEach(list => sortShown(list, false));
		this.dirCache.set(cacheKey, state);
		return state;
	}

	private async dirRows(rootKey: string, sol: LoadedSolution, p: LoadedProject, rel: string): Promise<SolutionRow[]> {
		const state = await this.dirState(rootKey, sol, p, rel);
		return this.fileRows(rootKey, p, rel, state, state.top);
	}

	private fileRows(rootKey: string, p: LoadedProject, rel: string, state: DirState, list: Shown[]): SolutionRow[] {
		const physical = rel ? vscode.Uri.joinPath(p.dir, ...rel.split('/')) : p.dir;
		return list.map(s => {
			const key = uriKey(s.uri);
			if (s.dir) {
				this.register(rootKey, key, { k: 'dir', id: p.entry.id, rel: rel ? `${rel}/${s.name}` : s.name });
				return { key, uri: s.uri.toString(), name: s.name, dir: true };
			}
			const lower = s.name.toLowerCase();
			if (!state.nested.has(lower)) {
				return { key, uri: s.uri.toString(), name: s.name, dir: false };
			}
			this.register(rootKey, key, { k: 'nest', id: p.entry.id, rel, name: lower });
			return { key, uri: s.uri.toString(), name: s.name, dir: false, nest: true, alias: uriKey(physical) };
		});
	}

	// ---------------------------------------------------------------------------- reveal

	/**
	 * The keys of the nodes to expand to show `uri` in a solution on screen, or undefined if no
	 * solution shows it.
	 */
	async revealChain(uri: vscode.Uri): Promise<{ rootKey: string; key: string; chain: string[] } | undefined> {
		for (const rootKey of this.tracked.keys()) {
			const sol = await this.load(rootKey);
			if (!sol) {
				continue;
			}
			const folderChain = (id: string | undefined) => {
				const keys: string[] = [];
				for (let e = id ? sol.byId.get(id) : undefined; e; e = e.parent ? sol.byId.get(e.parent) : undefined) {
					if (e.kind === 'folder') {
						keys.unshift(`${rootKey}:f:${e.id}`);
					}
				}
				return [rootKey + ':s', ...keys];
			};
			// Solution items.
			for (const e of sol.entries) {
				if (e.kind === 'folder' && e.files.some(f => uriKey(vscode.Uri.joinPath(sol.dir, f)) === uriKey(uri))) {
					for (const k of folderChain(e.id).slice(1)) {
						this.register(rootKey, k, { k: 'folder', id: k.slice(`${rootKey}:f:`.length) });
					}
					return { rootKey, key: uriKey(uri), chain: folderChain(e.id) };
				}
			}
			// The innermost project folder that contains the file.
			const p = [...sol.projects.values()]
				.filter(x => x.info && isInside(uri, x.dir) && uriKey(uri) !== uriKey(x.dir))
				.sort((a, b) => b.dir.path.length - a.dir.path.length)[0];
			if (!p) {
				continue;
			}
			const parts = path.posix.relative(p.dir.path, uri.path).split('/');
			const chain = folderChain(p.entry.parent);
			for (const k of chain.slice(1)) {
				this.register(rootKey, k, { k: 'folder', id: k.slice(`${rootKey}:f:`.length) });
			}
			const projectKey = `${rootKey}:p:${p.entry.id}`;
			this.register(rootKey, projectKey, { k: 'project', id: p.entry.id });
			chain.push(projectKey);
			let rel = '';
			for (const part of parts.slice(0, -1)) {
				const state = await this.dirState(rootKey, sol, p, rel);
				const dir = state.top.find(s => s.dir && s.name.toLowerCase() === part.toLowerCase());
				if (!dir) {
					return undefined; // not part of the project (excluded, bin/obj, …)
				}
				rel = rel ? `${rel}/${dir.name}` : dir.name;
				const key = uriKey(dir.uri);
				this.register(rootKey, key, { k: 'dir', id: p.entry.id, rel });
				chain.push(key);
			}
			const state = await this.dirState(rootKey, sol, p, rel);
			const name = parts[parts.length - 1].toLowerCase();
			// Files nested under other files: expand the parents, outermost first.
			const parents: string[] = [];
			let current = name;
			for (let guard = 0; guard < 10; guard++) {
				const parent = [...state.nested].find(([, list]) => list.some(s => s.name.toLowerCase() === current))?.[0];
				if (!parent) {
					break;
				}
				parents.unshift(parent);
				current = parent;
			}
			const known = [...state.top, ...[...state.nested.values()].flat()];
			if (!known.some(s => s.name.toLowerCase() === name)) {
				return undefined;
			}
			for (const parent of parents) {
				const shown = known.find(s => s.name.toLowerCase() === parent);
				if (!shown) {
					return undefined;
				}
				const key = uriKey(shown.uri);
				this.register(rootKey, key, { k: 'nest', id: p.entry.id, rel, name: parent });
				chain.push(key);
			}
			return { rootKey, key: uriKey(uri), chain };
		}
		return undefined;
	}
}
