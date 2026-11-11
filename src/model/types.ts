export interface Workspace {
	id: string;
	name: string;
	/** Folder URI, serialized with `Uri.toString()`. */
	uri: string;
	/** Codicon id, e.g. `server` or `browser`. */
	icon?: string;
	/** Hex color, e.g. `#1e6fd9`. */
	color?: string;
}

/**
 * How a universe uses the window:
 * - `isolated`: only the active workspace's folder is loaded, so search, source control and the
 *   Explorer show just that project. Every switch changes the window's folders.
 * - `together`: every folder stays loaded. Switching is faster (no folder change), but search,
 *   quick open and source control see all projects.
 */
export type UniverseMode = 'isolated' | 'together';

export interface Universe {
	id: string;
	name: string;
	workspaces: Workspace[];
	/** Active workspace id, or `ALL_WORKSPACES` for the cross-workspace search mode. */
	activeWorkspaceId?: string;
	createdAt: number;
	/** Anchor folder URI when it is not the generated one (e.g. a universe imported from a workspace file). */
	anchor?: string;
	/** Defaults to `isolated`. */
	mode?: UniverseMode;
	/** .code-workspace URI when it is not the generated one. */
	workspaceFile?: string;
}

/** Setting written into a universe's .code-workspace so any window can recognize it. */
export const UNIVERSE_ID_SETTING = 'workUniverse.universeId';

export const ALL_WORKSPACES = '*all*';

export type TabKind = 'text' | 'diff' | 'notebook';

export interface SavedTab {
	kind: TabKind;
	uri: string;
	/** Left-hand side of a diff tab. */
	originalUri?: string;
	label?: string;
	isPinned: boolean;
	isActive: boolean;
	/** [startLine, startChar, endLine, endChar] for editors that were visible. */
	selection?: [number, number, number, number];
}

export interface SavedGroup {
	viewColumn: number;
	isActive: boolean;
	tabs: SavedTab[];
}

export interface TabSession {
	groups: SavedGroup[];
}

export interface PendingActivation {
	universeId: string;
	workspaceId: string;
	createdAt: number;
}
