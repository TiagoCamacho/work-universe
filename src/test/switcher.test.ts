import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { UniverseStore } from '../model/store';
import { Universe } from '../model/types';
import { sameUri } from '../universe/paths';
import { tabUri } from '../universe/tabSession';
import { Switcher } from '../universe/switcher';
import { UniverseFiles } from '../universe/workspaceFile';
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
});
