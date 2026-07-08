/**
 * In-memory registry for client runtime instances with optional persistence.
 *
 * The registry is the single source of truth for `clientRuntimeId`. It:
 * 1. Accepts runtime observations with evidence fields.
 * 2. Matches existing runtimes by evidence priority:
 *    `supervisorSessionId` → `pid + clientId` → `adapterSessionId + clientId`.
 * 3. Creates a new runtime record when no match is found.
 * 4. Enriches existing records with stronger evidence.
 * 5. Promotes records from `'observed'` to `'started'` when strong evidence arrives.
 * 6. Optionally persists mutations via a bus-backed storage handler.
 *
 * The registry is a **pure class** — it does not extend BaseService and has
 * no opinion about the bus lifetime. Persistence is wired in by the service
 * layer via the optional `persistRecord` callback.
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ClientRuntimeObserveRequest } from '@makaio/contracts/client';
import type { ClientRuntimeRecord, RuntimeUpsertResult } from './client-runtime-registry-types.js';
import { RuntimeMap } from './storage/runtime-map.js';
import { ClientRuntimeStorageSubjects } from './storage/runtime-storage-namespace.js';

/**
 * Records whose `updatedAt` is older than this threshold at boot time will not
 * have their pid or adapterSessionId indexes populated during hydration. This
 * prevents recycled PIDs from matching stale records across restarts.
 * supervisorSessionId indexes are always hydrated because they are UUIDs.
 */
const STALE_PID_THRESHOLD_MS = 24 * 60 * 60 * 1_000;

/**
 * Determines whether a runtime status should be promoted given incoming evidence.
 *
 * Promotion from `'observed'` to `'started'` occurs when:
 * - A `supervisorSessionId` is present (supervisor confirmed the launch), or
 * - An `adapterSessionId` is present (adapter confirmed the process is running).
 * @param input - Incoming observation evidence
 * @returns `true` when the evidence warrants promotion to `'started'`
 */
function evidenceWarrantsStarted(input: ClientRuntimeObserveRequest): boolean {
  return input.supervisorSessionId !== undefined || input.adapterSessionId !== undefined;
}

/**
 * Clone a runtime record across the registry boundary.
 * @param record - Runtime record to clone
 * @returns Detached runtime record snapshot
 */
function cloneRuntimeRecord(record: ClientRuntimeRecord): ClientRuntimeRecord {
  return {
    ...record,
    argv: record.argv === undefined ? undefined : [...record.argv],
    metadata: record.metadata === undefined ? undefined : structuredClone(record.metadata),
  };
}

/**
 * Produce a storage freshness timestamp that is strictly newer than the
 * existing record, even when multiple observations land in the same millisecond.
 * @param existingUpdatedAt - Current registry-owned `updatedAt` value
 * @returns Monotonic mutation timestamp
 */
function nextUpdatedAt(existingUpdatedAt: number): number {
  return Math.max(Date.now(), existingUpdatedAt + 1);
}

/**
 * Enrich a mutable runtime record with non-undefined fields from the observation.
 *
 * Stronger evidence fields always overwrite weaker prior values. Enrichment
 * never clears previously set fields — it only adds or promotes.
 * @param record - Mutable runtime record to enrich in place
 * @param input - Incoming observation evidence
 * @returns `true` when at least one field was changed
 */
function enrichRecord(record: ClientRuntimeRecord, input: ClientRuntimeObserveRequest): boolean {
  let changed = false;

  if (input.supervisorSessionId !== undefined && record.supervisorSessionId !== input.supervisorSessionId) {
    record.supervisorSessionId = input.supervisorSessionId;
    changed = true;
  }
  if (input.pid !== undefined && record.pid !== input.pid) {
    record.pid = input.pid;
    changed = true;
  }
  if (input.parentPid !== undefined && record.parentPid !== input.parentPid) {
    record.parentPid = input.parentPid;
    changed = true;
  }
  if (input.adapterSessionId !== undefined && record.adapterSessionId !== input.adapterSessionId) {
    record.adapterSessionId = input.adapterSessionId;
    changed = true;
  }
  if (input.sessionId !== undefined && record.sessionId !== input.sessionId) {
    record.sessionId = input.sessionId;
    changed = true;
  }
  if (input.cwd !== undefined && record.cwd !== input.cwd) {
    record.cwd = input.cwd;
    changed = true;
  }
  // argv and metadata are reference types — use JSON comparison to avoid
  // false-positive changes when the same values arrive with different references
  if (input.argv !== undefined && JSON.stringify(record.argv) !== JSON.stringify(input.argv)) {
    record.argv = [...input.argv];
    changed = true;
  }
  if (input.metadata !== undefined && JSON.stringify(record.metadata) !== JSON.stringify(input.metadata)) {
    record.metadata = structuredClone(input.metadata);
    changed = true;
  }

  return changed;
}

/**
 * In-memory registry that canonicalizes client runtime instances across
 * evidence fields and optionally persists them via a bus-backed handler.
 *
 * Construct the registry with an optional bus instance. When a bus is
 * provided, every upsert is mirrored to the Drizzle handler via the
 * `client-runtime:storage.upsert` subject. Call {@link loadFromStorage}
 * once at boot to hydrate the in-memory map from persisted records.
 */
export class ClientRuntimeRegistry {
  private readonly runtimeMap = new RuntimeMap();
  private readonly bus: IMakaioBus | undefined;

  /**
   * Creates a new runtime registry.
   * @param bus - Optional bus instance used to persist runtime records. When
   *   absent, the registry operates purely in memory without persistence.
   */
  public constructor(bus?: IMakaioBus) {
    this.bus = bus;
  }

  /**
   * Hydrate the in-memory map from all records persisted in storage.
   *
   * Must be called once at service boot before accepting observations. When
   * no bus is wired in, this is a no-op.
   */
  public async loadFromStorage(): Promise<void> {
    if (!this.bus) {
      return;
    }
    const result = await this.bus.requestOptional(ClientRuntimeStorageSubjects.loadAll, {});
    if (!result.handled) {
      return;
    }
    const now = Date.now();
    for (const record of result.data.records) {
      this.runtimeMap.setFromStorage(cloneRuntimeRecord(record), now, STALE_PID_THRESHOLD_MS);
    }
  }

  /**
   * Upsert a runtime record for the provided observation evidence.
   *
   * Matching priority:
   * 1. `supervisorSessionId` — globally unique; matches across clients.
   * 2. `pid + clientId` — strong OS-level identity.
   * 3. `adapterSessionId + clientId` — weaker adapter-level identity.
   *
   * When no existing record matches, a new runtime is created. When a match
   * is found, the record is enriched with any new evidence fields and promoted
   * to `'started'` when the incoming evidence warrants it.
   * @param input - Runtime observation evidence
   * @returns Upsert result with the stable `clientRuntimeId` and change flags
   */
  public async upsertRuntime(input: ClientRuntimeObserveRequest): Promise<RuntimeUpsertResult> {
    // Priority-based lookup: returns the strongest single match. When multiple
    // evidence fields point to different records, the strongest wins and weaker
    // records remain unreferenced. Multi-match merging is a v2 concern.
    const existing = this.runtimeMap.findByEvidence(
      input.supervisorSessionId,
      input.pid,
      input.adapterSessionId,
      input.clientId,
    );

    if (existing) {
      const wasObserved = existing.status === 'observed';
      const willStart = wasObserved && evidenceWarrantsStarted(input);
      const fieldsChanged = enrichRecord(existing, input);
      const refreshObserved = wasObserved && input.observedAt > existing.observedAt;

      if (willStart) {
        existing.status = 'started';
      }

      if (fieldsChanged || willStart || refreshObserved) {
        existing.updatedAt = nextUpdatedAt(existing.updatedAt);
        if (refreshObserved) {
          existing.observedAt = input.observedAt;
        }
        // Re-register in map to update secondary indexes for any new fields
        this.runtimeMap.set(existing);
        await this.persistRecord(existing);
      }

      return {
        clientRuntimeId: existing.clientRuntimeId,
        created: false,
        promoted: willStart,
        record: cloneRuntimeRecord(existing),
      };
    }

    const now = Date.now();
    const clientRuntimeId = randomUUID();
    const status = evidenceWarrantsStarted(input) ? 'started' : 'observed';

    const newRecord: ClientRuntimeRecord = {
      clientRuntimeId,
      clientId: input.clientId,
      status,
      supervisorSessionId: input.supervisorSessionId,
      pid: input.pid,
      parentPid: input.parentPid,
      adapterSessionId: input.adapterSessionId,
      sessionId: input.sessionId,
      cwd: input.cwd,
      argv: input.argv ? [...input.argv] : undefined,
      metadata: input.metadata ? structuredClone(input.metadata) : undefined,
      observedAt: input.observedAt,
      createdAt: now,
      updatedAt: now,
    };

    this.runtimeMap.set(newRecord);
    await this.persistRecord(newRecord);

    return {
      clientRuntimeId,
      created: true,
      promoted: false,
      record: cloneRuntimeRecord(newRecord),
    };
  }

  /**
   * Retrieve a runtime record by its stable ID.
   *
   * Returns a detached snapshot so caller mutations cannot affect registry
   * records or secondary indexes.
   * @param clientRuntimeId - Stable runtime identifier
   * @returns The record, or `undefined` when not found
   */
  public getRuntime(clientRuntimeId: string): ClientRuntimeRecord | undefined {
    const record = this.runtimeMap.get(clientRuntimeId);
    return record ? cloneRuntimeRecord(record) : undefined;
  }

  /**
   * Mark an `(adapterSessionId, clientId)` pair as adapter-owned.
   *
   * The service layer calls this when a `client.runtime.observe` arrives
   * with `source.layer === 'adapter'` and an `adapterSessionId`. This
   * populates the in-memory provenance set that backs
   * {@link hasAdapterSession}.
   *
   * The registry deliberately does not inspect source-layer metadata
   * itself — it speaks the vocabulary of "adapter-owned," and the service
   * layer decides when that label applies.
   * @param adapterSessionId - Raw adapter session ID
   * @param clientId - Stable client identifier
   */
  public markAdapterOwned(adapterSessionId: string, clientId: string): void {
    this.runtimeMap.markAdapterOwned(adapterSessionId, clientId);
  }

  /**
   * Check whether an `(adapterSessionId, clientId)` pair was bound by an
   * adapter-layer observation of the **current process**.
   *
   * This is the in-memory runtime-truth lookup used by the
   * `client.runtime.isAdapterManaged` handler. It returns `true` only
   * when {@link markAdapterOwned} was called for this pair — NOT merely
   * when a runtime record with a matching `adapterSessionId` exists in
   * the evidence index. This distinction prevents hook-bridge observations
   * (layer `'client-hook'`) from being falsely classified as adapter-managed.
   * @param adapterSessionId - Raw adapter session ID
   * @param clientId - Stable client identifier
   * @returns `true` when the pair was marked adapter-owned in this process
   */
  public hasAdapterSession(adapterSessionId: string, clientId: string): boolean {
    return this.runtimeMap.hasAdapterSession(adapterSessionId, clientId);
  }

  /**
   * Remove all in-memory state.
   *
   * Does not touch persisted records — the storage layer is authoritative
   * across restarts. Call {@link loadFromStorage} to re-hydrate.
   */
  public clear(): void {
    this.runtimeMap.clear();
  }

  /**
   * Return the number of runtime records currently held in memory.
   * @returns Number of runtime records in the in-memory map
   */
  public get size(): number {
    return this.runtimeMap.size;
  }

  private async persistRecord(record: ClientRuntimeRecord): Promise<void> {
    if (!this.bus) {
      return;
    }
    await this.bus.requestOptional(ClientRuntimeStorageSubjects.upsert, cloneRuntimeRecord(record));
  }
}
