import * as assert from 'assert';
import { planFolderEdits } from '../universe/folderPlan';

/** Applies the edits like VS Code would, and records every folder that was removed. */
function apply(current: string[], desired: string[]) {
	const list = [...current];
	const removed: string[] = [];
	const edits = planFolderEdits(current, desired);
	for (const e of edits) {
		removed.push(...list.splice(e.start, e.deleteCount, ...e.insert.map(i => desired[i])));
	}
	return { list, removed, calls: edits.length };
}

suite('folder edits', () => {
	const cases: [string, string[], string[], number][] = [
		['nothing to do', ['a', 'b'], ['a', 'b'], 0],
		['all → one in the middle', ['a', 'b', 'c', 'd'], ['c'], 2],
		['all → first', ['a', 'b', 'c'], ['a'], 1],
		['all → last', ['a', 'b', 'c'], ['c'], 1],
		['one → all', ['c'], ['a', 'b', 'c', 'd'], 2],
		['one → another', ['a'], ['b'], 1],
		['several, partly overlapping', ['a', 'b', 'c'], ['b', 'x'], 2],
		['reordered: one folder has to move', ['a', 'b', 'c'], ['c', 'a', 'b'], 2],
		['empty → one', [], ['a'], 1],
	];
	for (const [name, current, desired, calls] of cases) {
		test(name, () => {
			const result = apply(current, desired);
			assert.deepStrictEqual(result.list, desired);
			assert.strictEqual(result.calls, calls, 'number of folder updates');
			// Folders loaded before and after are never removed, except one that has to move.
			const moved = name.startsWith('reordered') ? ['c'] : [];
			for (const kept of current.filter(f => desired.includes(f) && !moved.includes(f))) {
				assert.ok(!result.removed.includes(kept), `"${kept}" is loaded before and after, so it must not be removed`);
			}
		});
	}
});
