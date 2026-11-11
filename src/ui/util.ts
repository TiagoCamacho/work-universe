import * as vscode from 'vscode';
import { Universe, Workspace } from '../model/types';

export const DEFAULT_WORKSPACE_ICON = 'folder';

/** Argument shapes commands accept besides ids. */
export type UniverseNode = { type: 'universe'; universe: Universe };
export type WorkspaceNode = { type: 'workspace'; universe: Universe; workspace: Workspace };
export type Node = UniverseNode | WorkspaceNode;

/** Last two path segments, e.g. `my-app/backend`. */
export function shortPath(uri: vscode.Uri): string {
	const parts = uri.path.split('/').filter(Boolean);
	return parts.slice(-2).join('/');
}

/** Parses JSON with comments and trailing commas (icon theme files are often JSONC). */
export function parseJsonc<T>(text: string): T {
	let out = '';
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const next = text[i + 1];
		if (inString) {
			out += c;
			if (c === '\\') {
				out += next ?? '';
				i++;
			} else if (c === '"') {
				inString = false;
			}
		} else if (c === '"') {
			inString = true;
			out += c;
		} else if (c === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
			out += '\n';
		} else if (c === '/' && next === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
				i++;
			}
			i++;
		} else {
			out += c;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as T;
}
