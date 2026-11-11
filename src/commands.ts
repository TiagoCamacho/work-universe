import * as path from 'path';
import * as vscode from 'vscode';
import { UniverseStore } from './model/store';
import { Universe } from './model/types';
import { sameUri } from './universe/paths';
import { Switcher } from './universe/switcher';
import { pickColor, pickIcon, pickUniverse, pickWorkspace, showQuickSwitch } from './ui/quickPick';
import { Node, UniverseNode, WorkspaceNode } from './ui/treeProvider';

export function registerCommands(context: vscode.ExtensionContext, store: UniverseStore, switcher: Switcher): void {
	const files = switcher.files;

	const resolveUniverse = async (node?: Node): Promise<Universe | undefined> => {
		if (node) {
			return store.getUniverse(node.universe.id);
		}
		const currentId = switcher.currentUniverseId();
		return pickUniverse(store, 'Pick a universe', currentId);
	};

	const resolveWorkspace = async (node?: Node | string) => {
		if (typeof node === 'string') {
			return store.findWorkspace(node);
		}
		if (node?.type === 'workspace') {
			return store.findWorkspace(node.workspace.id);
		}
		return pickWorkspace(store, 'Pick a workspace');
	};

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

		let folders: { uri: vscode.Uri; name: string }[] = [];
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

		const added = await store.addWorkspaces(universe.id, folders);
		if (!added.length) {
			vscode.window.showInformationMessage('Work Universe: those folders are already in this universe.');
			return;
		}
		if (!isCurrent) {
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
		const universe = await store.createUniverse(name.trim());
		await addWorkspace({ type: 'universe', universe });
	});

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

	register('workUniverse.switchWorkspace', async (node?: WorkspaceNode | string) => {
		const found = await resolveWorkspace(node);
		if (found) {
			await switcher.switchTo(found.workspace.id);
		}
	});

	register('workUniverse.quickSwitch', () => showQuickSwitch(store, switcher));
	register('workUniverse.nextWorkspace', () => switcher.cycle(1));
	register('workUniverse.previousWorkspace', () => switcher.cycle(-1));

	register('workUniverse.searchUniverse', async (node?: UniverseNode) => {
		const currentId = switcher.currentUniverseId();
		const universe = node
			? store.getUniverse(node.universe.id)
			: currentId
				? store.getUniverse(currentId)
				: await resolveUniverse();
		if (universe) {
			await switcher.showAll(universe.id);
		}
	});

	register('workUniverse.repairUniverse', () => switcher.repair());
	register('workUniverse.refresh', () => store.refresh());
}
