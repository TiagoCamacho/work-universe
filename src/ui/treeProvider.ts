import * as vscode from 'vscode';
import { UniverseStore } from '../model/store';
import { Universe, Workspace } from '../model/types';
import { Switcher } from '../universe/switcher';

export type UniverseNode = { type: 'universe'; universe: Universe };
export type WorkspaceNode = { type: 'workspace'; universe: Universe; workspace: Workspace };
export type Node = UniverseNode | WorkspaceNode;

export const DEFAULT_WORKSPACE_ICON = 'folder';

/** Last two path segments, e.g. `my-app/backend`. */
export function shortPath(uri: vscode.Uri): string {
	const parts = uri.path.split('/').filter(Boolean);
	return parts.slice(-2).join('/');
}

export class UniverseTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly store: UniverseStore,
		private readonly switcher: Switcher,
	) {
		this.disposables.push(
			this._onDidChangeTreeData,
			store.onDidChange(() => this._onDidChangeTreeData.fire()),
			switcher.onDidChangeState(() => this._onDidChangeTreeData.fire()),
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	getChildren(element?: Node): Node[] {
		if (!element) {
			return this.store.getUniverses().map(universe => ({ type: 'universe', universe }));
		}
		if (element.type === 'universe') {
			// Re-read so children reflect the latest store state.
			const universe = this.store.getUniverse(element.universe.id) ?? element.universe;
			return universe.workspaces.map(workspace => ({ type: 'workspace', universe, workspace }));
		}
		return [];
	}

	getTreeItem(element: Node): vscode.TreeItem {
		const state = this.switcher.getWindowState();
		const isCurrent = state.universe?.id === element.universe.id;

		if (element.type === 'universe') {
			const { universe } = element;
			const item = new vscode.TreeItem(universe.name, vscode.TreeItemCollapsibleState.Expanded);
			item.id = 'u:' + universe.id;
			item.contextValue = isCurrent ? 'universe-current' : 'universe';
			item.iconPath = new vscode.ThemeIcon(isCurrent ? 'globe' : 'circle-large-outline');
			const count = `${universe.workspaces.length} workspace${universe.workspaces.length === 1 ? '' : 's'}`;
			item.description = isCurrent ? (state.allMode ? 'this window · all loaded' : 'this window') : count;
			item.tooltip = new vscode.MarkdownString(`**${universe.name}**\n\n${count}`);
			return item;
		}

		const { workspace } = element;
		const isActive = isCurrent && state.activeIds.includes(workspace.id);
		const uri = vscode.Uri.parse(workspace.uri);
		const item = new vscode.TreeItem(workspace.name, vscode.TreeItemCollapsibleState.None);
		item.id = 'w:' + workspace.id;
		item.contextValue = isActive ? 'workspace-active' : 'workspace';
		item.iconPath = new vscode.ThemeIcon(
			workspace.icon ?? DEFAULT_WORKSPACE_ICON,
			isActive ? new vscode.ThemeColor('charts.green') : undefined,
		);
		item.description = isActive ? (state.allMode ? 'loaded' : '● active') : shortPath(uri);
		item.tooltip = new vscode.MarkdownString(
			`**${workspace.name}**\n\n\`${uri.scheme === 'file' ? uri.fsPath : workspace.uri}\`` +
				(workspace.color ? `\n\nColor: ${workspace.color}` : ''),
		);
		item.command = {
			command: 'workUniverse.switchWorkspace',
			title: 'Switch to Workspace',
			arguments: [element],
		};
		return item;
	}
}
