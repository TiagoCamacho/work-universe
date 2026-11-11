// Creates .dev/ with a sample universe so "Run Extension (Universe)" starts the Extension
// Development Host directly inside a universe (no reload, which would end the debug session).
// Existing files are left alone, so folders you add while testing are kept between runs.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '.dev');
const universeDir = path.join(root, 'universe');
const anchor = path.join(universeDir, 'anchor');
const wsFile = path.join(universeDir, 'universe.code-workspace');

function write(file, content) {
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
}

write(
	path.join(anchor, '.vscode', 'settings.json'),
	JSON.stringify({ 'files.exclude': { '**': true }, 'search.exclude': { '**': true }, 'files.watcherExclude': { '**': true } }, null, '\t'),
);

const pkg = (name, scripts) => JSON.stringify({ name, version: '1.0.0', scripts }, null, '\t') + '\n';

const samples = {
	'sample-backend': {
		'package.json': pkg('sample-backend', {
			dev: "node -e \"setInterval(() => console.log('backend tick'), 1000)\"",
			test: "node -e \"console.log('2 tests passed')\"",
			build: "node -e \"console.log('built')\"",
		}),
		'src/server.ts': "import { listUsers } from './users';\n\nconsole.log('backend listening', listUsers());\n",
		'src/users.ts': "export function listUsers() {\n\treturn ['ada', 'linus']; // TODO backend\n}\n",
		'README.md': '# Sample backend\n',
	},
	'sample-frontend': {
		'package.json': pkg('sample-frontend', {
			dev: "node -e \"setInterval(() => console.log('frontend tick'), 1000)\"",
			lint: "node -e \"console.log('no lint errors')\"",
		}),
		'src/App.tsx': "export function App() {\n\treturn <h1>Hello from the frontend</h1>; // TODO frontend\n}\n",
		'src/components/Button.tsx': 'export const Button = () => <button>Click</button>;\n',
		'index.html': '<!doctype html>\n<div id="root"></div>\n',
	},
};
for (const [project, files] of Object.entries(samples)) {
	for (const [rel, content] of Object.entries(files)) {
		write(path.join(root, project, rel), content);
	}
}

write(
	wsFile,
	JSON.stringify(
		{
			folders: [
				{ path: 'anchor', name: '◈ Dev Universe' },
				{ path: '../sample-backend', name: 'backend' },
				{ path: '../sample-frontend', name: 'frontend' },
			],
			settings: { 'workUniverse.universeId': 'dev-universe', 'workUniverse.universeName': 'Dev Universe' },
		},
		null,
		'\t',
	) + '\n',
);

console.log('dev universe ready: ' + wsFile);
