import * as vscode from 'vscode';
import { SavedGroup, SavedTab, TabSession } from '../model/types';
import { isInsideAny, sameUri } from './paths';

export interface CaptureResult {
	session: TabSession;
	/** Tabs belonging to the folders, i.e. candidates for closing. */
	tabs: vscode.Tab[];
	/** Subset of `tabs` with unsaved changes. */
	dirty: vscode.Tab[];
}

/** Primary URI used to decide which folder a tab belongs to. */
export function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
	const input = tab.input;
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook || input instanceof vscode.TabInputCustom) {
		return input.uri;
	}
	if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
		return input.modified;
	}
	return undefined;
}

function toSavedTab(tab: vscode.Tab, viewColumn: number): SavedTab | undefined {
	const input = tab.input;
	let saved: SavedTab | undefined;
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
		saved = { kind: 'text', uri: input.uri.toString(), isPinned: tab.isPinned, isActive: tab.isActive };
	} else if (input instanceof vscode.TabInputNotebook) {
		saved = { kind: 'notebook', uri: input.uri.toString(), isPinned: tab.isPinned, isActive: tab.isActive };
	} else if (input instanceof vscode.TabInputTextDiff) {
		saved = {
			kind: 'diff',
			uri: input.modified.toString(),
			originalUri: input.original.toString(),
			label: tab.label,
			isPinned: tab.isPinned,
			isActive: tab.isActive,
		};
	}
	if (saved && saved.kind === 'text') {
		const editor = vscode.window.visibleTextEditors.find(
			e => e.viewColumn === viewColumn && sameUri(e.document.uri, saved!.uri),
		);
		if (editor) {
			const s = editor.selection;
			saved.selection = [s.start.line, s.start.character, s.end.line, s.end.character];
		}
	}
	return saved;
}

/** Records every editor tab whose resource lives inside one of `folders`. */
export function captureTabs(folders: readonly vscode.Uri[]): CaptureResult {
	const groups: SavedGroup[] = [];
	const tabs: vscode.Tab[] = [];
	const dirty: vscode.Tab[] = [];
	for (const group of vscode.window.tabGroups.all) {
		const saved: SavedGroup = { viewColumn: group.viewColumn, isActive: group.isActive, tabs: [] };
		for (const tab of group.tabs) {
			const uri = tabUri(tab);
			if (!uri || !isInsideAny(uri, folders)) {
				continue;
			}
			tabs.push(tab);
			if (tab.isDirty) {
				dirty.push(tab);
			}
			const savedTab = toSavedTab(tab, group.viewColumn);
			if (savedTab) {
				saved.tabs.push(savedTab);
			}
		}
		if (saved.tabs.length) {
			groups.push(saved);
		}
	}
	return { session: { groups }, tabs, dirty };
}

export async function closeTabs(tabs: readonly vscode.Tab[]): Promise<void> {
	if (tabs.length) {
		// preserveFocus=true keeps the focused group stable while closing.
		await vscode.window.tabGroups.close(tabs as vscode.Tab[], true);
	}
}

function showOptions(tab: SavedTab, viewColumn: number, preserveFocus: boolean): vscode.TextDocumentShowOptions {
	const options: vscode.TextDocumentShowOptions = { viewColumn, preview: false, preserveFocus };
	if (tab.selection) {
		const [sl, sc, el, ec] = tab.selection;
		options.selection = new vscode.Range(sl, sc, el, ec);
	}
	return options;
}

async function openTab(tab: SavedTab, viewColumn: number, preserveFocus: boolean): Promise<boolean> {
	const uri = vscode.Uri.parse(tab.uri);
	try {
		if (uri.scheme === 'file') {
			await vscode.workspace.fs.stat(uri); // skip files that were deleted meanwhile
		}
		if (tab.kind === 'diff' && tab.originalUri) {
			await vscode.commands.executeCommand(
				'vscode.diff',
				vscode.Uri.parse(tab.originalUri),
				uri,
				tab.label,
				showOptions(tab, viewColumn, preserveFocus),
			);
		} else {
			await vscode.commands.executeCommand('vscode.open', uri, showOptions(tab, viewColumn, preserveFocus));
		}
		return true;
	} catch {
		return false;
	}
}

/** Re-opens a captured session: same groups, order, pinned state, active tab and cursor. */
export async function restoreTabs(session: TabSession | undefined): Promise<void> {
	if (!session?.groups.length) {
		return;
	}
	const groups = [...session.groups].sort((a, b) => a.viewColumn - b.viewColumn);
	for (const group of groups) {
		for (const tab of group.tabs) {
			// Focus each tab while opening so pinning applies to the right editor.
			const opened = await openTab(tab, group.viewColumn, false);
			if (opened && tab.isPinned) {
				await vscode.commands.executeCommand('workbench.action.pinEditor');
			}
		}
		const active = group.tabs.find(t => t.isActive);
		if (active) {
			await openTab(active, group.viewColumn, false);
		}
	}
	const activeGroup = groups.find(g => g.isActive) ?? groups[0];
	const activeTab = activeGroup.tabs.find(t => t.isActive) ?? activeGroup.tabs[0];
	if (activeTab) {
		await openTab(activeTab, activeGroup.viewColumn, false);
	}
}
