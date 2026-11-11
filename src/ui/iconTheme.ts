import * as vscode from 'vscode';
import { logError } from '../perf';
import { parseJsonc } from './util';

interface IconDefinition {
	iconPath?: string;
	fontCharacter?: string;
	fontColor?: string;
	fontSize?: string;
	fontId?: string;
}

interface FontDefinition {
	id: string;
	src: { path: string; format: string }[];
	weight?: string;
	style?: string;
	size?: string;
}

interface IconMaps {
	file?: string;
	folder?: string;
	folderExpanded?: string;
	rootFolder?: string;
	rootFolderExpanded?: string;
	fileExtensions?: Record<string, string>;
	fileNames?: Record<string, string>;
	folderNames?: Record<string, string>;
	folderNamesExpanded?: Record<string, string>;
	languageIds?: Record<string, string>;
}

interface IconThemeJson extends IconMaps {
	iconDefinitions?: Record<string, IconDefinition>;
	fonts?: FontDefinition[];
	hidesExplorerArrows?: boolean;
	light?: IconMaps;
	highContrast?: IconMaps;
}

interface LoadedTheme {
	dir: vscode.Uri;
	extensionRoot: vscode.Uri;
	json: IconThemeJson;
	maps: IconMaps;
	classes: Map<string, string>;
	/** Definition ids by class number: class `icN` belongs to `defIds[N]`. */
	defIds: string[];
}

const lower = (rec?: Record<string, string>) =>
	Object.fromEntries(Object.entries(rec ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * Resolves file/folder icons of the active file icon theme (`workbench.iconTheme`) so the
 * webview file tree can show the same icons as the Explorer. Supports SVG/PNG and font themes.
 */
export class IconThemeResolver implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private readonly disposables: vscode.Disposable[] = [this._onDidChange];
	private theme?: LoadedTheme;
	private languageByExt = new Map<string, string>();
	private languageByName = new Map<string, string>();
	private loading?: Promise<void>;
	private readonly fileIconMemo = new Map<string, string | undefined>();

	constructor() {
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('workbench.iconTheme') && this.reload()),
			vscode.window.onDidChangeActiveColorTheme(() => this.reload()),
			vscode.extensions.onDidChange(() => this.reload()),
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	ready(): Promise<void> {
		return (this.loading ??= this.load());
	}

	private reload(): void {
		this.loading = this.load().then(() => this._onDidChange.fire());
	}

	get hasTheme(): boolean {
		return !!this.theme;
	}

	get hidesArrows(): boolean {
		return !!this.theme?.json.hidesExplorerArrows;
	}

	/** Folders the webview must be allowed to load icon files from. */
	get resourceRoots(): vscode.Uri[] {
		return this.theme ? [this.theme.extensionRoot] : [];
	}

	private async load(): Promise<void> {
		this.theme = undefined;
		this.fileIconMemo.clear();
		this.buildLanguageMaps();
		const id = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
		if (!id) {
			return;
		}
		for (const ext of vscode.extensions.all) {
			const contributed = (ext.packageJSON?.contributes?.iconThemes ?? []) as { id: string; path: string }[];
			const match = contributed.find(t => t.id === id);
			if (!match) {
				continue;
			}
			try {
				const file = vscode.Uri.joinPath(ext.extensionUri, match.path);
				const json = parseJsonc<IconThemeJson>(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
				const kind = vscode.window.activeColorTheme.kind;
				const variant =
					kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
						? json.light
						: kind === vscode.ColorThemeKind.HighContrast
							? json.highContrast
							: undefined;
				const maps = mergeMaps(json, variant);
				const classes = new Map<string, string>();
				const defIds = Object.keys(json.iconDefinitions ?? {});
				defIds.forEach((defId, i) => classes.set(defId, 'ic' + i));
				this.theme = { dir: vscode.Uri.joinPath(file, '..'), extensionRoot: ext.extensionUri, json, maps, classes, defIds };
			} catch (err) {
				logError(`could not load icon theme "${id}"`, err);
			}
			return;
		}
	}

	private buildLanguageMaps(): void {
		this.languageByExt.clear();
		this.languageByName.clear();
		for (const ext of vscode.extensions.all) {
			for (const lang of (ext.packageJSON?.contributes?.languages ?? []) as {
				id: string;
				extensions?: string[];
				filenames?: string[];
			}[]) {
				for (const e of lang.extensions ?? []) {
					const key = e.replace(/^\./, '').toLowerCase();
					if (!this.languageByExt.has(key)) {
						this.languageByExt.set(key, lang.id);
					}
				}
				for (const n of lang.filenames ?? []) {
					if (!this.languageByName.has(n.toLowerCase())) {
						this.languageByName.set(n.toLowerCase(), lang.id);
					}
				}
			}
		}
	}

	private fontFamily(id: string): string {
		return `wu-icon-font-${id.replace(/[^\w-]/g, '_')}`;
	}

	/** CSS every icon needs: the `@font-face` rules of font-based themes. */
	baseCss(webview: vscode.Webview): string {
		const theme = this.theme;
		if (!theme) {
			return '';
		}
		return (theme.json.fonts ?? [])
			.map(font => {
				const src = font.src
					.map(s => `url('${webview.asWebviewUri(vscode.Uri.joinPath(theme.dir, s.path))}') format('${s.format}')`)
					.join(', ');
				return `@font-face { font-family: '${this.fontFamily(font.id)}'; src: ${src}; font-weight: ${font.weight ?? 'normal'}; font-style: ${font.style ?? 'normal'}; font-display: block; }`;
			})
			.join('\n');
	}

	/**
	 * CSS rules for just the given icon classes (`icN`). Large themes define thousands of icons;
	 * the panel only asks for the ones its rows actually use.
	 */
	rulesFor(webview: vscode.Webview, classes: Iterable<string>): string {
		const theme = this.theme;
		if (!theme) {
			return '';
		}
		const fonts = theme.json.fonts ?? [];
		const defaultFont = fonts[0]?.id;
		const rules: string[] = [];
		for (const cls of classes) {
			const def = theme.json.iconDefinitions?.[theme.defIds[Number(cls.slice(2))]];
			if (!def) {
				continue;
			}
			if (def.iconPath) {
				const url = webview.asWebviewUri(vscode.Uri.joinPath(theme.dir, def.iconPath));
				rules.push(`.${cls} { background-image: url('${url}'); }`);
			} else if (def.fontCharacter) {
				const fontId = def.fontId ?? defaultFont;
				const size = def.fontSize ?? fonts.find(f => f.id === fontId)?.size;
				const parts = [
					`content: '${def.fontCharacter.replace(/'/g, "\\'")}'`,
					fontId ? `font-family: '${this.fontFamily(fontId)}'` : '',
					def.fontColor ? `color: ${def.fontColor}` : '',
					size ? `font-size: ${size}` : '',
				].filter(Boolean);
				rules.push(`.${cls}::before { ${parts.join('; ')}; }`);
			}
		}
		return rules.join('\n');
	}

	private cls(defId: string | undefined): string | undefined {
		return defId ? this.theme?.classes.get(defId) : undefined;
	}

	fileIcon(fileName: string): string | undefined {
		const name = fileName.toLowerCase();
		if (!this.fileIconMemo.has(name)) {
			this.fileIconMemo.set(name, this.resolveFileIcon(name));
		}
		return this.fileIconMemo.get(name);
	}

	private resolveFileIcon(name: string): string | undefined {
		const maps = this.theme?.maps;
		if (!maps) {
			return undefined;
		}
		const byName = maps.fileNames?.[name];
		if (byName) {
			return this.cls(byName);
		}
		// "a.spec.ts" → try "spec.ts", then "ts".
		const segments = name.split('.');
		for (let i = 1; i < segments.length; i++) {
			const ext = segments.slice(i).join('.');
			const byExt = maps.fileExtensions?.[ext];
			if (byExt) {
				return this.cls(byExt);
			}
		}
		const language = this.languageByName.get(name) ?? this.languageFromExtension(segments);
		const byLanguage = language ? maps.languageIds?.[language] : undefined;
		return this.cls(byLanguage ?? maps.file);
	}

	private languageFromExtension(segments: string[]): string | undefined {
		for (let i = 1; i < segments.length; i++) {
			const lang = this.languageByExt.get(segments.slice(i).join('.'));
			if (lang) {
				return lang;
			}
		}
		return undefined;
	}

	folderIcon(folderName: string, expanded: boolean, isRoot = false): string | undefined {
		const maps = this.theme?.maps;
		if (!maps) {
			return undefined;
		}
		const name = folderName.toLowerCase();
		if (isRoot) {
			return this.cls(expanded ? maps.rootFolderExpanded ?? maps.rootFolder ?? maps.folderExpanded : maps.rootFolder ?? maps.folder);
		}
		if (expanded) {
			return this.cls(maps.folderNamesExpanded?.[name] ?? maps.folderNames?.[name] ?? maps.folderExpanded ?? maps.folder);
		}
		return this.cls(maps.folderNames?.[name] ?? maps.folder);
	}
}

function mergeMaps(base: IconMaps, variant?: IconMaps): IconMaps {
	const pick = <K extends keyof IconMaps>(k: K) => variant?.[k] ?? base[k];
	const merge = (k: 'fileExtensions' | 'fileNames' | 'folderNames' | 'folderNamesExpanded' | 'languageIds') => ({
		...lower(base[k]),
		...lower(variant?.[k]),
	});
	return {
		file: pick('file'),
		folder: pick('folder'),
		folderExpanded: pick('folderExpanded'),
		rootFolder: pick('rootFolder'),
		rootFolderExpanded: pick('rootFolderExpanded'),
		fileExtensions: merge('fileExtensions'),
		fileNames: merge('fileNames'),
		folderNames: merge('folderNames'),
		folderNamesExpanded: merge('folderNamesExpanded'),
		languageIds: { ...(base.languageIds ?? {}), ...(variant?.languageIds ?? {}) },
	};
}

