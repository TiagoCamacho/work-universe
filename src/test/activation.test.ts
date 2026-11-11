import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { ActionStore } from '../actions/actionStore';
import { actionsFromScripts, isSafeScriptName, runCommand } from '../actions/scripts';
import { panelHtml } from '../ui/panelHtml';
import { isSafeId, UniverseFiles } from '../universe/workspaceFile';

suite('activation', () => {
	test('the extension activates and registers its commands and panel', async () => {
		const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'work-universe');
		assert.ok(ext, 'extension is loaded');
		await ext!.activate();
		assert.ok(ext!.isActive);
		const commands = await vscode.commands.getCommands(true);
		for (const id of ['workUniverse.setCustomActions', 'workUniverse.quickSwitch', 'workUniverse.files.newFile']) {
			assert.ok(commands.includes(id), `${id} is registered`);
		}
	});
});

suite('commands run from menus', () => {
	test('an argument that is not a universe or workspace is ignored, not crashed on', async () => {
		// The panel's "…" menu passes VS Code's own context object to the command.
		const junk = { webview: 'workUniverse.panel', preventDefaultContextMenuItems: true };
		for (const id of ['workUniverse.searchUniverse', 'workUniverse.setUniverseMode', 'workUniverse.renameUniverse', 'workUniverse.removeAllActions']) {
			await assert.doesNotReject(async () => vscode.commands.executeCommand(id, junk), `${id} must not throw`);
		}
	});
});

suite('panel webview', () => {
	test('the embedded script is valid JavaScript', () => {
		const fakeWebview = { cspSource: 'x', asWebviewUri: (u: vscode.Uri) => u } as unknown as vscode.Webview;
		const html = panelHtml(fakeWebview, vscode.Uri.file('/codicon.css'));
		const script = html.split(/<script[^>]*>/)[1].split('</script>')[0];
		assert.doesNotThrow(() => new vm.Script(script), 'panel script must parse');
	});
});

suite('security', () => {
	test('ids that could leave the storage folder are rejected', () => {
		for (const bad of ['../x', '..', 'a/b', 'a\b', '', 'C:evil', 'x'.repeat(65), 42, undefined]) {
			assert.strictEqual(isSafeId(bad), false, `${String(bad)} must be rejected`);
		}
		for (const good of ['dev-universe', 'test', 'mhv3k2a9x1b2c3', 'A_b-9']) {
			assert.strictEqual(isSafeId(good), true, good);
		}
		const files = new UniverseFiles(vscode.Uri.file('/storage'));
		assert.throws(() => files.dir('../../Documents'), 'a traversal id never becomes a path');
		const actions = new ActionStore(vscode.Uri.file('/storage'));
		const file = actions.fileFor({ uri: vscode.Uri.file('/../../Documents').toString() });
		assert.ok(file.path.startsWith(actions.dir.path + '/'), 'an actions file is always inside the actions folder');
		actions.dispose();
	});

	test('an anchor outside the extension storage is never written to', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-anchor-'));
		fs.mkdirSync(path.join(dir, '.vscode'));
		const settings = path.join(dir, '.vscode', 'settings.json');
		fs.writeFileSync(settings, '{"editor.tabSize": 3}');
		const files = new UniverseFiles(vscode.Uri.file(path.join(dir, 'storage')));
		await files.ensureAnchor({ id: 'x', name: 'X', workspaces: [], createdAt: 0, anchor: vscode.Uri.file(dir).toString() });
		assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{"editor.tabSize": 3}', 'existing settings untouched');
	});

	test('package.json script names cannot inject shell commands', async () => {
		for (const bad of ['dev; rm -rf ~', 'a && b', 'x|y', '$(whoami)', '`id`', 'a b', '-rf', 'a>b', 'a"b', "a'b"]) {
			assert.strictEqual(isSafeScriptName(bad), false, bad);
			assert.throws(() => runCommand('npm', bad));
		}
		for (const good of ['dev', 'test:unit', 'build.prod', 'lint-fix', 'docs/build', 'e2e_ci']) {
			assert.strictEqual(isSafeScriptName(good), true, good);
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-inject-'));
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'x', 'dev; calc': 'y' } }));
		const actions = await actionsFromScripts(vscode.Uri.file(dir), ['dev', 'dev; calc']);
		assert.deepStrictEqual(actions.map(a => a.command), ['npm run dev']);
	});
});
