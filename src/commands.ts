import * as path from 'path';
import * as vscode from 'vscode';
import { ActionStore } from './actions/actionStore';
import { actionsFromScripts, guessIcon, isSafeScriptName, readScripts } from './actions/scripts';
import { CustomAction } from './actions/types';
import { UniverseStore } from './model/store';
import { Universe, UniverseMode } from './model/types';
import { findSolutionFiles } from './solution/solutionModel';
import { isInside, sameUri } from './universe/paths';
import { Switcher } from './universe/switcher';
import { pickColor, pickIcon, pickUniverse, pickWorkspace, showQuickSwitch } from './ui/quickPick';
import { Node, UniverseNode, WorkspaceNode } from './ui/util';

/** Asks whether a universe keeps its projects separate or all loaded together. */
async function pickMode(current: UniverseMode, placeHolder: string): Promise<UniverseMode | undefined> {
	const mark = (mode: UniverseMode) => (mode === current ? '  $(check) current' : '');
	const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { mode: UniverseMode }>(
		[
			{
				label: '$(lock) Separate environments',
				description: mark('isolated'),
				detail: 'Only the active project is loaded. Search, Source Control and the Explorer show just that project. Each switch changes the folders of the window.',
				mode: 'isolated',
			},
			{
				label: '$(layers) All together',
				description: mark('together'),
				detail: 'Every project stays loaded, so switching is faster. Ctrl+Shift+F is scoped to the active project; quick open, Source Control and the Explorer show all projects.',
				mode: 'together',
			},
		],
		{ placeHolder },
	);
	return picked?.mode;
}

/**
 * Asks which solution of `folder` the panel should show. Returns the solution, `null` for the
 * plain folder view, or `undefined` if cancelled. With `ifAny`, returns `null` without asking when
 * the folder contains no solution.
 */
async function pickSolution(
	folder: vscode.Uri,
	name: string,
	options: { current?: string; ifAny?: boolean } = {},
): Promise<vscode.Uri | null | undefined> {
	const found = await findSolutionFiles(folder);
	if (!found.length && options.ifAny) {
		return null;
	}
	const mark = (uri?: vscode.Uri) => ((uri ? options.current === uri.toString() : !options.current) ? '  $(check) current' : '');
	type Item = vscode.QuickPickItem & { solution?: vscode.Uri | null };
	const items: Item[] = [
		...found.map(uri => ({
			label: `$(library) ${path.posix.basename(uri.path)}`,
			description: (path.posix.relative(folder.path, path.posix.dirname(uri.path)) || '.') + mark(uri),
			detail: 'Show like the Solution Explorer of Visual Studio',
			solution: uri,
		})),
		{ label: '$(folder) Plain folder view', description: mark(), detail: 'Show the folder\'s files as they are on disk', solution: null },
		{ label: '$(folder-opened) Browse for a solution file…', alwaysShow: true },
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: `Solution view for "${name}"`,
		placeHolder: found.length ? 'This folder contains a Visual Studio solution. How should it be shown?' : 'No solution found in this folder',
	});
	if (!picked) {
		return undefined;
	}
	if (picked.solution !== undefined) {
		return picked.solution;
	}
	const chosen = await vscode.window.showOpenDialog({
		defaultUri: folder,
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		openLabel: 'Use Solution',
		filters: { 'Visual Studio Solution': ['sln', 'slnx'] },
	});
	if (!chosen?.[0]) {
		return undefined;
	}
	if (!isInside(chosen[0], folder)) {
		vscode.window.showWarningMessage(`Work Universe: the solution must be inside "${folder.fsPath}".`);
		return undefined;
	}
	return chosen[0];
}

export function registerCommands(
	context: vscode.ExtensionContext,
	store: UniverseStore,
	switcher: Switcher,
	actions: ActionStore,
): void {
	const files = switcher.files;

	// Commands are run from several places (panel menus, tab right-click, command palette, other
	// code) and each passes a different argument, or VS Code's own context object. So arguments are
	// only used when they really identify a universe or workspace; anything else is ignored.

	const universeFromArg = (arg: unknown): Universe | undefined => {
		const id = (arg as { universe?: { id?: unknown } } | undefined)?.universe?.id;
		return typeof id === 'string' ? store.getUniverse(id) : undefined;
	};

	/** The universe a command acts on: the one passed in, else the one open in this window, else a pick. */
	const resolveUniverse = async (arg?: unknown): Promise<Universe | undefined> => {
		const currentId = switcher.currentUniverseId();
		return (
			universeFromArg(arg) ??
			(currentId ? store.getUniverse(currentId) : undefined) ??
			pickUniverse(store, 'Pick a universe')
		);
	};

	const workspaceFromArg = (arg: unknown) => {
		const a = arg as { workspaceId?: unknown; type?: unknown; workspace?: { id?: unknown } } | undefined;
		const id =
			typeof arg === 'string'
				? arg
				: typeof a?.workspaceId === 'string'
					? a.workspaceId // right-click on a tab or action button of the panel
					: a?.type === 'workspace' && typeof a.workspace?.id === 'string'
						? a.workspace.id
						: undefined;
		return id ? store.findWorkspace(id) : undefined;
	};

	/** The workspace a command acts on: the one passed in, else a pick. */
	const resolveWorkspace = async (arg?: unknown) => workspaceFromArg(arg) ?? pickWorkspace(store, 'Pick a workspace');

	/** Like `resolveWorkspace`, but defaults to the active workspace before asking. */
	const resolveWorkspaceOrActive = async (arg?: unknown) =>
		workspaceFromArg(arg) ?? switcher.activeWorkspace() ?? pickWorkspace(store, 'Pick a workspace');

	const addWorkspace = async (node?: UniverseNode): Promise<void> => {
		const universe = await resolveUniverse(node);
		if (!universe) {
			return;
		}
		const isCurrent = switcher.currentUniverseId() === universe.id;
		const candidates = isCurrent
			? []
			: (vscode.workspace.workspaceFolders ?? []).filter(
					f => !universe.workspaces.some(w => sameUri(w.uri, f.uri)),
				);

		let folders: { uri: vscode.Uri; name: string; solution?: vscode.Uri }[] = [];
		const browse = async () =>
			(
				(await vscode.window.showOpenDialog({
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: true,
					openLabel: `Add to ${universe.name}`,
				})) ?? []
			).map(uri => ({ uri, name: path.basename(uri.fsPath) || uri.path }));

		if (candidates.length) {
			type Item = vscode.QuickPickItem & { folder?: vscode.WorkspaceFolder };
			const items: Item[] = [
				...candidates.map(folder => ({ label: `$(folder) ${folder.name}`, description: folder.uri.fsPath, picked: true, folder })),
				{ label: '$(folder-opened) Browse for other folders…', alwaysShow: true },
			];
			const picked = await vscode.window.showQuickPick(items, {
				canPickMany: true,
				placeHolder: `Folders to add to "${universe.name}"`,
			});
			if (!picked) {
				return;
			}
			folders = picked.filter(i => i.folder).map(i => ({ uri: i.folder!.uri, name: i.folder!.name }));
			if (picked.some(i => !i.folder)) {
				folders.push(...(await browse()));
			}
		} else {
			folders = await browse();
		}
		if (!folders.length) {
			return;
		}
		// Folders with a Visual Studio solution can be shown like Visual Studio's Solution Explorer.
		for (const folder of folders) {
			if (universe.workspaces.some(w => sameUri(w.uri, folder.uri))) {
				continue;
			}
			const solution = await pickSolution(folder.uri, folder.name, { ifAny: true });
			if (solution) {
				folder.solution = solution;
			}
		}

		const added = await store.addWorkspaces(universe.id, folders);
		if (!added.length) {
			vscode.window.showInformationMessage('Work Universe: those folders are already in this universe.');
			return;
		}
		if (isCurrent) {
			// Adding from the "+" tab jumps straight to the new workspace.
			await switcher.switchTo(added[0].id);
		} else {
			const open = await vscode.window.showInformationMessage(
				`Added ${added.map(w => w.name).join(', ')} to "${universe.name}". Open the universe in this window now?`,
				'Open Universe',
			);
			if (open) {
				await switcher.switchTo(added[0].id);
			}
		}
	};

	const register = (id: string, fn: (...args: any[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	register('workUniverse.createUniverse', async () => {
		const name = await vscode.window.showInputBox({
			title: 'Create Universe',
			prompt: 'Name for the new universe (e.g. "My Product")',
			validateInput: v => (v.trim() ? undefined : 'Enter a name'),
		});
		if (!name) {
			return;
		}
		const mode = await pickMode('isolated', 'How should this universe work? (you can change it later)');
		if (!mode) {
			return;
		}
		const universe = await store.createUniverse(name.trim());
		await switcher.setMode(universe.id, mode);
		await addWorkspace({ type: 'universe', universe });
	});

	register('workUniverse.setUniverseMode', async (node?: unknown) => {
		const universe = await resolveUniverse(node);
		if (!universe) {
			return;
		}
		const current = universe.mode ?? 'isolated';
		const mode = await pickMode(current, `Mode of "${universe.name}"`);
		if (mode && mode !== current) {
			await switcher.setMode(universe.id, mode);
			vscode.window.showInformationMessage(
				mode === 'together'
					? `"${universe.name}" now keeps all its projects loaded together.`
					: `"${universe.name}" now keeps its projects in separate environments.`,
			);
		}
	});

	register('workUniverse.searchWorkspace', () => switcher.searchActive());

	register('workUniverse.addWorkspace', (node?: UniverseNode) => addWorkspace(node));

	register('workUniverse.renameUniverse', async (node?: UniverseNode) => {
		const universe = await resolveUniverse(node);
		if (!universe) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: 'Rename Universe',
			value: universe.name,
			validateInput: v => (v.trim() ? undefined : 'Enter a name'),
		});
		if (!name || name.trim() === universe.name) {
			return;
		}
		const updated = await store.updateUniverse(universe.id, u => (u.name = name.trim()));
		if (!updated) {
			return;
		}
		if (switcher.currentUniverseId() === universe.id) {
			// Renaming folder 0 in place would restart every extension, so defer it to the next open.
			vscode.window.showInformationMessage('Work Universe: the explorer header will show the new name the next time this universe is opened.');
		} else {
			await files.renameAnchor(updated);
		}
	});

	register('workUniverse.deleteUniverse', async (node?: UniverseNode) => {
		const universe = await resolveUniverse(node);
		if (!universe) {
			return;
		}
		const isCurrent = switcher.currentUniverseId() === universe.id;
		const choice = await vscode.window.showWarningMessage(
			`Delete universe "${universe.name}"?`,
			{
				modal: true,
				detail:
					'Your project folders are not touched; only the universe definition and its saved tabs are removed.' +
					(isCurrent ? '\n\nThis window will close the universe.' : ''),
			},
			'Delete',
		);
		if (choice !== 'Delete') {
			return;
		}
		await store.deleteUniverse(universe.id);
		await Promise.all(universe.workspaces.map(w => actions.delete(w.id)));
		if (isCurrent) {
			// Files are cleaned up on the next activation, once nothing has them open.
			await vscode.commands.executeCommand('workbench.action.closeFolder');
		} else {
			await files.deleteUniverseFiles(universe.id);
		}
	});

	register('workUniverse.removeWorkspace', async (node?: WorkspaceNode) => {
		const found = await resolveWorkspace(node);
		if (!found) {
			return;
		}
		const { universe, workspace } = found;
		const state = switcher.getWindowState();
		if (state.universe?.id === universe.id && state.activeIds.includes(workspace.id)) {
			const other = universe.workspaces.find(w => w.id !== workspace.id);
			if (!other) {
				vscode.window.showWarningMessage(
					`Work Universe: "${workspace.name}" is the only workspace open in this universe. Add another one first, or delete the universe.`,
				);
				return;
			}
			await switcher.switchTo(other.id);
			if (switcher.getWindowState().activeIds.includes(workspace.id)) {
				return; // switch was cancelled
			}
		}
		await store.removeWorkspace(workspace.id);
		await actions.delete(workspace.id);
	});

	register('workUniverse.renameWorkspace', async (node?: WorkspaceNode) => {
		const found = await resolveWorkspace(node);
		if (!found) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: 'Rename Workspace',
			value: found.workspace.name,
			validateInput: v => (v.trim() ? undefined : 'Enter a name'),
		});
		if (!name) {
			return;
		}
		await store.updateWorkspace(found.workspace.id, w => (w.name = name.trim()));
		await switcher.refreshFolderNames();
	});

	register('workUniverse.setWorkspaceIcon', async (node?: WorkspaceNode) => {
		const found = await resolveWorkspace(node);
		if (!found) {
			return;
		}
		const icon = await pickIcon(found.workspace.icon);
		if (icon) {
			await store.updateWorkspace(found.workspace.id, w => (w.icon = icon));
		}
	});

	register('workUniverse.setWorkspaceColor', async (node?: WorkspaceNode) => {
		const found = await resolveWorkspace(node);
		if (!found) {
			return;
		}
		const color = await pickColor(found.workspace.color);
		if (color === undefined) {
			return;
		}
		await store.updateWorkspace(found.workspace.id, w => (w.color = color ?? undefined));
		await switcher.refreshColor();
	});

	register('workUniverse.setWorkspaceSolution', async (node?: WorkspaceNode) => {
		const found = await resolveWorkspaceOrActive(node);
		if (!found) {
			return;
		}
		const { workspace } = found;
		const solution = await pickSolution(vscode.Uri.parse(workspace.uri), workspace.name, { current: workspace.solution });
		if (solution === undefined) {
			return;
		}
		await store.updateWorkspace(workspace.id, w => {
			if (solution) {
				w.solution = solution.toString();
			} else {
				delete w.solution;
			}
		});
	});

	register('workUniverse.switchWorkspace', async (node?: WorkspaceNode | string) => {
		const found = await resolveWorkspace(node);
		if (found) {
			await switcher.switchTo(found.workspace.id);
		}
	});

	register('workUniverse.quickSwitch', () => showQuickSwitch(store, switcher));
	register('workUniverse.nextWorkspace', () => switcher.cycle(1));
	register('workUniverse.previousWorkspace', () => switcher.cycle(-1));

	register('workUniverse.searchUniverse', async (node?: unknown) => {
		const universe = await resolveUniverse(node);
		if (universe) {
			await switcher.showAll(universe.id);
		}
	});

	register('workUniverse.repairUniverse', () => switcher.repair());

	register('workUniverse.setCustomActions', async (arg?: Node | string | { workspaceId?: string }) => {
		const found = await resolveWorkspaceOrActive(arg);
		if (!found) {
			return;
		}
		const { workspace } = found;
		if (!(await actions.exists(workspace.id))) {
			const folder = vscode.Uri.parse(workspace.uri);
			const allScripts = Object.keys(await readScripts(folder));
			// Names that could smuggle a second command into the shell are not offered.
			const scripts = allScripts.filter(isSafeScriptName);
			if (scripts.length < allScripts.length) {
				vscode.window.showWarningMessage(
					`Work Universe: ${allScripts.length - scripts.length} package.json script(s) were skipped because their names contain unusual characters.`,
				);
			}
			let initial: CustomAction[] = [];
			if (scripts.length) {
				type Item = vscode.QuickPickItem & { script: string };
				const picked = await vscode.window.showQuickPick<Item>(
					scripts.map(script => ({ label: `$(${guessIcon(script)}) ${script}`, description: 'package.json script', picked: true, script })),
					{
						canPickMany: true,
						title: `Custom actions for ${workspace.name}`,
						placeHolder: 'Create buttons for these package.json scripts (uncheck all to start empty)',
					},
				);
				if (!picked) {
					return;
				}
				initial = await actionsFromScripts(folder, picked.map(p => p.script));
			}
			if (!initial.length) {
				initial = [{ label: 'Example', icon: 'play', command: 'echo "Edit me in this file"' }];
			}
			await actions.write(workspace.id, workspace.name, initial);
		}
		const doc = await vscode.workspace.openTextDocument(actions.fileFor(workspace.id));
		await vscode.window.showTextDocument(doc, { preview: false });
		vscode.window.setStatusBarMessage(`Work Universe: editing actions of "${workspace.name}". Save to update the buttons.`, 6000);
	});

	register('workUniverse.removeAllActions', async (arg?: Node | string | { workspaceId?: string }) => {
		const found = await resolveWorkspaceOrActive(arg);
		if (!found) {
			return;
		}
		const { workspace } = found;
		const count = (await actions.get(workspace.id)).actions.length;
		if (!(await actions.exists(workspace.id))) {
			vscode.window.showInformationMessage(`Work Universe: "${workspace.name}" has no custom actions.`);
			return;
		}
		const choice = await vscode.window.showWarningMessage(
			`Remove all ${count} custom action${count === 1 ? '' : 's'} of "${workspace.name}"?`,
			{ modal: true, detail: 'The buttons and their configuration file are deleted. Terminals that are already running keep running.' },
			'Remove All',
		);
		if (choice !== 'Remove All') {
			return;
		}
		// Close the actions file if it's open, so it doesn't linger as a deleted file.
		const file = actions.fileFor(workspace.id);
		const openTabs = vscode.window.tabGroups.all
			.flatMap(g => g.tabs)
			.filter(t => t.input instanceof vscode.TabInputText && sameUri(t.input.uri, file));
		if (openTabs.length) {
			await vscode.window.tabGroups.close(openTabs, true);
		}
		await actions.delete(workspace.id);
	});
}
