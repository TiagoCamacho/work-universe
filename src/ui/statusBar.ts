import * as vscode from 'vscode';
import { UniverseStore } from '../model/store';
import { Switcher } from '../universe/switcher';
import { DEFAULT_WORKSPACE_ICON } from './util';

/** `$(icon) Universe › Workspace` on the left of the status bar; click opens the quick switcher. */
export class UniverseStatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('workUniverse.status', vscode.StatusBarAlignment.Left, 100);
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly store: UniverseStore,
		private readonly switcher: Switcher,
	) {
		this.item.name = 'Work Universe';
		this.item.command = 'workUniverse.quickSwitch';
		this.disposables.push(
			this.item,
			store.onDidChange(() => this.update()),
			switcher.onDidChangeState(() => this.update()),
		);
		this.update();
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	update(): void {
		const state = this.switcher.getWindowState();
		if (!state.universe) {
			if (!this.store.getUniverses().length) {
				this.item.hide();
				return;
			}
			this.item.text = '$(globe) Universes';
			this.item.tooltip = 'Work Universe: open a universe';
			this.item.show();
			return;
		}
		const universe = state.universe;
		if (state.allMode) {
			this.item.text = `$(globe) ${universe.name} › $(search) All`;
			this.item.tooltip = `All ${state.activeIds.length} workspaces of "${universe.name}" are loaded. Click to switch.`;
		} else {
			const ws = universe.workspaces.find(w => w.id === state.activeIds[0]);
			const icon = ws?.icon ?? DEFAULT_WORKSPACE_ICON;
			this.item.text = `$(globe) ${universe.name} › $(${icon}) ${ws?.name ?? '—'}`;
			this.item.tooltip = 'Work Universe: click to switch workspace (Ctrl+Alt+W)';
		}
		this.item.show();
	}
}
