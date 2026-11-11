import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { UniverseStore } from './model/store';
import { Switcher } from './universe/switcher';
import { UniverseFiles } from './universe/workspaceFile';
import { UniverseStatusBar } from './ui/statusBar';
import { UniverseTreeProvider } from './ui/treeProvider';

export interface WorkUniverseApi {
	store: UniverseStore;
	switcher: Switcher;
}

export async function activate(context: vscode.ExtensionContext): Promise<WorkUniverseApi> {
	const store = new UniverseStore(context.globalState);
	const files = new UniverseFiles(context.globalStorageUri);
	const switcher = new Switcher(store, files);
	const tree = new UniverseTreeProvider(store, switcher);
	const statusBar = new UniverseStatusBar(store, switcher);

	context.subscriptions.push(
		store,
		switcher,
		tree,
		statusBar,
		vscode.window.createTreeView('workUniverse.universes', { treeDataProvider: tree, showCollapseAll: true }),
		// Global state can be changed by other windows; re-read when this one regains focus.
		vscode.window.onDidChangeWindowState(e => e.focused && store.refresh()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workUniverse.applyColors')) {
				switcher.refreshColor();
			}
		}),
	);

	registerCommands(context, store, switcher);

	try {
		await switcher.onActivated();
		await files.cleanupOrphans(store.getUniverses().map(u => u.id), switcher.currentUniverseId());
	} catch (err) {
		console.error('[work-universe] activation step failed', err);
	}

	return { store, switcher };
}

export function deactivate() {}
