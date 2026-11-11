import * as vscode from 'vscode';
import { PendingActivation, TabSession, Universe, Workspace } from './types';

const KEY_UNIVERSES = 'wu.universes';
const KEY_SESSIONS = 'wu.sessions';
const KEY_PENDING = 'wu.pendingActivation';

/** A pending activation older than this is ignored (e.g. the reload never happened). */
const PENDING_TTL_MS = 2 * 60 * 1000;

export function newId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Persists universes, per-workspace tab sessions and the pending activation in global state. */
export class UniverseStore implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly memento: vscode.Memento) {}

	dispose(): void {
		this._onDidChange.dispose();
	}

	/** Fires change listeners, e.g. when another window may have modified global state. */
	refresh(): void {
		this._onDidChange.fire();
	}

	// ---- universes -------------------------------------------------------

	getUniverses(): Universe[] {
		return this.memento.get<Universe[]>(KEY_UNIVERSES, []);
	}

	getUniverse(id: string): Universe | undefined {
		return this.getUniverses().find(u => u.id === id);
	}

	findWorkspace(workspaceId: string): { universe: Universe; workspace: Workspace } | undefined {
		for (const universe of this.getUniverses()) {
			const workspace = universe.workspaces.find(w => w.id === workspaceId);
			if (workspace) {
				return { universe, workspace };
			}
		}
		return undefined;
	}

	async createUniverse(name: string): Promise<Universe> {
		const universe: Universe = { id: newId(), name, workspaces: [], createdAt: Date.now() };
		await this.saveUniverses([...this.getUniverses(), universe]);
		return universe;
	}

	/** Adds a universe defined elsewhere (e.g. read from an opened workspace file). */
	async importUniverse(universe: Universe): Promise<void> {
		await this.saveUniverses([...this.getUniverses().filter(u => u.id !== universe.id), universe]);
	}

	async reorderWorkspaces(universeId: string, orderedIds: string[]): Promise<void> {
		await this.updateUniverse(universeId, u => {
			const rank = (id: string) => {
				const i = orderedIds.indexOf(id);
				return i < 0 ? Number.MAX_SAFE_INTEGER : i;
			};
			u.workspaces.sort((a, b) => rank(a.id) - rank(b.id));
		});
	}

	async updateUniverse(id: string, mutate: (u: Universe) => void): Promise<Universe | undefined> {
		const universes = this.getUniverses().map(u => structuredClone(u));
		const target = universes.find(u => u.id === id);
		if (!target) {
			return undefined;
		}
		mutate(target);
		await this.saveUniverses(universes);
		return target;
	}

	async deleteUniverse(id: string): Promise<void> {
		const universe = this.getUniverse(id);
		await this.saveUniverses(this.getUniverses().filter(u => u.id !== id));
		if (universe) {
			const sessions = { ...this.getSessions() };
			for (const ws of universe.workspaces) {
				delete sessions[ws.id];
			}
			await this.memento.update(KEY_SESSIONS, sessions);
		}
	}

	async addWorkspaces(universeId: string, folders: { uri: vscode.Uri; name: string; solution?: vscode.Uri }[]): Promise<Workspace[]> {
		const added: Workspace[] = [];
		await this.updateUniverse(universeId, u => {
			for (const folder of folders) {
				const uri = folder.uri.toString();
				if (u.workspaces.some(w => w.uri === uri)) {
					continue;
				}
				const ws: Workspace = { id: newId(), name: folder.name, uri };
				if (folder.solution) {
					ws.solution = folder.solution.toString();
				}
				u.workspaces.push(ws);
				added.push(ws);
			}
		});
		return added;
	}

	async updateWorkspace(workspaceId: string, mutate: (w: Workspace) => void): Promise<void> {
		const found = this.findWorkspace(workspaceId);
		if (!found) {
			return;
		}
		await this.updateUniverse(found.universe.id, u => {
			const ws = u.workspaces.find(w => w.id === workspaceId);
			if (ws) {
				mutate(ws);
			}
		});
	}

	async removeWorkspace(workspaceId: string): Promise<void> {
		const found = this.findWorkspace(workspaceId);
		if (!found) {
			return;
		}
		await this.updateUniverse(found.universe.id, u => {
			u.workspaces = u.workspaces.filter(w => w.id !== workspaceId);
			if (u.activeWorkspaceId === workspaceId) {
				u.activeWorkspaceId = undefined;
			}
		});
		await this.setSession(workspaceId, undefined);
	}

	async setActiveWorkspace(universeId: string, workspaceId: string | undefined): Promise<void> {
		await this.updateUniverse(universeId, u => {
			u.activeWorkspaceId = workspaceId;
		});
	}

	private async saveUniverses(universes: Universe[]): Promise<void> {
		await this.memento.update(KEY_UNIVERSES, universes);
		this._onDidChange.fire();
	}

	// ---- tab sessions ----------------------------------------------------

	private getSessions(): Record<string, TabSession> {
		return this.memento.get<Record<string, TabSession>>(KEY_SESSIONS, {});
	}

	getSession(workspaceId: string): TabSession | undefined {
		return this.getSessions()[workspaceId];
	}

	async setSession(workspaceId: string, session: TabSession | undefined): Promise<void> {
		const sessions = { ...this.getSessions() };
		if (session) {
			sessions[workspaceId] = session;
		} else {
			delete sessions[workspaceId];
		}
		await this.memento.update(KEY_SESSIONS, sessions);
	}

	// ---- pending activation (survives the one reload into a universe) -----

	async setPending(pending: PendingActivation | undefined): Promise<void> {
		await this.memento.update(KEY_PENDING, pending);
	}

	/** Returns and clears the pending activation for the given universe, if fresh. */
	async takePending(universeId: string): Promise<PendingActivation | undefined> {
		const pending = this.memento.get<PendingActivation>(KEY_PENDING);
		if (!pending || pending.universeId !== universeId) {
			return undefined;
		}
		await this.setPending(undefined);
		return Date.now() - pending.createdAt < PENDING_TTL_MS ? pending : undefined;
	}
}
