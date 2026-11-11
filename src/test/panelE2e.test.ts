import * as assert from 'assert';
import * as fs from 'fs';
import { JSDOM } from 'jsdom';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActionRunner } from '../actions/actionRunner';
import { ActionStore } from '../actions/actionStore';
import { UniverseStore } from '../model/store';
import { Universe } from '../model/types';
import { lastTimings } from '../perf';
import { DecorationSource } from '../ui/decorations';
import { FileModel } from '../ui/fileModel';
import { IconThemeResolver } from '../ui/iconTheme';
import { UniversePanel } from '../ui/panel';
import { sameUri } from '../universe/paths';
import { Switcher } from '../universe/switcher';
import { UniverseFiles } from '../universe/workspaceFile';
import { MemoryMemento } from './helpers';

const root = process.env.WORK_UNIVERSE_TEST_ROOT;

/**
 * The real panel (extension host side) connected to the real panel script (running in jsdom),
 * inside the fixture universe window. Messages travel asynchronously in both directions, like
 * they do between VS Code and a webview.
 */
(root ? suite : suite.skip)('panel end to end', () => {
	const a = vscode.Uri.file(path.join(root ?? '', 'projects', 'a'));
	const b = vscode.Uri.file(path.join(root ?? '', 'projects', 'b'));
	const disposables: vscode.Disposable[] = [];
	let switcher: Switcher;
	let dom: JSDOM;
	let fromWebview: { type: string }[] = [];

	const rows = () => [...dom.window.document.querySelectorAll('.row .label')].map(e => e.textContent);
	const activeTab = () => dom.window.document.querySelector('.tab.active .name')?.textContent;
	const clickTab = (name: string) => {
		const tab = [...dom.window.document.querySelectorAll('.tab .name')].find(e => e.textContent === name);
		assert.ok(tab, `tab ${name}`);
		(tab.closest('button') as HTMLElement).click();
	};
	const until = async (what: string, check: () => boolean, timeout = 5000) => {
		const start = performance.now();
		while (!check()) {
			if (performance.now() - start > timeout) {
				assert.fail(`timed out waiting for ${what}; rows: ${JSON.stringify(rows())}`);
			}
			await new Promise(resolve => setTimeout(resolve, 2));
		}
		return performance.now() - start;
	};

	suiteSetup(async () => {
		const memento = new MemoryMemento();
		const universe: Universe = {
			id: 'test',
			name: 'Test',
			createdAt: Date.now(),
			activeWorkspaceId: 'wa',
			workspaces: [
				{ id: 'wa', name: 'a', uri: a.toString() },
				{ id: 'wb', name: 'b', uri: b.toString() },
			],
		};
		await memento.update('wu.universes', [universe]);
		const store = new UniverseStore(memento);
		switcher = new Switcher(store, new UniverseFiles(vscode.Uri.file(root!)));
		await switcher.switchTo('wa'); // other suites may have left the window on b
		const model = new FileModel();
		const icons = new IconThemeResolver();
		const decorations = new DecorationSource();
		const actionStore = new ActionStore(vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'wu-e2e-'))));
		const actionRunner = new ActionRunner();
		const panel = new UniversePanel(vscode.Uri.file('/ext'), store, switcher, model, icons, decorations, actionStore, actionRunner);
		disposables.push(store, switcher, model, icons, decorations, actionStore, actionRunner, panel);

		// A stand-in for VS Code's WebviewView: it hands messages to jsdom and back.
		const toHost: ((m: unknown) => void)[] = [];
		const queue: unknown[] = [];
		const view = {
			visible: true,
			title: '',
			description: undefined,
			webview: {
				options: {},
				html: '',
				cspSource: 'x',
				asWebviewUri: (u: vscode.Uri) => u,
				postMessage: async (m: unknown) => {
					const data = JSON.parse(JSON.stringify(m));
					if (dom) {
						setTimeout(() => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data })), 0);
					} else {
						queue.push(data);
					}
					return true;
				},
				onDidReceiveMessage: (cb: (m: unknown) => void) => {
					toHost.push(cb);
					return { dispose: () => undefined };
				},
			},
			onDidChangeVisibility: () => ({ dispose: () => undefined }),
			onDidDispose: () => ({ dispose: () => undefined }),
		};
		await panel.resolveWebviewView(view as unknown as vscode.WebviewView);

		const html = view.webview.html.replace(/<meta http-equiv[^>]*>/, '').replace(/<link rel="stylesheet"[^>]*>/, '');
		dom = new JSDOM(html, {
			runScripts: 'dangerously',
			pretendToBeVisual: true,
			beforeParse(window) {
				const w = window as unknown as Record<string, unknown>;
				w.acquireVsCodeApi = () => ({
					postMessage: (m: { type: string }) => {
						const data = JSON.parse(JSON.stringify(m));
						fromWebview.push(data);
						setTimeout(() => toHost.forEach(cb => cb(data)), 0);
					},
					getState: () => undefined,
					setState: () => undefined,
				});
				w.CSS = { escape: (s: string) => s };
			},
		});
		for (const data of queue) {
			dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
		}
	});

	suiteTeardown(async () => {
		await switcher?.switchTo('wa');
		dom?.window.close();
		disposables.reverse().forEach(d => d.dispose());
	});

	test('shows the active workspace, switches on click, and is instant on the way back', async function () {
		this.timeout(30000);
		await until('files of a', () => rows().includes('alpha.txt'));
		assert.strictEqual(activeTab(), 'a');

		// First visit to b: the tab highlight is immediate, the tree needs one round trip.
		fromWebview = [];
		clickTab('b');
		assert.strictEqual(activeTab(), 'b', 'tab highlighted in the same tick as the click');
		const cold = await until('files of b', () => rows().includes('beta.txt') && !rows().includes('alpha.txt'));
		assert.strictEqual(fromWebview.filter(m => m.type === 'listMany').length, 1, 'one listing request for the new workspace');
		await switcher.switchTo('wb'); // resolves once the running switch is complete
		assert.ok(sameUri(vscode.workspace.workspaceFolders![1].uri, b));
		const hostPosted = lastTimings.switch?.panelPosted;

		// Back to a: its tree was shown before, so it is on screen in the same tick as the click.
		clickTab('a');
		assert.strictEqual(activeTab(), 'a');
		assert.ok(rows().includes('alpha.txt') && !rows().includes('beta.txt'), 'cached tree shown synchronously');
		await switcher.switchTo('wa');
		assert.ok(sameUri(vscode.workspace.workspaceFolders![1].uri, a));
		await until('tree still correct after the host confirms', () => rows().includes('alpha.txt') && activeTab() === 'a');

		console.log(
			`[perf] panel: first visit click→tree ${Math.round(cold)} ms (host posted state after ${hostPosted} ms); revisit click→tree 0 ms (same tick)`,
		);
		assert.ok(cold < 250, `first visit took ${Math.round(cold)} ms`);
	});
});
