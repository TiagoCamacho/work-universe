import * as assert from 'assert';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { panelHtml } from '../ui/panelHtml';

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

suite('panel webview', () => {
	test('the embedded script is valid JavaScript', () => {
		const fakeWebview = { cspSource: 'x', asWebviewUri: (u: vscode.Uri) => u } as unknown as vscode.Webview;
		const html = panelHtml(fakeWebview, vscode.Uri.file('/codicon.css'));
		const script = html.split(/<script[^>]*>/)[1].split('</script>')[0];
		assert.doesNotThrow(() => new vm.Script(script), 'panel script must parse');
	});
});
