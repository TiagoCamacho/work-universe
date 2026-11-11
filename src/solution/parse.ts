/**
 * Parsers for Visual Studio solutions (.sln, .slnx) and MSBuild project files.
 *
 * Plain string/regex code with no VS Code dependency, so it can be unit-tested directly. It reads
 * what the Solution Explorer needs to draw the tree; it is not an MSBuild evaluator (conditions,
 * imports and most properties are ignored).
 */

/** Project type of a solution folder in .sln files. */
const SOLUTION_FOLDER_TYPE = '2150E333-8FDC-42A3-9474-1A3956D46DE8';
/** Web site projects point to a folder instead of a project file. */
const WEBSITE_TYPE = 'E24C65DC-7377-472B-9ABA-BC803B73C61A';

export interface SolutionEntry {
	/** Stable id within the solution (project GUID in .sln, folder path / project path in .slnx). */
	id: string;
	name: string;
	kind: 'folder' | 'project';
	/** Project file (or web site folder) relative to the solution, with `/` separators. */
	path?: string;
	/** The project is a folder (web site project), not a project file. */
	isFolderProject?: boolean;
	/** Id of the solution folder this entry is in. */
	parent?: string;
	/** Solution items of a solution folder, relative to the solution. */
	files: string[];
}

export interface ParsedSolution {
	entries: SolutionEntry[];
}

const normalizePath = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
const stripBraces = (g: string) => g.trim().replace(/^\{|\}$/g, '').toUpperCase();

export function parseSolution(text: string, fileName: string): ParsedSolution {
	return /\.slnx$/i.test(fileName) ? parseSlnx(text) : parseSln(text);
}

/** Classic text .sln format. */
export function parseSln(text: string): ParsedSolution {
	const entries: SolutionEntry[] = [];
	const byId = new Map<string, SolutionEntry>();
	const projectRe =
		/^\s*Project\("\{([^}]+)\}"\)\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"\{([^}]+)\}"\s*$([\s\S]*?)^\s*EndProject\s*$/gm;
	let m: RegExpExecArray | null;
	while ((m = projectRe.exec(text))) {
		const [, type, name, rawPath, guid, body] = m;
		const isFolder = stripBraces(type) === SOLUTION_FOLDER_TYPE;
		const entry: SolutionEntry = {
			id: stripBraces(guid),
			name,
			kind: isFolder ? 'folder' : 'project',
			files: [],
		};
		if (!isFolder) {
			entry.path = normalizePath(rawPath);
			entry.isFolderProject = stripBraces(type) === WEBSITE_TYPE || /\/$/.test(entry.path);
			entry.path = entry.path.replace(/\/$/, '');
		}
		const items = /ProjectSection\(SolutionItems\)[^\r\n]*([\s\S]*?)EndProjectSection/.exec(body);
		if (items) {
			for (const line of items[1].split(/\r?\n/)) {
				const eq = line.indexOf('=');
				if (eq > 0) {
					entry.files.push(normalizePath(line.slice(0, eq)));
				}
			}
		}
		entries.push(entry);
		byId.set(entry.id, entry);
	}
	const nested = /GlobalSection\(NestedProjects\)[^\r\n]*([\s\S]*?)EndGlobalSection/.exec(text);
	if (nested) {
		for (const line of nested[1].split(/\r?\n/)) {
			const pair = /\{([^}]+)\}\s*=\s*\{([^}]+)\}/.exec(line);
			const child = pair && byId.get(stripBraces(pair[1]));
			if (child && byId.has(stripBraces(pair[2]))) {
				child.parent = stripBraces(pair[2]);
			}
		}
	}
	return { entries };
}

/** XML .slnx format (Visual Studio 2022 17.13+). */
export function parseSlnx(text: string): ParsedSolution {
	const xml = stripComments(text);
	const entries: SolutionEntry[] = [];
	const folders = new Map<string, SolutionEntry>();

	/** Folder names are full paths like "/src/libs/"; parents are created when missing. */
	const folderFor = (fullName: string): SolutionEntry | undefined => {
		const parts = fullName.split('/').filter(Boolean);
		let parent: SolutionEntry | undefined;
		for (let i = 0; i < parts.length; i++) {
			const id = 'F:/' + parts.slice(0, i + 1).join('/') + '/';
			let folder = folders.get(id.toLowerCase());
			if (!folder) {
				folder = { id, name: parts[i], kind: 'folder', parent: parent?.id, files: [] };
				folders.set(id.toLowerCase(), folder);
				entries.push(folder);
			}
			parent = folder;
		}
		return parent;
	};

	const addProject = (attrs: Record<string, string>, parent: SolutionEntry | undefined) => {
		if (!attrs.Path) {
			return;
		}
		const path = normalizePath(attrs.Path);
		const base = path.split('/').pop() ?? path;
		entries.push({
			id: 'P:' + path.toLowerCase(),
			name: attrs.DisplayName || base.replace(/\.[^.]+$/, ''),
			kind: 'project',
			path,
			parent: parent?.id,
			files: [],
		});
	};

	const folderRe = /<Folder\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Folder\s*>)/g;
	let m: RegExpExecArray | null;
	while ((m = folderRe.exec(xml))) {
		const attrs = parseAttributes(m[1]);
		const folder = attrs.Name ? folderFor(attrs.Name) : undefined;
		if (!folder || !m[2]) {
			continue;
		}
		for (const el of elements(m[2], 'Project')) {
			addProject(el, folder);
		}
		for (const el of elements(m[2], 'File')) {
			if (el.Path) {
				folder.files.push(normalizePath(el.Path));
			}
		}
	}
	// Projects at the top level: everything outside <Folder> elements.
	for (const el of elements(xml.replace(folderRe, ''), 'Project')) {
		addProject(el, undefined);
	}
	return { entries };
}

// ---------------------------------------------------------------------------------- projects

export interface ProjectItem {
	/** MSBuild item type, e.g. `Compile`, `None`, `Folder`. */
	type: string;
	/** Path relative to the project folder, with `/` separators (may start with `../`). */
	path: string;
	/** `Link` metadata: where the item is shown, relative to the project folder. */
	link?: string;
	/** `DependentUpon` metadata: file this one is nested under. */
	dependentUpon?: string;
}

export interface ProjectReferenceInfo {
	name: string;
	version?: string;
}

export interface ParsedProject {
	/** SDK of an SDK-style project (`Microsoft.NET.Sdk`, …); undefined for old-style projects. */
	sdk?: string;
	targetFrameworks: string[];
	/** Whether the SDK includes files of the project folder by default (`EnableDefaultItems`). */
	defaultItems: boolean;
	useWpf: boolean;
	useWindowsForms: boolean;
	/** File items listed with `Include`. */
	items: ProjectItem[];
	/** `DependentUpon` set with `Update`, keyed by the updated path (lower case). */
	updates: Map<string, string>;
	/** `Remove` patterns per item type. */
	removes: { type: string; pattern: string }[];
	packages: ProjectReferenceInfo[];
	projects: string[];
	assemblies: ProjectReferenceInfo[];
	frameworks: string[];
	com: string[];
}

/** Item types that are references or settings rather than files shown in the tree. */
const NON_FILE_ITEMS = new Set(
	[
		'PackageReference', 'ProjectReference', 'Reference', 'FrameworkReference', 'COMReference', 'COMFileReference',
		'Analyzer', 'InternalsVisibleTo', 'Using', 'PackageVersion', 'GlobalPackageReference', 'BootstrapperPackage',
		'Service', 'WCFMetadata', 'WCFMetadataStorage', 'WebReferences', 'WebReferenceUrl', 'ProjectCapability',
		'SupportedPlatform', 'ProjectConfiguration', 'ProjectExtensions', 'AssemblyAttribute', 'TrimmerRootAssembly',
		'RuntimeHostConfigurationOption', 'Watch', 'CodeAnalysisDictionary', 'NativeReference', 'SDKReference',
		'ClInclude_Filters', 'Filter', 'PropertyPageSchema', 'AvailableItemName', 'ExcludeFromSourceBuild',
	].map(s => s.toLowerCase()),
);

export function parseProject(text: string): ParsedProject {
	const xml = stripComments(text);
	const projectTag = /<Project\b([^>]*)>/.exec(xml);
	const sdk =
		parseAttributes(projectTag?.[1] ?? '').Sdk ||
		/<Sdk\b[^>]*\bName\s*=\s*"([^"]+)"/.exec(xml)?.[1] ||
		/<Import\b[^>]*\bSdk\s*=\s*"([^"]+)"/.exec(xml)?.[1];
	const prop = (name: string) => new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`, 'i').exec(xml)?.[1].trim();
	const frameworks = (prop('TargetFrameworks') ?? prop('TargetFramework') ?? prop('TargetFrameworkVersion') ?? '')
		.split(';')
		.map(s => s.trim())
		.filter(s => s && !s.includes('$('));
	const result: ParsedProject = {
		sdk: sdk || undefined,
		targetFrameworks: frameworks,
		defaultItems: !/^false$/i.test(prop('EnableDefaultItems') ?? ''),
		useWpf: /^true$/i.test(prop('UseWPF') ?? ''),
		useWindowsForms: /^true$/i.test(prop('UseWindowsForms') ?? ''),
		items: [],
		updates: new Map(),
		removes: [],
		packages: [],
		projects: [],
		assemblies: [],
		frameworks: [],
		com: [],
	};

	const groupRe = /<ItemGroup\b[^>]*>([\s\S]*?)<\/ItemGroup\s*>/g;
	let group: RegExpExecArray | null;
	while ((group = groupRe.exec(xml))) {
		const itemRe = /<([A-Za-z_][\w.-]*)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
		let item: RegExpExecArray | null;
		while ((item = itemRe.exec(group[1]))) {
			const type = item[1];
			const meta = { ...parseAttributes(item[2]), ...metadataElements(item[3] ?? '') };
			const values = (v: string | undefined) =>
				(v ?? '')
					.split(';')
					.map(s => unescapeMsbuild(s.trim()))
					.filter(s => s && !s.includes('$(') && !s.includes('@('));
			const lower = type.toLowerCase();
			for (const include of values(meta.Include)) {
				switch (lower) {
					case 'packagereference':
					case 'globalpackagereference':
						result.packages.push({ name: include, version: meta.Version || meta.VersionOverride });
						break;
					case 'projectreference':
						result.projects.push(normalizePath(include));
						break;
					case 'reference': {
						// "Name, Version=…, Culture=…" or a path to a dll.
						const name = include.split(',')[0].trim().replace(/\\/g, '/').split('/').pop()!.replace(/\.dll$/i, '');
						const version = /Version=([^,]+)/.exec(include)?.[1];
						result.assemblies.push({ name, version });
						break;
					}
					case 'frameworkreference':
						result.frameworks.push(include);
						break;
					case 'comreference':
					case 'comfilereference':
						result.com.push(include);
						break;
					default:
						if (!NON_FILE_ITEMS.has(lower)) {
							result.items.push({
								type,
								path: normalizePath(include),
								link: meta.Link ? normalizePath(unescapeMsbuild(meta.Link)) : undefined,
								dependentUpon: meta.DependentUpon ? normalizePath(unescapeMsbuild(meta.DependentUpon)) : undefined,
							});
						}
				}
			}
			if (!NON_FILE_ITEMS.has(lower)) {
				for (const update of values(meta.Update)) {
					if (meta.DependentUpon) {
						result.updates.set(normalizePath(update).toLowerCase(), normalizePath(unescapeMsbuild(meta.DependentUpon)));
					}
				}
				for (const remove of values(meta.Remove)) {
					result.removes.push({ type, pattern: normalizePath(remove) });
				}
			}
		}
	}
	return result;
}

// ---------------------------------------------------------------------------------- nesting

/**
 * Visual Studio's default file nesting for SDK-style projects: the name of the file `name` is
 * nested under, if that file is among `siblings` (lower-case names of the same folder).
 */
export function conventionalParent(name: string, siblings: ReadonlySet<string>): string | undefined {
	const lower = name.toLowerCase();
	const has = (n: string) => (siblings.has(n) && n !== lower ? n : undefined);
	// Form1.Designer.cs -> Form1.cs / Form1.resx / Settings.settings
	const designer = /^(.+)\.designer\.(cs|vb)$/.exec(lower);
	if (designer) {
		const [, base, ext] = designer;
		const hit = has(`${base}.${ext}`) ?? has(`${base}.resx`) ?? has(`${base}.settings`) ?? has(`${base}.xaml`);
		if (hit) {
			return hit;
		}
	}
	// site.min.css -> site.css, app.min.js -> app.js
	const min = /^(.+)\.min\.(js|css)$/.exec(lower);
	if (min && has(`${min[1]}.${min[2]}`)) {
		return `${min[1]}.${min[2]}`;
	}
	// Index.cshtml.cs -> Index.cshtml, Foo.razor.css -> Foo.razor, MainWindow.xaml.cs -> MainWindow.xaml, app.js.map -> app.js
	const added = /^(.+\.[a-z0-9]+)\.(cs|vb|fs|css|scss|js|ts|map)$/.exec(lower);
	if (added && has(added[1])) {
		return added[1];
	}
	// appsettings.Development.json -> appsettings.json, Web.Release.config -> Web.config
	const env = /^([^.]+)\.[^.]+\.(json|config)$/.exec(lower);
	if (env && has(`${env[1]}.${env[2]}`)) {
		return `${env[1]}.${env[2]}`;
	}
	// app.js -> app.ts, site.css -> site.scss / site.less
	const compiled = /^(.+)\.(js|css)$/.exec(lower);
	if (compiled) {
		const sources = compiled[2] === 'js' ? ['ts', 'tsx'] : ['scss', 'less', 'sass'];
		for (const src of sources) {
			if (has(`${compiled[1]}.${src}`)) {
				return `${compiled[1]}.${src}`;
			}
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------------- helpers

function stripComments(xml: string): string {
	return xml.replace(/<!--[\s\S]*?-->/g, '');
}

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, '&');
}

/** MSBuild escapes special characters as %XX (e.g. %20, %3B). */
function unescapeMsbuild(s: string): string {
	return s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseAttributes(text: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
	}
	return attrs;
}

/** Child elements like `<DependentUpon>Form1.cs</DependentUpon>` of an item. */
function metadataElements(body: string): Record<string, string> {
	const meta: Record<string, string> = {};
	const re = /<([\w.-]+)\b[^>]*>([^<]*)<\/\1\s*>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) {
		meta[m[1]] = decodeEntities(m[2].trim());
	}
	return meta;
}

function elements(xml: string, tag: string): Record<string, string>[] {
	const result: Record<string, string>[] = [];
	const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>[\\s\\S]*?</${tag}\\s*>)`, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) {
		result.push(parseAttributes(m[1]));
	}
	return result;
}
