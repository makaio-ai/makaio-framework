/**
 * Supervisor runtime registry.
 *
 * Combines an in-memory lookup cache with a persistent storage layer
 * (accessed via bus subjects). The in-memory map is keyed by
 * `supervisorSessionId` (canonical primary key) and indexed by `sessionId`
 * and `adapterSessionId` for efficient secondary lookups.
 *
 * The registry is authoritative for the running process state. The storage
 * layer provides durability across process restarts.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { SupervisorRuntime, SupervisorRuntimeInit, SupervisorRuntimeUpdate } from './types.js';
import { SupervisorRuntimeStorageSubjects } from './storage/namespace.js';

/**
 * In-memory + persistent registry for supervised native process runtimes.
 *
 * Callers interact with this registry via typed methods. All mutations are
 * persisted via the bus storage subjects first; the in-memory indices are only
 * updated after the storage write succeeds, so the two layers stay consistent.
 *
 * Lookups are O(1) against the in-memory map for `supervisorSessionId`, and
 * O(1) for `sessionId`/`adapterSessionId` via secondary index maps.
 * @example
 * ```typescript
 * const registry = new RuntimeRegistry(bus);
 * await registry.loadFromStorage();
 *
 * // Register a new runtime after spawning
 * await registry.register({
 *   supervisorSessionId: 'sup_abc',
 *   clientId: 'claude-code',
 *   pid: 12345,
 *   cwd: '/home/user',
 *   command: 'claude',
 *   args: [],
 *   startedAt: Date.now(),
 * });
 *
 * // Look up by any correlation key
 * const runtime = registry.getBySupervisorId('sup_abc');
 * const runtime2 = registry.getBySessionId('sess_xyz');
 * const runtime3 = registry.getByAdapterSessionId('adp_123');
 * ```
 */
export class RuntimeRegistry {
  /** Primary index: supervisorSessionId → runtime */
  private readonly _byId = new Map<string, SupervisorRuntime>();
  /** Secondary index: sessionId → supervisorSessionId */
  private readonly _bySessionId = new Map<string, string>();
  /** Secondary index: adapterSessionId → supervisorSessionId */
  private readonly _byAdapterSessionId = new Map<string, string>();

  /**
   * @param bus - Bus instance used for storage subject access.
   */
  public constructor(private readonly bus: IMakaioBus) {}

  // ---------------------------------------------------------------------------
  // Hydration
  // ---------------------------------------------------------------------------

  /**
   * Load all persisted runtimes from storage into the in-memory cache.
   *
   * Should be called once during service initialization before any lookups
   * are performed.
   * @returns Promise that resolves when the cache has been populated.
   */
  public async loadFromStorage(): Promise<void> {
    const { runtimes } = await this.bus.request(SupervisorRuntimeStorageSubjects.list, {});

    for (const runtime of runtimes) {
      this._indexRuntime(runtime);
    }
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Register a new supervised runtime in the registry and persist it.
   * @param init - Full runtime initialization data including `supervisorSessionId`.
   * @returns Promise that resolves when the runtime has been persisted.
   */
  public async register(init: SupervisorRuntimeInit): Promise<void> {
    const runtime: SupervisorRuntime = {
      ...init,
      status: 'running',
    };

    const { success } = await this.bus.request(SupervisorRuntimeStorageSubjects.set, runtime);
    if (!success) {
      throw new Error(`Failed to persist runtime ${init.supervisorSessionId} to storage`);
    }
    this._indexRuntime(runtime);
  }

  /**
   * Apply a partial update to an existing runtime entry.
   *
   * Updates the in-memory record and persists the change. Secondary indices
   * are updated when correlation fields change.
   *
   * **Limitation:** correlation fields (`sessionId`, `adapterSessionId`) are
   * assumed to be set once at launch and never removed. Because
   * `SupervisorRuntimeUpdate` uses `Partial<Pick<...>>`, passing
   * `sessionId: undefined` is indistinguishable from omitting the field
   * entirely — the update is treated as a no-op for that field rather than a
   * clear. Clearing a correlation field is not currently supported.
   * @param update - Partial update payload containing `supervisorSessionId` and changed fields.
   * @returns Promise that resolves after the update has been persisted.
   *   Returns `false` when no runtime was found for the given ID or when
   *   storage returns `success: false` (in which case in-memory indices are
   *   left untouched).
   */
  public async update(update: SupervisorRuntimeUpdate): Promise<boolean> {
    const existing = this._byId.get(update.supervisorSessionId);
    if (existing === undefined) return false;

    // Build the partial diff once and reuse it for both the merged runtime and the storage payload.
    const diff = {
      ...(update.pid !== undefined && { pid: update.pid }),
      ...(update.status !== undefined && { status: update.status }),
      ...(update.sessionId !== undefined && { sessionId: update.sessionId }),
      ...(update.adapterSessionId !== undefined && { adapterSessionId: update.adapterSessionId }),
      ...(update.stoppedAt !== undefined && { stoppedAt: update.stoppedAt }),
      ...(update.metadata !== undefined && { metadata: update.metadata }),
    };

    const updated: SupervisorRuntime = { ...existing, ...diff };

    const { success } = await this.bus.request(SupervisorRuntimeStorageSubjects.update, {
      supervisorSessionId: update.supervisorSessionId,
      ...diff,
    });

    if (!success) return false;

    // Remove stale secondary indices and apply new ones only after storage confirms the write.
    if (update.sessionId !== undefined && existing.sessionId !== update.sessionId) {
      if (existing.sessionId !== undefined) {
        this._bySessionId.delete(existing.sessionId);
      }
    }
    if (update.adapterSessionId !== undefined && existing.adapterSessionId !== update.adapterSessionId) {
      if (existing.adapterSessionId !== undefined) {
        this._byAdapterSessionId.delete(existing.adapterSessionId);
      }
    }
    this._indexRuntime(updated);

    return true;
  }

  /**
   * Remove a runtime from the registry and delete it from storage.
   * @param supervisorSessionId - Canonical ID of the runtime to remove.
   * @returns Promise that resolves after deletion.
   *   Returns `false` when no runtime was found or when storage returns
   *   `success: false` (in which case in-memory indices are left untouched).
   */
  public async remove(supervisorSessionId: string): Promise<boolean> {
    const existing = this._byId.get(supervisorSessionId);
    if (existing === undefined) return false;

    const { success } = await this.bus.request(SupervisorRuntimeStorageSubjects.delete, { supervisorSessionId });

    if (!success) return false;

    this._removeIndex(existing);

    return true;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Look up a runtime by its canonical supervisor session ID.
   * @param supervisorSessionId - Supervisor-assigned session ID.
   * @returns The runtime entry, or `undefined` when not found.
   */
  public getBySupervisorId(supervisorSessionId: string): SupervisorRuntime | undefined {
    return this._byId.get(supervisorSessionId);
  }

  /**
   * Look up a runtime by its Makaio framework session ID.
   * @param sessionId - Framework session ID.
   * @returns The runtime entry, or `undefined` when not found.
   */
  public getBySessionId(sessionId: string): SupervisorRuntime | undefined {
    const id = this._bySessionId.get(sessionId);
    return id !== undefined ? this._byId.get(id) : undefined;
  }

  /**
   * Look up a runtime by its adapter-assigned session ID.
   * @param adapterSessionId - Adapter-assigned session ID.
   * @returns The runtime entry, or `undefined` when not found.
   */
  public getByAdapterSessionId(adapterSessionId: string): SupervisorRuntime | undefined {
    const id = this._byAdapterSessionId.get(adapterSessionId);
    return id !== undefined ? this._byId.get(id) : undefined;
  }

  /**
   * Return all runtime entries currently held in memory.
   * @returns Array of all registered runtimes.
   */
  public getAll(): SupervisorRuntime[] {
    return Array.from(this._byId.values());
  }

  /**
   * Return all runtime entries matching the given status.
   * @param status - Lifecycle status to filter by.
   * @returns Array of matching runtimes.
   */
  public getByStatus(status: SupervisorRuntime['status']): SupervisorRuntime[] {
    return Array.from(this._byId.values()).filter((r) => r.status === status);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Add or replace a runtime in the primary map and update secondary indices.
   * @param runtime - Runtime to index.
   */
  private _indexRuntime(runtime: SupervisorRuntime): void {
    this._byId.set(runtime.supervisorSessionId, runtime);

    if (runtime.sessionId !== undefined) {
      this._bySessionId.set(runtime.sessionId, runtime.supervisorSessionId);
    }
    if (runtime.adapterSessionId !== undefined) {
      this._byAdapterSessionId.set(runtime.adapterSessionId, runtime.supervisorSessionId);
    }
  }

  /**
   * Remove all index entries for the given runtime.
   * @param runtime - Runtime whose entries should be removed.
   */
  private _removeIndex(runtime: SupervisorRuntime): void {
    this._byId.delete(runtime.supervisorSessionId);

    if (runtime.sessionId !== undefined) {
      this._bySessionId.delete(runtime.sessionId);
    }
    if (runtime.adapterSessionId !== undefined) {
      this._byAdapterSessionId.delete(runtime.adapterSessionId);
    }
  }
}
