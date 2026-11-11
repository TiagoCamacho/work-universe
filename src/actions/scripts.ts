import * as vscode from 'vscode';
import { CustomAction } from './types';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/** Detects the package manager from the lockfile in `folder`. */
export async function detectPackageManager(folder: vscode.Uri): Promise<PackageManager> {
	const checks: [string, PackageManager][] = [
		['pnpm-lock.yaml', 'pnpm'],
		['yarn.lock', 'yarn'],
		['bun.lockb', 'bun'],
		['bun.lock', 'bun'],
	];
	for (const [file, pm] of checks) {
		if (await exists(vscode.Uri.joinPath(folder, file))) {
			return pm;
		}
	}
	return 'npm';
}

/**
 * A script name is put into a shell command (`npm run <name>`), and package.json comes from the
 * project, which may not be yours. A name like `dev; rm -rf ~` would run a second command, so
 * only names made of ordinary characters are turned into buttons.
 */
export function isSafeScriptName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_:.@/+-]*$/.test(name) && name.length <= 100;
}

export function runCommand(pm: PackageManager, script: string): string {
	if (!isSafeScriptName(script)) {
		throw new Error(`Unsafe script name: ${JSON.stringify(script)}`);
	}
	return pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
}

/** Best-guess codicon for a script name. */
export function guessIcon(script: string): string {
	const s = script.toLowerCase();
	const rules: [RegExp, string][] = [
		[/test|spec|jest|vitest|e2e/, 'beaker'],
		[/^(dev|start|serve)|:dev$|:start$/, 'play'],
		[/lint/, 'checklist'],
		[/format|prettier/, 'symbol-color'],
		[/watch/, 'eye'],
		[/deploy|release|publish/, 'rocket'],
		[/build|compile|bundle|package/, 'tools'],
		[/clean/, 'trash'],
		[/storybook/, 'book'],
		[/db|migrat|prisma|seed/, 'database'],
		[/docker/, 'vm'],
	];
	return rules.find(([re]) => re.test(s))?.[1] ?? 'terminal';
}

/** `scripts` from the workspace's root package.json (empty if there is none). */
export async function readScripts(folder: vscode.Uri): Promise<Record<string, string>> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'package.json'));
		const scripts = JSON.parse(new TextDecoder().decode(bytes))?.scripts;
		return scripts && typeof scripts === 'object' ? scripts : {};
	} catch {
		return {};
	}
}

/** One action per script, e.g. `{ label: "dev", icon: "play", command: "pnpm run dev" }`. */
export async function actionsFromScripts(folder: vscode.Uri, names: string[]): Promise<CustomAction[]> {
	const pm = await detectPackageManager(folder);
	return names.filter(isSafeScriptName).map(name => ({ label: name, icon: guessIcon(name), command: runCommand(pm, name) }));
}
