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

export interface RestoreOptions {
	/** Runs once the first restored editor is showing (or right away if there is nothing to restore). */
	onFirstShown?: () => Promise<void> | void;
	/**
	 * Awaited after the active editors are showing and before the remaining tabs are added, so
	 * those tabs don't compete with more urgent work.
	 */
	beforeBackground?: () => Promise<unknown> | void;
	/** Checked between tabs; returning true stops the restore early. */
	isCancelled?: () => boolean;
}

/** `background` is honoured by the `vscode.open` / `vscode.diff` commands but missing from the typings. */
type OpenOptions = vscode.TextDocumentShowOptions & { background?: boolean };

function openOptions(tab: SavedTab, viewColumn: number, background: boolean): OpenOptions {
	const options: OpenOptions = { viewColumn, preview: false, preserveFocus: background, background };
	if (tab.selection && !background) {
		const [sl, sc, el, ec] = tab.selection;
		options.selection = new vscode.Range(sl, sc, el, ec);
	}
	return options;
}

async function openTab(tab: SavedTab, viewColumn: number, background: boolean): Promise<boolean> {
	const uri = vscode.Uri.parse(tab.uri);
	try {
		if (tab.kind === 'diff' && tab.originalUri) {
			await vscode.commands.executeCommand(
				'vscode.diff',
				vscode.Uri.parse(tab.originalUri),
				uri,
				tab.label,
				openOptions(tab, viewColumn, background),
			);
		} else {
			await vscode.commands.executeCommand('vscode.open', uri, openOptions(tab, viewColumn, background));
		}
		return true;
	} catch {
		return false;
	}
}

async function fileExists(tab: SavedTab): Promise<boolean> {
	const uri = vscode.Uri.parse(tab.uri);
	if (uri.scheme !== 'file') {
		return true;
	}
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false; // deleted meanwhile
	}
}

/**
 * Re-opens a captured session: same groups, order, pinned state, active tab and cursor.
 *
 * Built for a fast first paint: each group's active tab opens first, in the foreground. After
 * `beforeBackground` (if given) the other tabs are added as background tabs (no editor is
 * activated for them), and the active tab is moved to its saved position. Returns false if the
 * restore was cancelled part-way.
 */
export async function restoreTabs(session: TabSession | undefined, options: RestoreOptions = {}): Promise<boolean> {
	const cancelled = () => options.isCancelled?.() ?? false;
	const saved = (session?.groups ?? []).filter(g => g.tabs.length);
	if (!saved.length) {
		await options.onFirstShown?.();
		return true;
	}

	// Every file is checked at once (deleted files are skipped). The checks run while the first
	// editor opens: only the tab about to be opened has to wait for its own check.
	const checks = new Map<SavedTab, Promise<boolean>>();
	for (const tab of saved.flatMap(g => g.tabs)) {
		checks.set(tab, fileExists(tab));
	}
	const existingOf = async (tabs: SavedTab[]) => {
		const flags = await Promise.all(tabs.map(t => checks.get(t)!));
		return tabs.filter((_, i) => flags[i]);
	};

	// The focused group goes first so its active editor is what the user sees first.
	const focusedGroup = saved.find(g => g.isActive) ?? saved[0];
	const groups = [focusedGroup, ...saved.filter(g => g !== focusedGroup).sort((a, b) => a.viewColumn - b.viewColumn)];
	// Where VS Code inserts a newly opened tab relative to the active one.
	const positioning = vscode.workspace.getConfiguration('workbench.editor').get<string>('openPositioning', 'right');
	const insertsBeforeActive = positioning === 'left' || positioning === 'first';

	// Phase 1: every group's active editor, the focused group first. This is what the user sees.
	const shown: { group: SavedGroup; active: SavedTab }[] = [];
	for (const group of groups) {
		let active: SavedTab | undefined = group.tabs.find(t => t.isActive) ?? group.tabs[0];
		if (!(await checks.get(active)!)) {
			// The saved active file is gone: fall back to the first one that still exists.
			active = (await existingOf(group.tabs))[0];
		}
		if (!active) {
			continue;
		}
		if (cancelled()) {
			return false;
		}
		await openTab(active, group.viewColumn, false);
		shown.push({ group, active });
		if (shown.length === 1) {
			await options.onFirstShown?.();
		}
	}
	if (!shown.length) {
		await options.onFirstShown?.();
		return !cancelled();
	}
	const refocus = async () => {
		// Opening other groups' editors moved the focus; put it back on the saved group.
		if (shown.length > 1 && !cancelled()) {
			await openTab(shown[0].active, shown[0].group.viewColumn, false);
		}
	};
	await refocus();

	// Phase 2: let the caller's heavier work (VS Code's folder change) finish undisturbed.
	await options.beforeBackground?.();

	// Phase 3: the remaining tabs, added in the background, group by group.
	for (const { group, active } of shown) {
		if (cancelled()) {
			return false;
		}
		if (shown.length > 1) {
			// Moving and pinning act on the focused editor, so this group needs the focus.
			await openTab(active, group.viewColumn, false);
		}
		const tabs = await existingOf(group.tabs);

		// Pinned tabs are handled further down: pinning needs a foreground open and moves them to the front.
		const others = tabs.filter(t => t !== active && !t.isPinned);
		// 'right' and 'first' insert next to a fixed spot, so the last one opened ends up first.
		const order = positioning === 'right' || positioning === 'first' ? [...others].reverse() : others;
		// One at a time: opening them all at once was measured and is no faster overall (VS Code
		// does the work on one thread), and it would make the tab order depend on timing.
		for (const tab of order) {
			if (cancelled()) {
				return false;
			}
			await openTab(tab, group.viewColumn, true);
		}

		// The active tab now sits before (or after) all the others; move it to its saved place.
		if (!active.isPinned) {
			const before = others.filter(t => tabs.indexOf(t) < tabs.indexOf(active)).length;
			const steps = insertsBeforeActive ? others.length - before : before;
			if (steps > 0) {
				await vscode.commands.executeCommand('moveActiveEditor', {
					to: insertsBeforeActive ? 'left' : 'right',
					by: 'tab',
					value: steps,
				});
			}
		}

		// Pinning only works on the active editor, so pinned tabs need a foreground open each.
		let pinnedAny = false;
		for (const tab of tabs.filter(t => t.isPinned)) {
			if (cancelled()) {
				return false;
			}
			if (await openTab(tab, group.viewColumn, false)) {
				await vscode.commands.executeCommand('workbench.action.pinEditor');
				pinnedAny = true;
			}
		}
		if (pinnedAny && !cancelled()) {
			await openTab(active, group.viewColumn, false);
		}
	}
	await refocus();
	return !cancelled();
}
