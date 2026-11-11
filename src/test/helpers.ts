import * as vscode from 'vscode';

/** In-memory `vscode.Memento` for tests. */
export class MemoryMemento implements vscode.Memento {
	private readonly data = new Map<string, unknown>();

	keys(): readonly string[] {
		return [...this.data.keys()];
	}

	get<T>(key: string, defaultValue?: T): T {
		return (this.data.has(key) ? structuredClone(this.data.get(key)) : defaultValue) as T;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.data.delete(key);
		} else {
			this.data.set(key, structuredClone(value));
		}
	}
}
