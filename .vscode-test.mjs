import { defineConfig } from '@vscode/test-cli';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Builds a throwaway universe on disk so the integration tests run inside a real universe window:
 *   <root>/universes/test/universe.code-workspace   (anchor + project "a")
 *   <root>/universes/test/anchor/.vscode/settings.json
 *   <root>/projects/{a,b}/...
 * The root is passed to the tests through WORK_UNIVERSE_TEST_ROOT.
 */
function createFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-universe-test-'));
	const universeDir = path.join(root, 'universes', 'test');
	const anchor = path.join(universeDir, 'anchor');
	fs.mkdirSync(path.join(anchor, '.vscode'), { recursive: true });
	fs.writeFileSync(
		path.join(anchor, '.vscode', 'settings.json'),
		JSON.stringify({ 'files.exclude': { '**': true }, 'search.exclude': { '**': true } }),
	);
	for (const [name, file] of [['a', 'alpha.txt'], ['b', 'beta.txt']]) {
		const dir = path.join(root, 'projects', name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, file), `hello from ${name}\nneedle-${name}\n`);
	}
	const wsFile = path.join(universeDir, 'universe.code-workspace');
	fs.writeFileSync(
		wsFile,
		JSON.stringify(
			{
				folders: [
					{ path: anchor, name: '◈ Test' },
					{ path: path.join(root, 'projects', 'a'), name: 'a' },
				],
				settings: {},
			},
			null,
			'\t',
		),
	);
	return { root, wsFile };
}

const fixture = createFixture();

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: fixture.wsFile,
	env: { WORK_UNIVERSE_TEST_ROOT: fixture.root },
	mocha: { timeout: 20000 },
});
