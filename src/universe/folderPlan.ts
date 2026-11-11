/** One `vscode.workspace.updateWorkspaceFolders` call: indices are into the current folder list. */
export interface FolderEdit {
	start: number;
	deleteCount: number;
	/** Indices into the desired list of the folders to insert at `start`. */
	insert: number[];
}

/**
 * The folder edits that turn `current` into `desired` (both lists of folder keys) without
 * touching folders that are in both. Removing and re-adding a folder makes language servers such
 * as C# Dev Kit close and reload every project in it, so a folder that stays loaded must not be
 * part of an edit.
 *
 * The folders kept are the longest common subsequence of both lists; each gap between them
 * becomes one edit (removals and additions at the same place are combined). The edits are ordered
 * from the end of the list to the start, so each one's indices are still valid after the previous
 * ones were applied.
 */
export function planFolderEdits(current: readonly string[], desired: readonly string[]): FolderEdit[] {
	const [ci, di] = commonSubsequence(current, desired);
	const k = ci.length;
	const edits: FolderEdit[] = [];
	for (let g = k; g >= 0; g--) {
		const cStart = g === 0 ? 0 : ci[g - 1] + 1;
		const cEnd = g === k ? current.length : ci[g];
		const dStart = g === 0 ? 0 : di[g - 1] + 1;
		const dEnd = g === k ? desired.length : di[g];
		if (cEnd > cStart || dEnd > dStart) {
			edits.push({ start: cStart, deleteCount: cEnd - cStart, insert: range(dStart, dEnd) });
		}
	}
	return edits;
}

/** Index pairs (in `a` and in `b`) of a longest common subsequence. Lists are short: O(n·m) is fine. */
function commonSubsequence(a: readonly string[], b: readonly string[]): [number[], number[]] {
	const len = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
		}
	}
	const ai: number[] = [];
	const bi: number[] = [];
	for (let i = 0, j = 0; i < a.length && j < b.length; ) {
		if (a[i] === b[j]) {
			ai.push(i++);
			bi.push(j++);
		} else if (len[i + 1][j] >= len[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return [ai, bi];
}

const range = (start: number, end: number) => Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
