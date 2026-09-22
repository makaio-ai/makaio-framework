/**
 * In-memory index for fast evidence-based lookup of client runtime records.
 *
 * The map maintains three secondary indexes aligned with the matching priority
 * order enforced by {@link ClientRuntimeRegistry}:
 *
 * 1. `supervisorSessionId` (strongest)
 * 2. `pid + clientId`
 * 3. `adapterSessionId + clientId` (weakest)
 *
 * All mutations go through {@link RuntimeMap.set} and {@link RuntimeMap.delete}
 * so the secondary indexes stay consistent with the primary record store.
 * @packageDocumentation
 */

import type { ClientRuntimeRecord } from '../client-runtime-registry-types.js';

/**
 * Composite lookup key for pid+clientId evidence.
 * @param pid - OS process ID
 * @param clientId - Stable client identifier
 * @returns Composite lookup key
 */
function pidClientKey(pid: number, clientId: string): string {
  return `${pid}\0${clientId}`;
}

/**
 * Composite lookup key for adapterSessionId+clientId evidence.
 * @param adapterSessionId - Raw session identifier from the client runtime
 * @param clientId - Stable client identifier
 * @returns Composite lookup key
 */
function adapterSessionClientKey(adapterSessionId: string, clientId: string): string {
  return `${adapterSessionId}\0${clientId}`;
}

/**
 * In-memory index for client runtime records with evidence-based lookups.
 *
 * Acts as the fast-path lookup layer in front of the Drizzle persistence store.
 * The registry populates this map on boot (by loading persisted records) and
 * keeps it in sync on every upsert.
 */
export class RuntimeMap {
  private readonly records = new Map<string, ClientRuntimeRecord>();
  private readonly bySupervisorSessionId = new Map<string, string>();
  private readonly byPidClientId = new Map<string, string>();
  private readonly byAdapterSessionClientId = new Map<string, string>();
  private readonly supervisorSessionCandidates = new Map<string, Set<string>>();
  private readonly pidClientCandidates = new Map<string, Set<string>>();
  private readonly adapterSessionClientCandidates = new Map<string, Set<string>>();

  /**
   * In-memory provenance set tracking `(adapterSessionId, clientId)` pairs
   * that were bound by an adapter-layer observation of the **current process**.
   *
   * This set is the authoritative source for {@link hasAdapterSession}: only
   * pairs explicitly marked via {@link markAdapterOwned} are considered
   * adapter-managed. The evidence index (`byAdapterSessionClientId`) is
   * intentionally NOT consulted — it also contains entries from non-adapter
   * layers (e.g. `client-hook`) that must remain importable.
   *
   * **Intentionally in-memory-only.** Adapter-managed-ness is
   * present-tense runtime truth: after a restart, processes are re-observed
   * and the set is rebuilt from live adapter-layer observations.
   * {@link setFromStorage} does NOT populate this set — hydrated records
   * from a prior process do not count as "currently managed."
   */
  private readonly adapterOwnedSessions = new Set<string>();

  /**
   * Store a record in the primary map and update all secondary indexes.
   * @param record - Runtime record to store
   * @param priorRecord - Snapshot captured before an in-place record mutation
   */
  public set(record: ClientRuntimeRecord, priorRecord?: ClientRuntimeRecord): void {
    const prior = priorRecord ?? this.records.get(record.clientRuntimeId);
    if (prior) {
      this.removeIndexEntries(prior);
    }
    this.records.set(record.clientRuntimeId, record);
    this.addIndexEntries(record, true);
  }

  /**
   * Store a record hydrated from persistent storage.
   *
   * The record is always added to the primary map and the `supervisorSessionId`
   * index (UUIDs never recycle). The `pid` and `adapterSessionId` indexes are
   * only populated when `updatedAt` is within `staleThresholdMs` of `now`,
   * preventing recycled PIDs from matching stale records after a restart.
   *
   * **Intentionally does NOT call {@link markAdapterOwned}.** Hydrated
   * records from a prior process do not count as "currently adapter-managed"
   * — adapter-managed-ness is present-tense runtime truth that is rebuilt
   * from live adapter-layer observations after each restart.
   * @param record - Persisted runtime record to hydrate
   * @param now - Current epoch millisecond timestamp
   * @param staleThresholdMs - Maximum age in ms for pid/adapter indexes
   */
  public setFromStorage(record: ClientRuntimeRecord, now: number, staleThresholdMs: number): void {
    const prior = this.records.get(record.clientRuntimeId);
    if (prior) {
      this.removeIndexEntries(prior);
    }
    this.records.set(record.clientRuntimeId, record);
    const fresh = now - record.updatedAt <= staleThresholdMs;
    this.addIndexEntries(record, fresh);
  }

  /**
   * Remove a record from the primary map and all secondary indexes.
   * @param clientRuntimeId - Stable runtime identifier to remove
   */
  public delete(clientRuntimeId: string): void {
    const record = this.records.get(clientRuntimeId);
    if (record) {
      this.removeIndexEntries(record);
      if (record.adapterSessionId !== undefined) {
        this.adapterOwnedSessions.delete(adapterSessionClientKey(record.adapterSessionId, record.clientId));
      }
      this.records.delete(clientRuntimeId);
    }
  }

  /**
   * Retrieve a record by its stable runtime identifier.
   * @param clientRuntimeId - Stable runtime identifier
   * @returns The record, or `undefined` when not found
   */
  public get(clientRuntimeId: string): ClientRuntimeRecord | undefined {
    return this.records.get(clientRuntimeId);
  }

  /**
   * Find a runtime record using evidence fields, in matching-priority order:
   *
   * 1. `supervisorSessionId` — strongest, globally unique
   * 2. `pid + clientId` — can bind an observation that has not yet been
   *    assigned a supervisor session
   * 3. `adapterSessionId + clientId` — weakest, used as fallback
   * @param supervisorSessionId - Supervisor-assigned session ID, if available
   * @param pid - OS process ID, if available
   * @param adapterSessionId - Raw adapter session ID, if available
   * @param clientId - Stable client identifier
   * @returns The matched record, or `undefined` when no evidence matches
   */
  public findByEvidence(
    supervisorSessionId: string | undefined,
    pid: number | undefined,
    adapterSessionId: string | undefined,
    clientId: string,
  ): ClientRuntimeRecord | undefined {
    if (supervisorSessionId !== undefined) {
      const id = this.bySupervisorSessionId.get(supervisorSessionId);
      if (id !== undefined) {
        return this.records.get(id);
      }
    }

    if (pid !== undefined) {
      const id = this.byPidClientId.get(pidClientKey(pid, clientId));
      if (id !== undefined) {
        const record = this.records.get(id);
        if (record !== undefined) {
          return this.canMatchFallbackEvidence(record, supervisorSessionId) ? record : undefined;
        }
      }
    }

    if (adapterSessionId !== undefined) {
      const id = this.byAdapterSessionClientId.get(adapterSessionClientKey(adapterSessionId, clientId));
      if (id !== undefined) {
        const record = this.records.get(id);
        if (record !== undefined) {
          return this.canMatchFallbackEvidence(record, supervisorSessionId) ? record : undefined;
        }
      }
    }

    return undefined;
  }

  /**
   * Return all records currently held in the map.
   * @returns Iterable of all stored runtime records
   */
  public values(): IterableIterator<ClientRuntimeRecord> {
    return this.records.values();
  }

  /**
   * Remove all records and secondary indexes.
   */
  public clear(): void {
    this.records.clear();
    this.bySupervisorSessionId.clear();
    this.byPidClientId.clear();
    this.byAdapterSessionClientId.clear();
    this.supervisorSessionCandidates.clear();
    this.pidClientCandidates.clear();
    this.adapterSessionClientCandidates.clear();
    this.adapterOwnedSessions.clear();
  }

  /**
   * Mark an `(adapterSessionId, clientId)` pair as adapter-owned.
   *
   * Call this when a `client.runtime.observe` arrives with
   * `source.layer === 'adapter'` and an `adapterSessionId`. The pair is
   * added to the in-memory provenance set that backs
   * {@link hasAdapterSession}.
   *
   * The provenance set is intentionally **in-memory-only** — it is NOT
   * persisted and NOT populated by {@link setFromStorage}. Adapter-managed
   * status is present-tense runtime truth: after a restart, processes are
   * re-observed and the set is rebuilt from live adapter-layer observations.
   * @param adapterSessionId - Raw adapter session ID
   * @param clientId - Stable client identifier
   */
  public markAdapterOwned(adapterSessionId: string, clientId: string): void {
    this.adapterOwnedSessions.add(adapterSessionClientKey(adapterSessionId, clientId));
  }

  /**
   * Check whether an `(adapterSessionId, clientId)` pair was bound by an
   * adapter-layer observation of the **current process**.
   *
   * This is the runtime-truth predicate used by the log-importer skip
   * check (`client.runtime.isAdapterManaged`). It consults the in-memory
   * provenance set populated by {@link markAdapterOwned}, NOT the evidence
   * index. This distinction is critical: the evidence index also contains
   * entries from non-adapter layers (e.g. `client-hook` observations) whose
   * sessions must remain importable.
   * @param adapterSessionId - Raw adapter session ID
   * @param clientId - Stable client identifier
   * @returns `true` when the pair was marked adapter-owned in this process
   */
  public hasAdapterSession(adapterSessionId: string, clientId: string): boolean {
    return this.adapterOwnedSessions.has(adapterSessionClientKey(adapterSessionId, clientId));
  }

  /**
   * Return the number of records currently held.
   * @returns Number of records in the primary map
   */
  public get size(): number {
    return this.records.size;
  }

  private addIndexEntries(record: ClientRuntimeRecord, includeProcessEvidence: boolean): void {
    if (record.supervisorSessionId !== undefined) {
      this.setIndexEntry(
        this.bySupervisorSessionId,
        this.supervisorSessionCandidates,
        record.supervisorSessionId,
        record,
      );
    }
    if (includeProcessEvidence) {
      if (record.pid !== undefined) {
        this.setIndexEntry(
          this.byPidClientId,
          this.pidClientCandidates,
          pidClientKey(record.pid, record.clientId),
          record,
        );
      }
      if (record.adapterSessionId !== undefined) {
        this.setIndexEntry(
          this.byAdapterSessionClientId,
          this.adapterSessionClientCandidates,
          adapterSessionClientKey(record.adapterSessionId, record.clientId),
          record,
        );
      }
    }
  }

  private removeIndexEntries(record: ClientRuntimeRecord): void {
    if (record.supervisorSessionId !== undefined) {
      this.deleteIndexEntry(
        this.bySupervisorSessionId,
        this.supervisorSessionCandidates,
        record.supervisorSessionId,
        record.clientRuntimeId,
      );
    }
    if (record.pid !== undefined) {
      this.deleteIndexEntry(
        this.byPidClientId,
        this.pidClientCandidates,
        pidClientKey(record.pid, record.clientId),
        record.clientRuntimeId,
      );
    }
    if (record.adapterSessionId !== undefined) {
      this.deleteIndexEntry(
        this.byAdapterSessionClientId,
        this.adapterSessionClientCandidates,
        adapterSessionClientKey(record.adapterSessionId, record.clientId),
        record.clientRuntimeId,
      );
    }
  }

  /**
   * Determine whether fallback evidence may identify a runtime.
   *
   * A new supervisor session denotes a new native process. It may adopt a
   * prior pid-only observation, but it must not rekey an already supervised
   * process through a weaker pid or adapter-session match.
   * @param record - Runtime selected by fallback evidence
   * @param supervisorSessionId - Incoming supervisor identity, if available
   * @returns `true` when the fallback record can represent the observation
   */
  private canMatchFallbackEvidence(record: ClientRuntimeRecord, supervisorSessionId: string | undefined): boolean {
    return (
      supervisorSessionId === undefined ||
      record.supervisorSessionId === undefined ||
      record.supervisorSessionId === supervisorSessionId
    );
  }

  /**
   * Remove an eligible index candidate and restore the best remaining owner.
   * @param index - Secondary index to update
   * @param candidates - Eligible runtime IDs for each secondary index key
   * @param key - Composite or direct evidence key
   * @param clientRuntimeId - Runtime that is being removed or reindexed
   */
  private deleteIndexEntry(
    index: Map<string, string>,
    candidates: Map<string, Set<string>>,
    key: string,
    clientRuntimeId: string,
  ): void {
    const keyCandidates = candidates.get(key);
    if (!keyCandidates?.delete(clientRuntimeId)) {
      return;
    }
    if (keyCandidates.size === 0) {
      candidates.delete(key);
    }
    if (index.get(key) === clientRuntimeId) {
      const replacement = this.findBestIndexOwner(keyCandidates);
      if (replacement === undefined) {
        index.delete(key);
      } else {
        index.set(key, replacement.clientRuntimeId);
      }
    }
  }

  /**
   * Add an index entry when this record is the deterministic current owner.
   *
   * Creation time orders known generations. Equal timestamps use the stable
   * runtime ID only as a deterministic tie-break; they do not establish the
   * actual order in which native processes were created.
   * @param index - Secondary index to update
   * @param candidates - Eligible runtime IDs for each secondary index key
   * @param key - Composite or direct evidence key
   * @param candidate - Runtime proposed as the index owner
   */
  private setIndexEntry(
    index: Map<string, string>,
    candidates: Map<string, Set<string>>,
    key: string,
    candidate: ClientRuntimeRecord,
  ): void {
    let keyCandidates = candidates.get(key);
    if (keyCandidates === undefined) {
      keyCandidates = new Set<string>();
      candidates.set(key, keyCandidates);
    }
    keyCandidates.add(candidate.clientRuntimeId);
    const currentOwnerId = index.get(key);
    const currentOwner =
      currentOwnerId === undefined || !keyCandidates.has(currentOwnerId) ? undefined : this.records.get(currentOwnerId);
    if (currentOwner === undefined || this.isNewerIndexOwner(candidate, currentOwner)) {
      index.set(key, candidate.clientRuntimeId);
    }
  }

  /**
   * Select the deterministic owner among currently eligible runtime IDs.
   * @param candidates - Eligible runtime IDs for one secondary index key
   * @returns Best currently stored record, or `undefined` when none remains
   */
  private findBestIndexOwner(candidates: ReadonlySet<string>): ClientRuntimeRecord | undefined {
    let best: ClientRuntimeRecord | undefined;
    for (const clientRuntimeId of candidates) {
      const candidate = this.records.get(clientRuntimeId);
      if (candidate !== undefined && (best === undefined || this.isNewerIndexOwner(candidate, best))) {
        best = candidate;
      }
    }
    return best;
  }

  /**
   * Compare two records for deterministic index ownership.
   * @param candidate - Record proposed as the current owner
   * @param currentOwner - Record currently indexed for the evidence key
   * @returns `true` when the candidate must replace the current owner
   */
  private isNewerIndexOwner(candidate: ClientRuntimeRecord, currentOwner: ClientRuntimeRecord): boolean {
    return (
      candidate.createdAt > currentOwner.createdAt ||
      (candidate.createdAt === currentOwner.createdAt && candidate.clientRuntimeId > currentOwner.clientRuntimeId)
    );
  }
}
