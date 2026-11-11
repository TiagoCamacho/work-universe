import * as vscode from 'vscode';

/** Phases of the most recent timeline per label, in ms since its start (read by tests). */
export const lastTimings: Record<string, Record<string, number>> = {};

let channel: vscode.LogOutputChannel | undefined;
const starts: Record<string, number> = {};

/** Creates the "Work Universe" log channel that timings are written to. */
export function initPerf(context: vscode.ExtensionContext): void {
	channel = vscode.window.createOutputChannel('Work Universe', { log: true });
	context.subscriptions.push(channel);
}

export function logError(what: string, err: unknown): void {
	const text = `${what}: ${err instanceof Error ? err.message : String(err)}`;
	if (channel) {
		channel.error(text);
	} else {
		console.error('[work-universe] ' + text);
	}
}

export interface Timeline {
	/** Records the time since the timeline started under `phase`. */
	mark(phase: string): void;
	/** Marks `total` and writes one log line with every phase. */
	done(detail?: string): void;
}

/** Starts a timeline, e.g. `timeline('switch')`, whose phases end up in one log line. */
export function timeline(label: string): Timeline {
	const start = performance.now();
	const marks: Record<string, number> = {};
	starts[label] = start;
	lastTimings[label] = marks;
	const mark = (phase: string) => {
		marks[phase] = Math.round((performance.now() - start) * 10) / 10;
	};
	return {
		mark,
		done(detail) {
			mark('total');
			const phases = Object.entries(marks)
				.map(([k, v]) => `${k}=${v}ms`)
				.join(' ');
			channel?.info(`${label}${detail ? ' ' + detail : ''}: ${phases}`);
		},
	};
}

/** Adds a late phase (e.g. the webview reporting its paint) to the latest timeline of `label`. */
export function markLate(label: string, phase: string): void {
	const start = starts[label];
	const marks = lastTimings[label];
	if (start === undefined || !marks || marks[phase] !== undefined) {
		return;
	}
	const ms = Math.round((performance.now() - start) * 10) / 10;
	if (ms < 10000) {
		marks[phase] = ms;
		channel?.info(`${label}: ${phase}=${ms}ms`);
	}
}
