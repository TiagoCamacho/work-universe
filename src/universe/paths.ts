import * as vscode from 'vscode';

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

/** Normalized string key for comparing URIs (case-insensitive file paths on Windows/macOS). */
export function uriKey(uri: vscode.Uri | string): string {
	const u = typeof uri === 'string' ? vscode.Uri.parse(uri) : uri;
	let key = u.with({ query: '', fragment: '' }).toString();
	if (key.endsWith('/')) {
		key = key.slice(0, -1);
	}
	return u.scheme === 'file' && caseInsensitive ? key.toLowerCase() : key;
}

export function sameUri(a: vscode.Uri | string, b: vscode.Uri | string): boolean {
	return uriKey(a) === uriKey(b);
}

/** True if `child` is `folder` itself or lives somewhere below it. */
export function isInside(child: vscode.Uri | string, folder: vscode.Uri | string): boolean {
	const c = uriKey(child);
	const f = uriKey(folder);
	return c === f || c.startsWith(f + '/');
}

export function isInsideAny(child: vscode.Uri | string, folders: readonly (vscode.Uri | string)[]): boolean {
	return folders.some(f => isInside(child, f));
}
