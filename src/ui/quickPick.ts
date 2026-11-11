import * as vscode from 'vscode';
import { UniverseStore } from '../model/store';
import { Universe, Workspace } from '../model/types';
import { Switcher } from '../universe/switcher';
import { PRESET_COLORS, isHexColor } from '../universe/theme';
import { DEFAULT_WORKSPACE_ICON, shortPath } from './treeProvider';

type SwitchItem = vscode.QuickPickItem & {
	action?: 'switch' | 'all' | 'create';
	universe?: Universe;
	workspace?: Workspace;
};

/** Every workspace of every universe; the current window's universe comes first. */
export async function showQuickSwitch(store: UniverseStore, switcher: Switcher): Promise<void> {
	const state = switcher.getWindowState();
	const universes = [...store.getUniverses()].sort((a, b) =>
		a.id === state.universe?.id ? -1 : b.id === state.universe?.id ? 1 : 0,
	);
	const items: SwitchItem[] = [];
	for (const universe of universes) {
		const isCurrent = universe.id === state.universe?.id;
		items.push({
			label: universe.name + (isCurrent ? ' (this window)' : ''),
			kind: vscode.QuickPickItemKind.Separator,
		});
		for (const workspace of universe.workspaces) {
			const isActive = isCurrent && !state.allMode && state.activeIds[0] === workspace.id;
			items.push({
				label: `$(${workspace.icon ?? DEFAULT_WORKSPACE_ICON}) ${workspace.name}`,
				description: isActive ? '$(check) active' : shortPath(vscode.Uri.parse(workspace.uri)),
				action: 'switch',
				universe,
				workspace,
			});
		}
		if (universe.workspaces.length > 1) {
			items.push({
				label: `$(search) Search whole "${universe.name}"`,
				description: isCurrent && state.allMode ? '$(check) active' : undefined,
				action: 'all',
				universe,
			});
		}
	}
	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	items.push({ label: '$(add) Create universe…', action: 'create' });

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Work Universe',
		placeHolder: 'Switch workspace',
		matchOnDescription: true,
	});
	if (!picked) {
		return;
	}
	if (picked.action === 'switch' && picked.workspace) {
		await switcher.switchTo(picked.workspace.id);
	} else if (picked.action === 'all' && picked.universe) {
		await switcher.showAll(picked.universe.id);
	} else if (picked.action === 'create') {
		await vscode.commands.executeCommand('workUniverse.createUniverse');
	}
}

export async function pickUniverse(store: UniverseStore, placeHolder: string, preferId?: string): Promise<Universe | undefined> {
	const universes = store.getUniverses();
	if (!universes.length) {
		vscode.window.showInformationMessage('Work Universe: create a universe first.');
		return undefined;
	}
	if (universes.length === 1) {
		return universes[0];
	}
	const sorted = [...universes].sort((a, b) => (a.id === preferId ? -1 : b.id === preferId ? 1 : 0));
	const picked = await vscode.window.showQuickPick(
		sorted.map(u => ({ label: u.name, description: `${u.workspaces.length} workspaces`, universe: u })),
		{ placeHolder },
	);
	return picked?.universe;
}

export async function pickWorkspace(store: UniverseStore, placeHolder: string): Promise<{ universe: Universe; workspace: Workspace } | undefined> {
	const items = store.getUniverses().flatMap(universe =>
		universe.workspaces.map(workspace => ({
			label: `$(${workspace.icon ?? DEFAULT_WORKSPACE_ICON}) ${workspace.name}`,
			description: universe.name,
			universe,
			workspace,
		})),
	);
	if (!items.length) {
		vscode.window.showInformationMessage('Work Universe: no workspaces yet.');
		return undefined;
	}
	return vscode.window.showQuickPick(items, { placeHolder });
}

const ICONS = [
	'folder', 'server', 'server-process', 'browser', 'globe', 'database', 'cloud', 'device-mobile',
	'device-desktop', 'library', 'package', 'tools', 'gear', 'beaker', 'book', 'rocket', 'game',
	'graph', 'terminal', 'code', 'symbol-class', 'shield', 'key', 'mail', 'heart', 'star-full',
	'flame', 'zap', 'bug', 'paintcan', 'notebook', 'organization',
];

export async function pickIcon(current?: string): Promise<string | undefined> {
	const picked = await vscode.window.showQuickPick(
		ICONS.map(icon => ({ label: `$(${icon}) ${icon}`, description: icon === current ? 'current' : undefined, icon })),
		{ placeHolder: 'Pick an icon for this workspace' },
	);
	return picked?.icon;
}

/** Returns a hex color, `null` to clear the color, or `undefined` if cancelled. */
export async function pickColor(current?: string): Promise<string | null | undefined> {
	type ColorItem = vscode.QuickPickItem & { value: string | null | 'custom' };
	const items: ColorItem[] = [
		...PRESET_COLORS.map(c => ({
			label: `$(circle-filled) ${c.label}`,
			description: c.hex + (c.hex === current ? ' · current' : ''),
			value: c.hex,
		})),
		{ label: '$(edit) Custom hex…', value: 'custom' },
		{ label: '$(circle-slash) No color', value: null },
	];
	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Pick a color for this workspace' });
	if (!picked) {
		return undefined;
	}
	if (picked.value !== 'custom') {
		return picked.value;
	}
	const hex = await vscode.window.showInputBox({
		prompt: 'Hex color, e.g. #1f6feb',
		value: current,
		validateInput: v => (isHexColor(v) ? undefined : 'Enter a color like #1f6feb or #abc'),
	});
	return hex?.trim();
}
