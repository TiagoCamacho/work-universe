import * as vscode from 'vscode';

/** Color customization keys owned by this extension; any others the user set are left untouched. */
const OWNED_KEYS = [
	'titleBar.activeBackground',
	'titleBar.activeForeground',
	'titleBar.inactiveBackground',
	'titleBar.inactiveForeground',
	'activityBar.activeBorder',
	'statusBar.background',
	'statusBar.foreground',
] as const;

export const PRESET_COLORS: { label: string; hex: string }[] = [
	{ label: 'Blue', hex: '#1f6feb' },
	{ label: 'Teal', hex: '#0e8a7e' },
	{ label: 'Green', hex: '#2d8a3e' },
	{ label: 'Yellow', hex: '#b58900' },
	{ label: 'Orange', hex: '#c9510c' },
	{ label: 'Red', hex: '#c62828' },
	{ label: 'Pink', hex: '#c2185b' },
	{ label: 'Purple', hex: '#7b3fbf' },
	{ label: 'Slate', hex: '#4a5568' },
];

export function isHexColor(value: string): boolean {
	return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

function expand(hex: string): string {
	const h = hex.trim().replace('#', '');
	return h.length === 3 ? h.split('').map(c => c + c).join('') : h;
}

/** Black or white, whichever reads better on `hex`. */
export function contrastColor(hex: string): string {
	const h = expand(hex);
	const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c =>
		c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
	);
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance > 0.4 ? '#000000' : '#ffffff';
}

export function colorCustomizationsFor(hex: string | undefined): Record<string, string> {
	if (!hex || !isHexColor(hex)) {
		return {};
	}
	const color = '#' + expand(hex);
	const fg = contrastColor(color);
	return {
		'titleBar.activeBackground': color,
		'titleBar.activeForeground': fg,
		'titleBar.inactiveBackground': color + 'b3',
		'titleBar.inactiveForeground': fg + 'b3',
		'activityBar.activeBorder': color,
		'statusBar.background': color,
		'statusBar.foreground': fg,
	};
}

/** Writes (or clears) the workspace color into the current .code-workspace settings. */
export async function applyWorkspaceColor(hex: string | undefined): Promise<void> {
	const enabled = vscode.workspace.getConfiguration('workUniverse').get<boolean>('applyColors', true);
	const config = vscode.workspace.getConfiguration('workbench');
	const current = config.inspect<Record<string, unknown>>('colorCustomizations')?.workspaceValue ?? {};
	const next: Record<string, unknown> = { ...current };
	for (const key of OWNED_KEYS) {
		delete next[key];
	}
	if (enabled) {
		Object.assign(next, colorCustomizationsFor(hex));
	}
	if (JSON.stringify(next) === JSON.stringify(current)) {
		return;
	}
	await config.update(
		'colorCustomizations',
		Object.keys(next).length ? next : undefined,
		vscode.ConfigurationTarget.Workspace,
	);
}
