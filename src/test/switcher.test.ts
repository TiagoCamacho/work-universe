import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { UniverseStore } from '../model/store';
import { Universe } from '../model/types';
import { sameUri } from '../universe/paths';
import { tabUri } from '../universe/tabSession';
import { Switcher } from '../universe/switcher';
import { applyWorkspaceColor } from '../universe/theme';
import { UniverseFiles } from '../universe/workspaceFile';
import { FileModel } from '../ui/fileModel';
import { lastTimings } from '../perf';
import { MemoryMemento } from './helpers';

const root = process.env.WORK_UNIVERSE_TEST_ROOT;

function openTabUris(): vscode.Uri[] {
	return vscode.window.tabGroups.all.flatMap(g => g.tabs).map(tabUri).filter((u): u is vscode.Uri => !!u);
}

function isOpen(uri: vscode.Uri): boolean {
	return openTabUris().some(u => sameUri(u, uri));
}

/**
 * Runs inside the fixture universe window built by .vscode-test.mjs. The tests themselves run in
 * the extension host, so if a switch restarted extensions this suite would die mid-way.
 */
(root ? suite : suite.skip)('switcher (in a universe window)', () => {
	const projects = path.join(root ?? '', 'projects');
	const a = vscode.Uri.file(path.join(projects, 'a'));
	const b = vscode.Uri.file(path.join(projects, 'b'));
	const alpha = vscode.Uri.joinPath(a, 'alpha.txt');
	const beta = vscode.Uri.joinPath(b, 'beta.txt');

	let store: UniverseStore;
	let switcher: Switcher;
	let files: UniverseFiles;

	suiteSetup(async () => {
		const memento = new MemoryMemento();
		const universe: Universe = {
			id: 'test',
			name: 'Test',
			createdAt: Date.now(),
			activeWorkspaceId: 'wa',
			workspaces: [
				{ id: 'wa', name: 'a', uri: a.toString() },
				{ id: 'wb', name: 'b', uri: b.toString(), color: '#c62828' },
			],
		};
		await memento.update('wu.universes', [universe]);
		store = new UniverseStore(memento);
		files = new UniverseFiles(vscode.Uri.file(root!));
		switcher = new Switcher(store, files);
	});

	suiteTeardown(() => switcher?.dispose());

	test('recognizes the universe window', () => {
		const state = switcher.getWindowState();
		assert.strictEqual(state.universe?.id, 'test');
		assert.ok(state.healthy, 'anchor should be folder 0');
		assert.deepStrictEqual(state.activeIds, ['wa']);
	});

	test('switching swaps folders, keeps the anchor and restores tabs per workspace', async () => {
		const anchor = vscode.workspace.workspaceFolders![0].uri;
		await vscode.commands.executeCommand('vscode.open', alpha, { preview: false });
		assert.ok(isOpen(alpha));

		await switcher.switchTo('wb');
		assert.ok(sameUri(vscode.workspace.workspaceFolders![0].uri, anchor), 'anchor must stay at index 0');
		assert.strictEqual(vscode.workspace.workspaceFolders!.length, 2);
		assert.ok(sameUri(vscode.workspace.workspaceFolders![1].uri, b));
		assert.ok(!isOpen(alpha), 'tabs of the old workspace are closed');
		assert.strictEqual(
			vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('colorCustomizations')?.['titleBar.activeBackground'],
			'#c62828',
		);

		await vscode.commands.executeCommand('vscode.open', beta, { preview: false });
		await switcher.switchTo('wa');
		assert.ok(sameUri(vscode.workspace.workspaceFolders![1].uri, a));
		assert.ok(isOpen(alpha), 'tabs of workspace a are restored');
		assert.ok(!isOpen(beta), 'tabs of workspace b are closed');
		assert.strictEqual(
			vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('colorCustomizations')?.['titleBar.activeBackground'],
			undefined,
		);

		await switcher.switchTo('wb');
		assert.ok(isOpen(beta), 'tabs of workspace b are restored');
	});

	test('search whole universe loads every workspace, and switching back narrows it again', async () => {
		await switcher.showAll('test', false);
		const folders = vscode.workspace.workspaceFolders!;
		assert.strictEqual(folders.length, 3);
		assert.ok(switcher.getWindowState().allMode);

		const found = await vscode.workspace.findFiles('**/*.txt');
		assert.ok(found.some(u => sameUri(u, alpha)) && found.some(u => sameUri(u, beta)));

		await switcher.switchTo('wa');
		assert.strictEqual(vscode.workspace.workspaceFolders!.length, 2);
		assert.deepStrictEqual(switcher.getWindowState().activeIds, ['wa']);
		const narrowed = await vscode.workspace.findFiles('**/*.txt');
		assert.ok(narrowed.some(u => sameUri(u, alpha)));
		assert.ok(!narrowed.some(u => sameUri(u, beta)), 'search only covers the active workspace');
	});

	test('file model lists the active workspace, honoring files.exclude', async () => {
		const model = new FileModel();
		try {
			await switcher.switchTo('wa');
			const names = (await model.list(a, a)).map(e => e.name);
			assert.deepStrictEqual(names, ['alpha.txt']);
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(a, '.git'));
			assert.ok(!(await model.list(a, a)).some(e => e.name === '.git'), '.git is excluded by default');
		} finally {
			model.dispose();
		}
	});

	test('restores tab order, the active tab and pinned tabs', async function () {
		this.timeout(60000);
		const names = ['one.txt', 'two.txt', 'three.txt', 'four.txt', 'five.txt'];
		const uris = names.map(n => vscode.Uri.joinPath(a, 'order', n));
		for (const uri of uris) {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('x'));
		}
		await switcher.switchTo('wa');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		for (const uri of uris) {
			await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
		}
		// Pin "four" (it moves to the front) and leave "two" as the active tab.
		await vscode.commands.executeCommand('vscode.open', uris[3], { preview: false });
		await vscode.commands.executeCommand('workbench.action.pinEditor');
		await vscode.commands.executeCommand('vscode.open', uris[1], { preview: false });
		const describe = () =>
			vscode.window.tabGroups.activeTabGroup.tabs
				.filter(t => names.includes(t.label))
				.map(t => t.label + (t.isPinned ? '*' : '') + (t.isActive ? '!' : ''));
		const before = describe();
		assert.deepStrictEqual(before, ['four.txt*', 'one.txt', 'two.txt!', 'three.txt', 'five.txt']);

		await switcher.switchTo('wb');
		assert.deepStrictEqual(describe(), [], 'tabs of a are closed');
		await switcher.switchTo('wa');
		assert.deepStrictEqual(describe(), before, 'same order, pinned and active tab');

		await vscode.commands.executeCommand('workbench.action.unpinEditor');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(a, 'order'), { recursive: true });
		await switcher.switchTo('wb');
		await switcher.switchTo('wa');
	});

	test('a deleted active file falls back to another saved tab, and an unchanged color is not rewritten', async function () {
		this.timeout(30000);
		const keep = vscode.Uri.joinPath(a, 'gone', 'keep.txt');
		const gone = vscode.Uri.joinPath(a, 'gone', 'gone.txt');
		for (const uri of [keep, gone]) {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('x'));
		}
		await switcher.switchTo('wa');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.commands.executeCommand('vscode.open', keep, { preview: false });
		await vscode.commands.executeCommand('vscode.open', gone, { preview: false }); // active
		await switcher.switchTo('wb');
		await vscode.workspace.fs.delete(gone);
		await switcher.switchTo('wa');
		const labels = vscode.window.tabGroups.activeTabGroup.tabs.map(t => t.label + (t.isActive ? '!' : ''));
		assert.deepStrictEqual(labels, ['keep.txt!'], 'the missing file is skipped, the other one is shown');

		// Applying the color that is already applied writes nothing.
		assert.strictEqual(await applyWorkspaceColor('#123456'), true, 'new color is written');
		assert.strictEqual(await applyWorkspaceColor('#123456'), false, 'same color is skipped');
		assert.strictEqual(await applyWorkspaceColor(undefined), true, 'clearing is written');
		assert.strictEqual(await applyWorkspaceColor(undefined), false, 'no color twice is skipped');

		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(a, 'gone'), { recursive: true });
		await switcher.switchTo('wb');
		await switcher.switchTo('wa');
	});

	test('restores split editors: each side gets its tabs back and the focus returns to the same side', async function () {
		this.timeout(60000);
		const names = ['left1.txt', 'left2.txt', 'right1.txt', 'right2.txt', 'right3.txt'];
		const [left1, left2, right1, right2, right3] = names.map(n => vscode.Uri.joinPath(a, 'split', n));
		for (const uri of [left1, left2, right1, right2, right3]) {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('x'));
		}
		await switcher.switchTo('wa');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const open = (uri: vscode.Uri, viewColumn: number) => vscode.commands.executeCommand('vscode.open', uri, { viewColumn, preview: false });
		await open(left1, 1);
		await open(left2, 1);
		await open(right1, 2);
		await open(right2, 2);
		await open(right3, 2);
		await open(left1, 1); // left side shows left1
		await open(right2, 2); // right side shows right2 and has the focus
		const describe = () =>
			vscode.window.tabGroups.all.map(g => ({
				focused: g.isActive,
				tabs: g.tabs.filter(t => names.includes(t.label)).map(t => t.label + (t.isActive ? '!' : '')),
			}));
		const before = describe();
		assert.deepStrictEqual(before, [
			{ focused: false, tabs: ['left1.txt!', 'left2.txt'] },
			{ focused: true, tabs: ['right1.txt', 'right2.txt!', 'right3.txt'] },
		]);

		await switcher.switchTo('wb');
		assert.ok(!describe().some(g => g.tabs.length), 'tabs of a are closed');
		await switcher.switchTo('wa');
		assert.deepStrictEqual(describe(), before);

		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(a, 'split'), { recursive: true });
		await switcher.switchTo('wb');
		await switcher.switchTo('wa');
	});

	test('the state reports the target at once, and rapid switches land on the last one', async () => {
		await switcher.switchTo('wa');
		let folderEvents = 0;
		const early = vscode.workspace.onDidChangeWorkspaceFolders(() => folderEvents++);
		const pending = switcher.switchTo('wb');
		// Give the queued switch one turn to start; VS Code confirms the folder change much later.
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(switcher.getWindowState().activeIds, ['wb'], 'target reported at once');
		assert.strictEqual(folderEvents, 0, 'VS Code has not confirmed the folder change yet');
		await pending;
		early.dispose();
		assert.strictEqual(folderEvents, 1);
		assert.ok(sameUri(vscode.workspace.workspaceFolders![1].uri, b));

		let folderChanges = 0;
		const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => folderChanges++);
		await Promise.all([switcher.switchTo('wa'), switcher.switchTo('wb'), switcher.switchTo('wa'), switcher.switchTo('wb'), switcher.switchTo('wa')]);
		listener.dispose();
		assert.deepStrictEqual(switcher.getWindowState().activeIds, ['wa'], 'ends on the last requested workspace');
		assert.ok(sameUri(vscode.workspace.workspaceFolders![1].uri, a));
		assert.ok(folderChanges <= 2, `intermediate switches are skipped (folder changes: ${folderChanges})`);
	});

	test('timing: switch between workspaces with 8 open tabs each', async function () {
		this.timeout(60000);
		const TABS = 8;
		const make = async (folder: vscode.Uri) => {
			const uris: vscode.Uri[] = [];
			for (let i = 0; i < TABS; i++) {
				const uri = vscode.Uri.joinPath(folder, 'perf', `file${i}.txt`);
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`perf ${i}
`));
				uris.push(uri);
			}
			return uris;
		};
		const filesA = await make(a);
		const filesB = await make(b);
		const openAll = async (uris: vscode.Uri[]) => {
			for (const uri of uris) {
				await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
			}
		};
		// Each workspace gets a saved session of TABS tabs.
		await switcher.switchTo('wa');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await openAll(filesA);
		await switcher.switchTo('wb');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await openAll(filesB);

		const timeSwitch = async (id: string) => {
			const start = performance.now();
			let stateAt = 0;
			const d1 = switcher.onDidChangeState(() => (stateAt ||= performance.now() - start));
			const d2 = store.onDidChange(() => (stateAt ||= performance.now() - start));
			await switcher.switchTo(id);
			d1.dispose();
			d2.dispose();
			return { state: Math.round(stateAt), total: Math.round(performance.now() - start), phases: { ...lastTimings.switch } };
		};
		const runs: { state: number; total: number; phases: Record<string, number> }[] = [];
		for (const id of ['wa', 'wb', 'wa', 'wb', 'wa', 'wb']) {
			runs.push(await timeSwitch(id));
		}
		const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
		console.log(
			`[perf] switch with ${TABS} tabs: UI state after ${median(runs.map(r => r.state))} ms, done after ${median(runs.map(r => r.total))} ms (runs: ${runs.map(r => `${r.state}/${r.total}`).join(' ')})`,
		);
		const phase = (name: string) => Math.round(median(runs.map(r => r.phases[name] ?? -1)));
		console.log(
			`[perf] phases (median ms): state=${phase('state')} firstEditor=${phase('firstEditor')} folders=${phase('folders')} tabs=${phase('tabs')} total=${phase('total')}`,
		);
		for (const uri of filesB) {
			assert.ok(isOpen(uri), 'tabs of workspace b restored');
		}
		assert.ok(phase('state') < 50, 'the UI state must update within 50 ms of the switch starting');
		assert.ok(!filesA.some(isOpen), 'tabs of workspace a closed');

		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(a, 'perf'), { recursive: true });
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(b, 'perf'), { recursive: true });
	});

	test('together mode: every folder stays loaded and a switch only swaps the tabs', async function () {
		this.timeout(60000);
		const TABS = 8;
		const make = async (folder: vscode.Uri) => {
			const uris: vscode.Uri[] = [];
			for (let i = 0; i < TABS; i++) {
				const uri = vscode.Uri.joinPath(folder, 'together', `file${i}.txt`);
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('x'));
				uris.push(uri);
			}
			return uris;
		};
		const filesA = await make(a);
		const filesB = await make(b);
		const openAll = async (uris: vscode.Uri[]) => {
			for (const uri of uris) {
				await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
			}
		};
		const folderUris = () => vscode.workspace.workspaceFolders!.slice(1).map(f => f.uri.toString());

		await switcher.switchTo('wa');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await switcher.setMode('test', 'together');
		assert.deepStrictEqual(folderUris(), [a.toString(), b.toString()], 'both folders are loaded');
		let state = switcher.getWindowState();
		assert.deepStrictEqual([state.mode, state.activeIds, state.allMode], ['together', ['wa'], false]);

		// Switching swaps the tabs and the active workspace, but never the window's folders.
		let folderEvents = 0;
		const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => folderEvents++);
		await openAll(filesA);
		await switcher.switchTo('wb');
		assert.deepStrictEqual(switcher.getWindowState().activeIds, ['wb']);
		assert.ok(!filesA.some(isOpen), 'tabs of a are closed');
		await openAll(filesB);

		const runs: Record<string, number>[] = [];
		for (const id of ['wa', 'wb', 'wa', 'wb', 'wa', 'wb']) {
			await switcher.switchTo(id);
			runs.push({ ...lastTimings.switch });
		}
		listener.dispose();
		assert.strictEqual(folderEvents, 0, 'no folder change in together mode');
		assert.deepStrictEqual(folderUris(), [a.toString(), b.toString()]);
		assert.ok(filesB.every(isOpen) && !filesA.some(isOpen), 'tabs follow the active workspace');
		assert.ok(runs.every(r => r.folders === undefined), 'no folders phase');
		const median = (name: string) => Math.round([...runs.map(r => r[name] ?? -1)].sort((x, y) => x - y)[Math.floor(runs.length / 2)]);
		console.log(
			`[perf] together mode, ${TABS} tabs (median ms): state=${median('state')} firstEditor=${median('firstEditor')} tabs=${median('tabs')} total=${median('total')}`,
		);

		// Back to separate environments: only the active workspace stays loaded.
		await switcher.setMode('test', 'isolated');
		assert.deepStrictEqual(folderUris(), [b.toString()], 'only the active folder is loaded');
		state = switcher.getWindowState();
		assert.deepStrictEqual([state.mode, state.activeIds], ['isolated', ['wb']]);
		assert.ok(filesB.every(isOpen), 'the active workspace keeps its tabs');

		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(a, 'together'), { recursive: true });
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(b, 'together'), { recursive: true });
		await switcher.switchTo('wa');
		await switcher.switchTo('wb');
		await switcher.switchTo('wa');
	});
});
