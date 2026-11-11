import * as vscode from 'vscode';
import { Universe, Workspace } from '../model/types';
import { sameUri } from './paths';

export const ANCHOR_PREFIX = '◈ ';
const WORKSPACE_FILE_NAME = 'universe.code-workspace';

/** Settings placed inside the anchor folder so it looks empty and is never searched. */
export const ANCHOR_SETTINGS = {
	'files.exclude': { '**': true },
	'search.exclude': { '**': true },
	'files.watcherExclude': { '**': true },
};

export interface WorkspaceFileJson {
	folders: { path?: string; uri?: string; name?: string }[];
	settings?: Record<string, unknown>;
}

/** Locates the generated files of each universe below the extension's global storage. */
export class UniverseFiles {
	constructor(private readonly storageRoot: vscode.Uri) {}

	dir(universeId: string): vscode.Uri {
		return vscode.Uri.joinPath(this.storageRoot, 'universes', universeId);
	}

	anchor(universeId: string): vscode.Uri {
		return vscode.Uri.joinPath(this.dir(universeId), 'anchor');
	}

	workspaceFile(universeId: string): vscode.Uri {
		return vscode.Uri.joinPath(this.dir(universeId), WORKSPACE_FILE_NAME);
	}

	/** If `file` is a generated universe workspace file, returns that universe's id. */
	universeIdOf(file: vscode.Uri | undefined, universes: readonly Universe[]): string | undefined {
		if (!file || file.scheme === 'untitled') {
			return undefined;
		}
		return universes.find(u => sameUri(this.workspaceFile(u.id), file))?.id;
	}

	anchorName(universe: Universe): string {
		return ANCHOR_PREFIX + universe.name;
	}

	async exists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	/** Makes sure the anchor folder and its settings exist. */
	async ensureAnchor(universeId: string): Promise<void> {
		const settingsUri = vscode.Uri.joinPath(this.anchor(universeId), '.vscode', 'settings.json');
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.anchor(universeId), '.vscode'));
		await writeJson(settingsUri, ANCHOR_SETTINGS);
	}

	/**
	 * Writes the universe's .code-workspace file: the anchor at index 0, then the given folders.
	 * `settings` from an existing file are preserved.
	 */
	async writeWorkspaceFile(universe: Universe, folders: Workspace[]): Promise<vscode.Uri> {
		await this.ensureAnchor(universe.id);
		const file = this.workspaceFile(universe.id);
		const existing = await readJson<WorkspaceFileJson>(file);
		const json = buildWorkspaceJson(this.anchor(universe.id), this.anchorName(universe), folders, existing?.settings);
		await writeJson(file, json);
		return file;
	}

	/** Creates the workspace file if missing; otherwise leaves it alone (VS Code owns it while open). */
	async ensureWorkspaceFile(universe: Universe, initial: Workspace[]): Promise<vscode.Uri> {
		const file = this.workspaceFile(universe.id);
		await this.ensureAnchor(universe.id);
		if (!(await this.exists(file))) {
			await this.writeWorkspaceFile(universe, initial);
		}
		return file;
	}

	/** Updates the anchor's display name in a workspace file that is not open in this window. */
	async renameAnchor(universe: Universe): Promise<void> {
		const file = this.workspaceFile(universe.id);
		const json = await readJson<WorkspaceFileJson>(file);
		if (json?.folders?.length) {
			json.folders[0].name = this.anchorName(universe);
			await writeJson(file, json);
		}
	}

	/** Deletes generated folders of universes that no longer exist (except `keepId`). */
	async cleanupOrphans(knownIds: readonly string[], keepId?: string): Promise<void> {
		const root = vscode.Uri.joinPath(this.storageRoot, 'universes');
		let entries: [string, vscode.FileType][] = [];
		try {
			entries = await vscode.workspace.fs.readDirectory(root);
		} catch {
			return;
		}
		for (const [name, type] of entries) {
			if (type === vscode.FileType.Directory && !knownIds.includes(name) && name !== keepId) {
				await this.deleteUniverseFiles(name);
			}
		}
	}

	async deleteUniverseFiles(universeId: string): Promise<void> {
		try {
			await vscode.workspace.fs.delete(this.dir(universeId), { recursive: true, useTrash: false });
		} catch {
			// already gone
		}
	}
}

export function buildWorkspaceJson(
	anchor: vscode.Uri,
	anchorName: string,
	folders: Workspace[],
	settings?: Record<string, unknown>,
): WorkspaceFileJson {
	return {
		folders: [
			{ path: anchor.fsPath, name: anchorName },
			...folders.map(ws => {
				const uri = vscode.Uri.parse(ws.uri);
				return uri.scheme === 'file' ? { path: uri.fsPath, name: ws.name } : { uri: ws.uri, name: ws.name };
			}),
		],
		settings: settings ?? {},
	};
}

async function readJson<T>(uri: vscode.Uri): Promise<T | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return JSON.parse(new TextDecoder().decode(bytes)) as T;
	} catch {
		return undefined;
	}
}

async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(value, null, '\t') + '\n'));
}
