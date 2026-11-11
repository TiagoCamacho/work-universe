/** A button in a workspace's action row. */
export interface CustomAction {
	label: string;
	/** Codicon id, e.g. `play`. */
	icon: string;
	/** Shell command, run in the action's own terminal. */
	command?: string;
	/** VS Code command id, run with `args`. */
	vscodeCommand?: string;
	args?: unknown[];
	/** Working directory relative to the workspace folder. */
	cwd?: string;
	env?: Record<string, string>;
	/** Hex color for the icon. */
	color?: string;
	/** Run without showing the terminal. */
	headless?: boolean;
	/** While running, show `$(icon) label` in the status bar; clicking it shows the terminal. */
	show_status_bar?: boolean;
}

export interface ActionsFile {
	/** Hex color for icons whose command is running; `undefined` when unset or "none". */
	active_color?: string;
	actions: CustomAction[];
}

export const DEFAULT_ACTION_ICON = 'terminal';
