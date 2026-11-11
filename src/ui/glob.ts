/**
 * Minimal glob → RegExp for `files.exclude` patterns (`**`, `*`, `?`, `{a,b}`, `[abc]`),
 * matched against a folder-relative path with `/` separators.
 */
export function globToRegExp(glob: string): RegExp {
	let re = '';
	let inGroup = false;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		switch (c) {
			case '*':
				if (glob[i + 1] === '*') {
					// `**/` matches zero or more directories; a trailing `**` matches anything.
					if (glob[i + 2] === '/') {
						re += '(?:.*/)?';
						i += 2;
					} else {
						re += '.*';
						i += 1;
					}
				} else {
					re += '[^/]*';
				}
				break;
			case '?':
				re += '[^/]';
				break;
			case '{':
				inGroup = true;
				re += '(?:';
				break;
			case '}':
				inGroup = false;
				re += ')';
				break;
			case ',':
				re += inGroup ? '|' : ',';
				break;
			case '[': {
				const end = glob.indexOf(']', i);
				if (end > i) {
					re += '[' + glob.slice(i + 1, end).replace(/\\/g, '\\\\') + ']';
					i = end;
				} else {
					re += '\\[';
				}
				break;
			}
			default:
				re += /[.+^$()|\\]/.test(c) ? '\\' + c : c;
		}
	}
	return new RegExp('^' + re + '$', process.platform === 'linux' ? '' : 'i');
}

/** Compiles the enabled entries of a `files.exclude`-style object. `when` clauses are ignored. */
export function compileExcludes(patterns: Record<string, unknown> | undefined): RegExp[] {
	return Object.entries(patterns ?? {})
		.filter(([, enabled]) => enabled === true)
		.map(([glob]) => globToRegExp(glob.replace(/^\.\//, '').replace(/\/$/, '')));
}

export function isExcluded(relativePath: string, excludes: readonly RegExp[]): boolean {
	return excludes.some(re => re.test(relativePath));
}
