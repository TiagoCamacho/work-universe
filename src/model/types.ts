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

export interface Universe {
	id: string;
	name: string;
	workspaces: Workspace[];
	/** Active workspace id, or `ALL_WORKSPACES` for the cross-workspace search mode. */
	activeWorkspaceId?: string;
	createdAt: number;
}

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
