import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import * as vscode from 'vscode';
import { panelHtml } from '../ui/panelHtml';

interface Posted {
	type: string;
	[key: string]: unknown;
}

/** Runs the panel's real HTML + script in jsdom, with a fake `acquireVsCodeApi`. */
function createPanel() {
	const fakeWebview = { cspSource: 'x', asWebviewUri: (u: vscode.Uri) => u } as unknown as vscode.Webview;
	const html = panelHtml(fakeWebview, vscode.Uri.file('/codicon.css'))
		.replace(/<meta http-equiv[^>]*>/, '')
		.replace(/<link rel="stylesheet"[^>]*>/, '');
	const sent: Posted[] = [];
	const errors: string[] = [];
	const dom = new JSDOM(html, {
		runScripts: 'dangerously',
		pretendToBeVisual: true,
		beforeParse(window) {
			const w = window as unknown as Record<string, unknown>;
			// Messages are created inside jsdom's own JavaScript realm; copy them into ours so
			// deepStrictEqual compares plain arrays and objects.
			w.acquireVsCodeApi = () => ({
				postMessage: (m: Posted) => sent.push(JSON.parse(JSON.stringify(m))),
				getState: () => undefined,
				setState: () => undefined,
			});
			w.CSS = { escape: (s: string) => s };
			window.addEventListener('error', e => errors.push(e.message));
		},
	});
	const { window } = dom;
	const doc = window.document;
	const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
	return {
		sent,
		errors,
		post,
		/** Messages of a type sent since the last call to `take`. */
		take(type: string): Posted[] {
			const found = sent.filter(m => m.type === type);
			sent.length = 0;
			return found;
		},
		rows: () => [...doc.querySelectorAll('.row .label')].map(e => e.textContent),
		rowCount: () => doc.querySelectorAll('.row').length,
		activeTab: () => doc.querySelector('.tab.active .name')?.textContent,
		click(selector: string, text: string) {
			const el = [...doc.querySelectorAll(selector)].find(e => e.textContent === text);
			assert.ok(el, `no ${selector} with text "${text}"`);
			(el.closest('button, .row') as HTMLElement).click();
		},
		modeTitle: () => doc.querySelector('.tool.mode')?.getAttribute('title'),
		clickMode: () => (doc.querySelector('.tool.mode') as HTMLElement).click(),
		spacerHeight: () => (doc.querySelector('.vspace') as HTMLElement | null)?.style.height,
		doc,
		close: () => window.close(),
	};
}

const rootOf = (id: string) => ({ key: `file:///${id}`, uri: `file:///${id}`, name: id });
const stateFor = (active: string) => ({
	type: 'state',
	inUniverse: true,
	allMode: false,
	workspaceKey: active,
	hasIconTheme: false,
	hidesArrows: false,
	roots: [rootOf(active)],
	tabs: ['w1', 'w2'].map(id => ({ id, name: id, icon: 'folder', active: id === active, root: rootOf(id) })),
	actions: [],
	activeWorkspaceId: active,
	universes: [],
});
const file = (parent: string, name: string) => ({ key: `${parent}/${name}`, uri: `${parent}/${name}`, name, dir: false });
const dir = (parent: string, name: string) => ({ key: `${parent}/${name}`, uri: `${parent}/${name}`, name, dir: true });

suite('panel webview behaviour', () => {
	test('first visit asks for folders in one message and renders the answer', () => {
		const panel = createPanel();
		try {
			assert.deepStrictEqual(panel.take('ready').length, 1);
			panel.post(stateFor('w1'));
			const requests = panel.take('listMany');
			assert.strictEqual(requests.length, 1);
			assert.deepStrictEqual((requests[0].items as { key: string }[]).map(i => i.key), ['file:///w1']);

			panel.post({ type: 'childrenMany', lists: [{ key: 'file:///w1', rows: [dir('file:///w1', 'src'), file('file:///w1', 'a.ts')] }] });
			assert.deepStrictEqual(panel.rows(), ['src', 'a.ts']);

			// The mode button shows the current mode and asks the host to change it.
			assert.ok(panel.modeTitle()?.startsWith('Mode: Separate environments'));
			panel.clickMode();
			assert.strictEqual(panel.take('mode').length, 1);
			panel.post({ ...stateFor('w1'), mode: 'together' });
			assert.ok(panel.modeTitle()?.startsWith('Mode: All together'));
			assert.deepStrictEqual(panel.errors, []);
		} finally {
			panel.close();
		}
	});

	test('switching back shows the cached tree at once and refreshes it in one request', () => {
		const panel = createPanel();
		try {
			panel.post(stateFor('w1'));
			panel.post({ type: 'childrenMany', lists: [{ key: 'file:///w1', rows: [dir('file:///w1', 'src'), file('file:///w1', 'a.ts')] }] });
			panel.click('.row .label', 'src'); // expand
			panel.post({ type: 'childrenMany', lists: [{ key: 'file:///w1/src', rows: [file('file:///w1/src', 'deep.ts')] }] });
			assert.deepStrictEqual(panel.rows(), ['src', 'deep.ts', 'a.ts']);

			panel.post(stateFor('w2'));
			panel.post({ type: 'childrenMany', lists: [{ key: 'file:///w2', rows: [file('file:///w2', 'other.ts')] }] });
			assert.deepStrictEqual(panel.rows(), ['other.ts']);
			panel.take('listMany');

			// Back to w1: the full tree, including the expanded folder, is there before any answer.
			panel.post(stateFor('w1'));
			assert.deepStrictEqual(panel.rows(), ['src', 'deep.ts', 'a.ts'], 'cached tree shown immediately');
			const refresh = panel.take('listMany');
			assert.strictEqual(refresh.length, 1, 'one batched refresh request');
			assert.deepStrictEqual(
				(refresh[0].items as { key: string }[]).map(i => i.key).sort(),
				['file:///w1', 'file:///w1/src'],
			);

			// The refresh answer updates the tree (a file was added meanwhile).
			panel.post({
				type: 'childrenMany',
				lists: [
					{ key: 'file:///w1/src', rows: [file('file:///w1/src', 'deep.ts'), file('file:///w1/src', 'new.ts')] },
					{ key: 'file:///w1', rows: [dir('file:///w1', 'src'), file('file:///w1', 'a.ts')] },
				],
			});
			assert.deepStrictEqual(panel.rows(), ['src', 'deep.ts', 'new.ts', 'a.ts']);
			assert.deepStrictEqual(panel.errors, []);
		} finally {
			panel.close();
		}
	});

	test('clicking a tab switches the panel before the host answers, and the host can revert it', () => {
		const panel = createPanel();
		try {
			panel.post(stateFor('w2'));
			panel.post({ type: 'childrenMany', lists: [{ key: 'file:///w2', rows: [file('file:///w2', 'other.ts')] }] });
			panel.post(stateFor('w1'));
			panel.post({ type: 'childrenMany', lists: [{ key: 'file:///w1', rows: [file('file:///w1', 'a.ts')] }] });
			panel.take('listMany');

			panel.click('.tab .name', 'w2');
			assert.strictEqual(panel.activeTab(), 'w2', 'tab highlighted at once');
			assert.deepStrictEqual(panel.rows(), ['other.ts'], 'cached tree of the clicked workspace shown at once');
			assert.strictEqual(panel.sent.filter(m => m.type === 'switch').length, 1);

			// The host cancels (e.g. unsaved files): it reports w1 again.
			panel.post(stateFor('w1'));
			assert.strictEqual(panel.activeTab(), 'w1');
			assert.deepStrictEqual(panel.rows(), ['a.ts']);
			assert.deepStrictEqual(panel.errors, []);
		} finally {
			panel.close();
		}
	});

	test('only the rows in view are rendered, however large the folder', () => {
		const panel = createPanel();
		try {
			panel.post(stateFor('w1'));
			const rows = Array.from({ length: 5000 }, (_, i) => file('file:///w1', `file${i}.ts`));
			const start = performance.now();
			panel.post({ type: 'childrenMany', lists: [{ key: 'file:///w1', rows }] });
			const ms = performance.now() - start;
			assert.ok(panel.rowCount() > 0 && panel.rowCount() < 100, `rendered ${panel.rowCount()} rows`);
			assert.strictEqual(panel.spacerHeight(), `${5000 * 22}px`, 'scroll height covers every row');
			assert.ok(ms < 500, `rendering a 5,000-file folder took ${Math.round(ms)} ms`);

			// "refresh" with keys only re-reads those folders.
			panel.take('listMany');
			panel.post({ type: 'refresh', keys: ['file:///w1', 'file:///elsewhere'] });
			const refresh = panel.take('listMany');
			assert.deepStrictEqual((refresh[0].items as { key: string }[]).map(i => i.key), ['file:///w1']);
			assert.deepStrictEqual(panel.errors, []);
		} finally {
			panel.close();
		}
	});
	test('solution view: virtual nodes, auto-expanded solution and nested files', () => {
		const panel = createPanel();
		try {
			const root = { key: 'file:///w1/app.sln#sln', uri: 'file:///w1', name: 'w1' };
			panel.post({ ...stateFor('w1'), roots: [root] });
			const first = panel.take('listMany')[0].items as { key: string; rootKey: string }[];
			assert.deepStrictEqual(first, [{ key: root.key, uri: 'file:///w1', root: 'file:///w1', rootKey: root.key }]);

			const sol = { key: root.key + ':s', uri: 'file:///w1/app.sln', name: "Solution 'app' (1 of 1 project)", dir: true, virt: true, section: 'solution', open: true };
			panel.post({ type: 'childrenMany', lists: [{ key: root.key, rows: [sol] }] });
			const auto = panel.take('listMany');
			assert.deepStrictEqual((auto[0].items as { key: string; rootKey: string }[]).map(i => [i.key, i.rootKey]), [[sol.key, root.key]], 'solution node expands by itself');

			const project = { key: root.key + ':p:1', uri: 'file:///w1/App', name: 'App', dir: true, virt: true, section: 'project', drop: 'file:///w1/App' };
			panel.post({ type: 'childrenMany', lists: [{ key: sol.key, rows: [project] }] });
			panel.click('.row .label', 'App');
			assert.deepStrictEqual(panel.take('select').pop()?.items, [], 'virtual nodes are never selected for file commands');
			const settings = { ...file('file:///w1/App', 'appsettings.json'), nest: true, alias: 'file:///w1/app' };
			panel.post({ type: 'childrenMany', lists: [{ key: project.key, rows: [settings] }] });
			assert.deepStrictEqual(panel.rows(), [sol.name, 'App', 'appsettings.json']);

			// A click on the name opens the file; a click on its arrow expands it.
			panel.click('.row .label', 'appsettings.json');
			assert.strictEqual(panel.take('open').length, 1);
			const twistie = [...panel.doc.querySelectorAll('.row')].find(r => r.textContent === 'appsettings.json')!.querySelector('.twistie') as HTMLElement;
			twistie.click();
			assert.deepStrictEqual((panel.take('listMany')[0].items as { key: string }[]).map(i => i.key), [settings.key]);
			panel.post({ type: 'childrenMany', lists: [{ key: settings.key, rows: [file('file:///w1/App', 'appsettings.Development.json')] }] });
			assert.deepStrictEqual(panel.rows(), [sol.name, 'App', 'appsettings.json', 'appsettings.Development.json']);

			// A file-watcher refresh of the project folder reaches the nested file through its alias.
			panel.post({ type: 'refresh', keys: ['file:///w1/app'] });
			assert.deepStrictEqual((panel.take('listMany')[0].items as { key: string }[]).map(i => i.key), [settings.key]);
			assert.deepStrictEqual(panel.errors, []);
		} finally {
			panel.close();
		}
	});
});
