import * as vscode from 'vscode';
import { ActionRunner } from './actions/actionRunner';
import { ActionStore } from './actions/actionStore';
import { registerCommands } from './commands';
import { registerFileCommands } from './fileCommands';
import { UniverseStore } from './model/store';
import { initPerf, logError } from './perf';
import { SolutionModel } from './solution/solutionModel';
import { ProjectTerminals } from './universe/projectTerminals';
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
	projectTerminals: ProjectTerminals;
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
	// Older versions keyed actions files by workspace id; move them to the folder key before anything reads them.
	await actionStore.migrate(store.getUniverses().flatMap(u => u.workspaces)).catch(() => undefined);
	const actionRunner = new ActionRunner();
	const solutions = new SolutionModel(model);
	const panel = new UniversePanel(context.extensionUri, store, switcher, model, icons, decorations, actionStore, actionRunner, solutions);
	const statusBar = new UniverseStatusBar(store, switcher);
	const projectTerminals = new ProjectTerminals(switcher);

	context.subscriptions.push(
		store,
		switcher,
		model,
		solutions,
		icons,
		decorations,
		actionStore,
		actionRunner,
		panel,
		statusBar,
		projectTerminals,
		projectTerminals.registerProfile(),
		vscode.commands.registerCommand('workUniverse.openProjectTerminal', () => projectTerminals.open()),
		vscode.commands.registerCommand('workUniverse.projectTerminals.toggle', (arg?: { command?: unknown; hiding?: unknown }) => {
			// Only VS Code's own toggles, as bound in package.json.
			const allowed = ['workbench.action.terminal.toggleTerminal', 'workbench.action.togglePanel'];
			const command = typeof arg?.command === 'string' && allowed.includes(arg.command) ? arg.command : allowed[0];
			return projectTerminals.toggle(command, arg?.hiding === true);
		}),
		vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, panel, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('workUniverse.files.collapseAll', () => panel.collapseAll()),
		vscode.commands.registerCommand('workUniverse.showActionTerminal', (key: string) => actionRunner.showTerminal(key)),
		vscode.commands.registerCommand('workUniverse.files.refresh', () => model.changed()),
		vscode.commands.registerCommand('workUniverse.solution.openFile', (arg?: unknown) => panel.openSolutionFile(arg)),
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

	return { store, switcher, projectTerminals };
}

export function deactivate() {}
