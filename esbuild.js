const esbuild = require("esbuild");
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

const codiconsDir = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');

/** Copies the codicon font used by the panel webview into dist/codicons. */
function copyCodicons() {
	const dest = path.join(__dirname, 'dist', 'codicons');
	fs.mkdirSync(dest, { recursive: true });
	for (const file of ['codicon.css', 'codicon.ttf']) {
		fs.copyFileSync(path.join(codiconsDir, file), path.join(dest, file));
	}
}

/** JSON schema for custom action files (*.wu-actions.json), with every codicon name as an icon suggestion. */
function writeActionsSchema() {
	const metadata = JSON.parse(fs.readFileSync(path.join(codiconsDir, 'metadata.json'), 'utf8'));
	const icons = Object.keys(metadata).sort();
	const HEX = '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$';
	const schema = {
		$schema: 'http://json-schema.org/draft-07/schema#',
		title: 'Work Universe custom actions',
		type: 'object',
		required: ['actions'],
		properties: {
			active_color: {
				description: 'Hex color given to the icons of actions that are running, or "none" to keep the normal colors.',
				anyOf: [{ type: 'string', format: 'color-hex', pattern: HEX }, { enum: ['none'] }],
				default: 'none',
			},
			actions: {
				type: 'array',
				description: 'Buttons shown under the workspace tabs.',
				items: {
					type: 'object',
					required: ['label'],
					additionalProperties: false,
					properties: {
						label: { type: 'string', description: 'Name of the action, shown as the button tooltip.' },
						icon: {
							type: 'string',
							description: 'Codicon name, e.g. "play", "beaker", "tools". See https://microsoft.github.io/vscode-codicons/dist/codicon.html',
							anyOf: [{ enum: icons }, { type: 'string' }],
							default: 'terminal',
						},
						command: { type: 'string', description: "Shell command, run in the action's own terminal in the workspace folder (e.g. \"npm run dev\")." },
						vscodeCommand: { type: 'string', description: 'VS Code command id to run instead of a shell command (e.g. "typescript.restartTsServer").' },
						args: { type: 'array', description: 'Arguments passed to the VS Code command.' },
						cwd: { type: 'string', description: 'Working directory, relative to the workspace folder.' },
						env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables for the terminal.' },
						color: { type: 'string', format: 'color-hex', pattern: HEX, description: 'Hex color of the icon when idle, e.g. "#d29922".' },
						headless: { type: 'boolean', default: false, description: 'true runs the command without showing its terminal. Press the button again while it runs to show or restart it.' },
						show_status_bar: { type: 'boolean', default: false, description: 'true shows the icon and label in the status bar while the command runs. Click it to bring up the terminal.' },
					},
					oneOf: [
						{ required: ['command'], not: { required: ['vscodeCommand'] } },
						{ required: ['vscodeCommand'], not: { required: ['command'] } },
					],
					defaultSnippets: [
						{ label: 'Shell command', body: { label: '$1', icon: '${2:play}', command: '$3' } },
						{ label: 'VS Code command', body: { label: '$1', icon: '${2:zap}', vscodeCommand: '$3' } },
					],
				},
			},
		},
	};
	fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
	fs.writeFileSync(path.join(__dirname, 'dist', 'actions.schema.json'), JSON.stringify(schema, null, '\t'));
}

async function main() {
	copyCodicons();
	writeActionsSchema();
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
