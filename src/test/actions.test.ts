import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActionRunner } from '../actions/actionRunner';
import { ActionStore, actionsFileTemplate, validateActions } from '../actions/actionStore';
import { actionsFromScripts, detectPackageManager, guessIcon, readScripts } from '../actions/scripts';
import { Workspace } from '../model/types';
import { parseJsonc } from '../ui/util';

suite('custom actions: validation', () => {
	test('accepts valid shell and VS Code actions, with defaults', () => {
		const { actions, errors } = validateActions(
			parseJsonc(`{
				// comment
				"actions": [
					{ "label": "Dev", "icon": "play", "command": "npm run dev", "env": { "PORT": 3000 } },
					{ "label": "Restart TS", "vscodeCommand": "typescript.restartTsServer", "args": "x" },
				]
			}`),
		);
		assert.deepStrictEqual(errors, []);
		assert.strictEqual(actions.length, 2);
		assert.deepStrictEqual(actions[0], { label: 'Dev', icon: 'play', command: 'npm run dev', env: { PORT: '3000' } });
		assert.strictEqual(actions[1].icon, 'terminal', 'default icon');
		assert.deepStrictEqual(actions[1].args, ['x'], 'single arg is wrapped');
	});

	test('skips invalid entries and explains why', () => {
		const { actions, errors } = validateActions({
			actions: [
				{ icon: 'play', command: 'x' },
				{ label: 'Both', command: 'a', vscodeCommand: 'b' },
				{ label: 'Neither' },
				{ label: 'Bad color', command: 'a', color: 'blue' },
			],
		});
		assert.strictEqual(actions.length, 1, 'only the bad-color one is kept (without color)');
		assert.strictEqual(actions[0].color, undefined);
		assert.strictEqual(errors.length, 4);
		assert.ok(errors[0].includes('"label" is required'));
		assert.ok(errors[1].includes('exactly one'));
	});

	test('missing "actions" array is an error, an empty file is not', () => {
		const empty = validateActions(undefined);
		assert.deepStrictEqual([empty.actions, empty.errors, empty.active_color], [[], [], undefined]);
		assert.strictEqual(validateActions({ actions: 'nope' }).errors.length, 1);
	});
});

suite('custom actions: package.json scripts', () => {
	const tmp = (files: Record<string, string>) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-scripts-'));
		for (const [name, content] of Object.entries(files)) {
			fs.writeFileSync(path.join(dir, name), content);
		}
		return vscode.Uri.file(dir);
	};

	test('detects the package manager from the lockfile', async () => {
		assert.strictEqual(await detectPackageManager(tmp({})), 'npm');
		assert.strictEqual(await detectPackageManager(tmp({ 'pnpm-lock.yaml': '' })), 'pnpm');
		assert.strictEqual(await detectPackageManager(tmp({ 'yarn.lock': '' })), 'yarn');
		assert.strictEqual(await detectPackageManager(tmp({ 'bun.lock': '' })), 'bun');
	});

	test('guesses icons from script names', () => {
		assert.strictEqual(guessIcon('dev'), 'play');
		assert.strictEqual(guessIcon('start'), 'play');
		assert.strictEqual(guessIcon('test:unit'), 'beaker');
		assert.strictEqual(guessIcon('build'), 'tools');
		assert.strictEqual(guessIcon('lint'), 'checklist');
		assert.strictEqual(guessIcon('whatever'), 'terminal');
	});

	test('turns scripts into actions', async () => {
		const folder = tmp({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev', test: 'vitest' } }), 'yarn.lock': '' });
		assert.deepStrictEqual(Object.keys(await readScripts(folder)), ['dev', 'test']);
		assert.deepStrictEqual(await actionsFromScripts(folder, ['dev', 'test']), [
			{ label: 'dev', icon: 'play', command: 'yarn run dev' },
			{ label: 'test', icon: 'beaker', command: 'yarn run test' },
		]);
		assert.deepStrictEqual(await readScripts(tmp({})), {}, 'no package.json');
	});
});

suite('custom actions: runner', () => {
	const workspace: Workspace = { id: 'ws1', name: 'api', uri: vscode.Uri.file(os.tmpdir()).toString() };
	let runner: ActionRunner;

	setup(() => (runner = new ActionRunner()));
	teardown(() => runner.dispose());

	test('runs a VS Code command with its args', async () => {
		let received: unknown[] = [];
		const reg = vscode.commands.registerCommand('workUniverse.test.echo', (...args: unknown[]) => (received = args));
		try {
			await runner.run(workspace, { label: 'Echo', icon: 'zap', vscodeCommand: 'workUniverse.test.echo', args: [1, 'two'] });
			assert.deepStrictEqual(received, [1, 'two']);
		} finally {
			reg.dispose();
		}
	});

	test('a shell action gets one named terminal, reused on the next run', async () => {
		const action = { label: 'Hello', icon: 'terminal', command: 'echo hello' };
		await runner.run(workspace, action);
		const first = runner.terminalFor(workspace, action);
		assert.ok(first, 'terminal created');
		assert.strictEqual(first!.name, 'api: Hello');
		assert.ok(runner.isRunning(workspace.id, action.label), 'running right after start');

		// Once the command finishes (reported by shell integration), the next press reuses the terminal.
		// While it is still running, a press asks Restart/Show/Stop instead, so wait for the end.
		const deadline = Date.now() + 10000;
		while (runner.isRunning(workspace.id, action.label) && Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 100));
		}
		if (!runner.isRunning(workspace.id, action.label)) {
			await runner.run(workspace, action);
			assert.strictEqual(runner.terminalFor(workspace, action), first, 'same terminal reused');
			assert.strictEqual(vscode.window.terminals.filter(t => t.name === 'api: Hello').length, 1);
		}
		first!.dispose();
	});
});

suite('custom actions: settings', () => {
	test('reads active_color, headless and show_status_bar', () => {
		const ok = validateActions({
			active_color: '#3fb950',
			actions: [{ label: 'Dev', command: 'npm run dev', headless: true, show_status_bar: true }],
		});
		assert.deepStrictEqual(ok.errors, []);
		assert.strictEqual(ok.active_color, '#3fb950');
		assert.strictEqual(ok.actions[0].headless, true);
		assert.strictEqual(ok.actions[0].show_status_bar, true);

		assert.strictEqual(validateActions({ active_color: 'none', actions: [] }).active_color, undefined);
		assert.strictEqual(validateActions({ active_color: 'NONE', actions: [] }).errors.length, 0);

		const bad = validateActions({ active_color: 'green', actions: [{ label: 'X', command: 'x', headless: 'yes' }] });
		assert.strictEqual(bad.active_color, undefined);
		assert.strictEqual(bad.errors.length, 2);
		assert.strictEqual(bad.actions[0].headless, undefined, 'invalid flag ignored, action kept');
	});

	test('the generated template documents every property and parses back', () => {
		const actions = [
			{ label: 'dev', icon: 'play', command: 'npm run dev' },
			{ label: 'test', icon: 'beaker', command: 'npm test' },
		];
		const text = actionsFileTemplate('api', actions);
		for (const prop of ['active_color', 'label', 'icon', 'command', 'vscodeCommand', 'args', 'cwd', 'env', 'color', 'headless', 'show_status_bar']) {
			assert.ok(new RegExp('^//\\s+' + prop + '\\b', 'm').test(text), `comment documents ${prop}`);
		}
		const parsed = validateActions(parseJsonc(text));
		assert.deepStrictEqual(parsed.errors, []);
		assert.deepStrictEqual(parsed.actions, actions);
		assert.strictEqual(parsed.active_color, undefined, '"none" by default');
	});
});

suite('custom actions: running state', () => {
	const workspace: Workspace = { id: 'ws2', name: 'web', uri: vscode.Uri.file(os.tmpdir()).toString() };

	test('headless actions get a hidden terminal and report running until it closes', async () => {
		const runner = new ActionRunner();
		let changes = 0;
		runner.onDidChangeRunning(() => changes++);
		try {
			const action = { label: 'Serve', icon: 'play', command: 'echo serving', headless: true, show_status_bar: true };
			await runner.run(workspace, action, '#3fb950');
			const terminal = runner.terminalFor(workspace, action);
			assert.ok(terminal);
			assert.strictEqual((terminal!.creationOptions as vscode.TerminalOptions).hideFromUser, true);
			assert.ok(changes >= 1, 'running state changed');

			const closed = new Promise<void>(resolve => {
				const d = vscode.window.onDidCloseTerminal(t => t === terminal && (d.dispose(), resolve()));
			});
			terminal!.dispose();
			await closed;
			assert.strictEqual(runner.isRunning(workspace.id, action.label), false, 'not running after close');
			assert.strictEqual(runner.terminalFor(workspace, action), undefined);
		} finally {
			runner.dispose();
		}
	});
});

suite('custom actions: store', () => {
	test('write, read back and remove all actions of a workspace', async () => {
		const root = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'wu-store-')));
		const store = new ActionStore(root);
		const changed: string[] = [];
		store.onDidChange(id => changed.push(id));
		try {
			await store.write('w1', 'api', [{ label: 'dev', icon: 'play', command: 'npm run dev' }]);
			assert.strictEqual((await store.get('w1')).actions.length, 1);

			await store.delete('w1');
			assert.strictEqual(await store.exists('w1'), false, 'file removed');
			assert.deepStrictEqual((await store.get('w1')).actions, [], 'no buttons left');
			assert.ok(changed.filter(id => id === 'w1').length >= 2, 'write and delete both notify the panel');
		} finally {
			store.dispose();
		}
	});
});
