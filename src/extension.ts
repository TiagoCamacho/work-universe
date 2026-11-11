import * as vscode from 'vscode';
import { ActionRunner } from './actions/actionRunner';
import { ActionStore } from './actions/actionStore';
import { registerCommands } from './commands';
import { registerFileCommands } from './fileCommands';
import { UniverseStore } from './model/store';
import { initPerf, logError } from './perf';
import { Switcher } from './universe/switcher';
import { UniverseFiles } from './universe/workspaceFile';
import { DecorationSource } from './ui/decorations';
import { FileModel } from './ui/fileModel';
import { IconThemeResolver } from './ui/iconTheme';
import { PANEL_VIEW_ID, UniversePanel } from './ui/panel';
import { pickUniverse } from './ui/quickPick';
import { UniverseStatusBar } from './ui/statusBar';

export interface WorkUniverseApi {
	store: UniverseStore;
	switcher: Switcher;
}

export async function activate(context: vscode.ExtensionContext): Promise<WorkUniverseApi> {
	initPerf(context);
	const store = new UniverseStore(context.globalState);
	const files = new UniverseFiles(context.globalStorageUri);
	const switcher = new Switcher(store, files);
	const model = new FileModel();
	const icons = new IconThemeResolver();
	const decorations = new DecorationSource();
	const actionStore = new ActionStore(context.globalStorageUri);
	const actionRunner = new ActionRunner();
	const panel = new UniversePanel(context.extensionUri, store, switcher, model, icons, decorations, actionStore, actionRunner);
	const statusBar = new UniverseStatusBar(store, switcher);

	context.subscriptions.push(
		store,
		switcher,
		model,
		icons,
		decorations,
		actionStore,
		actionRunner,
		panel,
		statusBar,
		vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, panel, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('workUniverse.files.collapseAll', () => panel.collapseAll()),
		vscode.commands.registerCommand('workUniverse.showActionTerminal', (key: string) => actionRunner.showTerminal(key)),
		vscode.commands.registerCommand('workUniverse.files.refresh', () => model.changed()),
		vscode.commands.registerCommand('workUniverse.openUniverse', async () => {
			const universe = await pickUniverse(store, 'Open a universe in this window', switcher.currentUniverseId());
			if (universe) {
				await switcher.openUniverse(universe, universe.activeWorkspaceId ?? universe.workspaces[0]?.id);
			}
		}),
		// Global state can be changed by other windows; re-read when this one regains focus.
		vscode.window.onDidChangeWindowState(e => e.focused && store.refresh()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workUniverse.applyColors')) {
				switcher.refreshColor();
			}
		}),
	);

	registerCommands(context, store, switcher, actionStore);
	registerFileCommands(context, panel);

	try {
		await switcher.onActivated();
		await files.cleanupOrphans(store.getUniverses().map(u => u.id), switcher.currentUniverseId());
	} catch (err) {
		logError('activation step failed', err);
	}

	return { store, switcher };
}

export function deactivate() {}
