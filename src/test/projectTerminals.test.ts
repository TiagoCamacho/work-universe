import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Universe, Workspace } from '../model/types';
import { ProjectTerminals } from '../universe/projectTerminals';
import { Switcher, WindowState } from '../universe/switcher';

/** Just enough of the switcher for ProjectTerminals: an active workspace and a change event. */
class FakeSwitcher {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeState = this.emitter.event;
	active?: Workspace;

	constructor(readonly universe: Universe) {}

	activeWorkspace() {
		return this.active ? { universe: this.universe, workspace: this.active } : undefined;
	}

	getWindowState(): WindowState {
		return { universe: this.universe, activeIds: this.active ? [this.active.id] : [], allMode: false, healthy: true, mode: 'isolated' };
	}

	switchTo(workspace: Workspace | undefined): void {
		this.active = workspace;
		this.emitter.fire();
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

function until(condition: () => boolean, ms = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + ms;
		const tick = () => {
			if (condition()) {
				resolve();
			} else if (Date.now() > deadline) {
				reject(new Error('timed out'));
			} else {
				setTimeout(tick, 50);
			}
		};
		tick();
	});
}

suite('project terminals', () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-terminals-'));
	for (const dir of ['api', 'web', path.join('web', 'nested')]) {
		fs.mkdirSync(path.join(base, dir), { recursive: true });
	}
	const uri = (dir: string) => vscode.Uri.file(path.join(base, dir)).toString();
	const api: Workspace = { id: 't-api', name: 'api', uri: uri('api'), icon: 'server' };
	const web: Workspace = { id: 't-web', name: 'web', uri: uri('web') };
	const nested: Workspace = { id: 't-nested', name: 'nested', uri: uri(path.join('web', 'nested')) };
	const universe: Universe = { id: 't-universe', name: 'T', createdAt: 0, workspaces: [api, web, nested] };

	let fake: FakeSwitcher;
	let terminals: ProjectTerminals;
	const created: vscode.Terminal[] = [];

	setup(() => {
		fake = new FakeSwitcher(universe);
		terminals = new ProjectTerminals(fake as unknown as Switcher);
	});

	teardown(async () => {
		terminals.dispose();
		fake.dispose();
		created.splice(0).forEach(t => t.dispose());
		await vscode.workspace.getConfiguration('workUniverse.projectTerminals').update('autoOpen', undefined, vscode.ConfigurationTarget.Global);
	});

	test('a project terminal is named after its project and rooted in it', () => {
		const terminal = terminals.open(api, true)!;
		created.push(terminal);
		const options = terminal.creationOptions as vscode.TerminalOptions;
		assert.strictEqual(terminal.name, 'api');
		assert.strictEqual((options.cwd as vscode.Uri).fsPath, vscode.Uri.parse(api.uri).fsPath);
		assert.deepStrictEqual(terminals.terminalsOf(api), [terminal]);
		assert.deepStrictEqual(terminals.terminalsOf(web), []);
	});

	test('terminals opened by hand belong to the project they start in (deepest folder wins)', () => {
		const inWeb = vscode.window.createTerminal({ name: 'by hand', cwd: vscode.Uri.parse(web.uri) });
		const inNested = vscode.window.createTerminal({ name: 'by hand nested', cwd: path.join(base, 'web', 'nested') });
		const hidden = vscode.window.createTerminal({ name: 'headless', cwd: vscode.Uri.parse(web.uri), hideFromUser: true });
		const elsewhere = vscode.window.createTerminal({ name: 'elsewhere', cwd: os.tmpdir() });
		created.push(inWeb, inNested, hidden, elsewhere);
		assert.deepStrictEqual(terminals.terminalsOf(web), [inWeb], 'hidden and nested ones are not web\'s');
		assert.deepStrictEqual(terminals.terminalsOf(nested), [inNested]);
	});

	test('switching brings the new project\'s terminal to the front, and keeps the old one running', async () => {
		const apiTerminal = terminals.open(api, true)!;
		const webTerminal = terminals.open(web, true)!;
		created.push(apiTerminal, webTerminal);
		await until(() => vscode.window.activeTerminal === webTerminal);

		fake.switchTo(api);
		await until(() => vscode.window.activeTerminal === apiTerminal);
		fake.switchTo(web);
		await until(() => vscode.window.activeTerminal === webTerminal);
		assert.strictEqual(apiTerminal.exitStatus, undefined, 'the other project\'s terminal still runs');
	});

	test('the terminal used last in a project is the one brought back', async () => {
		const first = terminals.open(api, true)!;
		const second = terminals.open(api, true)!;
		created.push(first, second);
		first.show(true);
		await until(() => vscode.window.activeTerminal === first);
		assert.strictEqual(terminals.terminalFor(api), first);
	});

	test('a terminal you hid stays hidden when you come back, until you show it again', async () => {
		const apiTerminal = terminals.open(api, true)!;
		const webTerminal = terminals.open(web, true)!;
		created.push(apiTerminal, webTerminal);
		fake.switchTo(api);
		await until(() => vscode.window.activeTerminal === apiTerminal);

		// Ctrl+` while the terminal shows (the toggle hides the panel).
		await terminals.toggle('workbench.action.terminal.toggleTerminal', true);
		assert.ok(terminals.isHiddenByUser(api));

		fake.switchTo(web);
		await until(() => vscode.window.activeTerminal === webTerminal);
		fake.switchTo(api);
		await new Promise(r => setTimeout(r, 200));
		assert.strictEqual(vscode.window.activeTerminal, webTerminal, "api's terminal was not brought back");
		assert.ok(terminals.isHiddenByUser(api));

		// Showing one of api's terminals (a click, Ctrl+`) makes it follow switches again.
		apiTerminal.show(true);
		await until(() => !terminals.isHiddenByUser(api));
	});

	test('a project without terminals gets none unless autoOpen is on', async () => {
		const before = vscode.window.terminals.length;
		fake.switchTo(web);
		await new Promise(r => setTimeout(r, 200));
		assert.strictEqual(vscode.window.terminals.length, before, 'nothing opened');

		await vscode.workspace.getConfiguration('workUniverse.projectTerminals').update('autoOpen', true, vscode.ConfigurationTarget.Global);
		fake.switchTo(api);
		await until(() => terminals.terminalsOf(api).length === 1);
		created.push(...terminals.terminalsOf(api));
	});
});
