import * as assert from 'assert';
import * as vscode from 'vscode';
import { UniverseStore } from '../model/store';
import { isInside, sameUri } from '../universe/paths';
import { colorCustomizationsFor, contrastColor, isHexColor } from '../universe/theme';
import { buildWorkspaceJson } from '../universe/workspaceFile';
import { MemoryMemento } from './helpers';

suite('paths', () => {
	test('isInside matches the folder and its descendants only', () => {
		const folder = vscode.Uri.file('/work/backend');
		assert.ok(isInside(vscode.Uri.file('/work/backend'), folder));
		assert.ok(isInside(vscode.Uri.file('/work/backend/src/a.ts'), folder));
		assert.ok(!isInside(vscode.Uri.file('/work/backend-old/a.ts'), folder));
		assert.ok(!isInside(vscode.Uri.file('/work/frontend/a.ts'), folder));
	});

	test('sameUri ignores trailing slashes', () => {
		assert.ok(sameUri('file:///work/a/', 'file:///work/a'));
	});
});

suite('theme', () => {
	test('validates hex colors', () => {
		assert.ok(isHexColor('#abc'));
		assert.ok(isHexColor('#1f6feb'));
		assert.ok(!isHexColor('blue'));
		assert.ok(!isHexColor('#12345'));
	});

	test('picks a readable foreground', () => {
		assert.strictEqual(contrastColor('#ffffff'), '#000000');
		assert.strictEqual(contrastColor('#1f6feb'), '#ffffff');
		assert.strictEqual(contrastColor('#ff0'), '#000000');
	});

	test('color customizations are empty without a color', () => {
		assert.deepStrictEqual(colorCustomizationsFor(undefined), {});
		assert.strictEqual(colorCustomizationsFor('#abc')['titleBar.activeBackground'], '#aabbcc');
	});
});

suite('workspace file', () => {
	test('anchor is always folder 0', () => {
		const anchor = vscode.Uri.file('/storage/universes/u1/anchor');
		const json = buildWorkspaceJson(anchor, '◈ Product', [
			{ id: 'w1', name: 'backend', uri: vscode.Uri.file('/work/backend').toString() },
			{ id: 'w2', name: 'remote', uri: 'vscode-remote://ssh-remote+box/home/app' },
		]);
		assert.strictEqual(json.folders.length, 3);
		assert.strictEqual(json.folders[0].path, anchor.fsPath);
		assert.strictEqual(json.folders[0].name, '◈ Product');
		assert.strictEqual(json.folders[1].path, vscode.Uri.file('/work/backend').fsPath);
		assert.strictEqual(json.folders[2].uri, 'vscode-remote://ssh-remote+box/home/app');
	});
});

suite('store', () => {
	test('universe and workspace CRUD round-trip', async () => {
		const store = new UniverseStore(new MemoryMemento());
		let changes = 0;
		store.onDidChange(() => changes++);

		const u = await store.createUniverse('Product');
		const added = await store.addWorkspaces(u.id, [
			{ uri: vscode.Uri.file('/work/backend'), name: 'backend' },
			{ uri: vscode.Uri.file('/work/frontend'), name: 'frontend' },
		]);
		assert.strictEqual(added.length, 2);
		// duplicates are ignored
		assert.strictEqual((await store.addWorkspaces(u.id, [{ uri: vscode.Uri.file('/work/backend'), name: 'x' }])).length, 0);

		await store.updateWorkspace(added[0].id, w => (w.color = '#123456'));
		await store.setActiveWorkspace(u.id, added[0].id);
		await store.setSession(added[0].id, { groups: [] });
		assert.strictEqual(store.findWorkspace(added[0].id)?.workspace.color, '#123456');

		await store.removeWorkspace(added[0].id);
		const after = store.getUniverse(u.id)!;
		assert.strictEqual(after.workspaces.length, 1);
		assert.strictEqual(after.activeWorkspaceId, undefined);
		assert.strictEqual(store.getSession(added[0].id), undefined);

		await store.deleteUniverse(u.id);
		assert.strictEqual(store.getUniverses().length, 0);
		assert.ok(changes >= 5);
	});

	test('pending activation is consumed once', async () => {
		const store = new UniverseStore(new MemoryMemento());
		await store.setPending({ universeId: 'u', workspaceId: 'w', createdAt: Date.now() });
		assert.strictEqual(await store.takePending('other'), undefined);
		assert.strictEqual((await store.takePending('u'))?.workspaceId, 'w');
		assert.strictEqual(await store.takePending('u'), undefined);
	});
});
