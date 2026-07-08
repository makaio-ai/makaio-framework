import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects, SessionSubjects } from '@makaio/contracts';

/**
 * Create the default native-session detector used by log importers.
 *
 * The detector answers "should the importer skip this adapter session?".
 * It checks two sources of truth, in order:
 *
 * 1. **Runtime truth** (when `clientId` is provided): queries the
 *    `client.runtime.isAdapterManaged` subject — a fast, in-memory lookup
 *    against the client runtime registry. A `true` result here means a live
 *    runtime record exists for this `(adapterSessionId, clientId)` pair,
 *    confirming it is adapter-managed. This discriminates adapter-managed
 *    sessions from externally observed terminal sessions that share the
 *    same storage fingerprint (`isImported: true`, `importStatus: 'tracking'`).
 *
 * 2. **Storage truth**: queries `session.getByAdapterSessionId` for a native
 *    (non-imported) session row. This is the original predicate that catches
 *    sessions whose live row was created via `SessionSubjects.create`.
 *
 * Either source returning `true` causes the importer to skip the session.
 * @param clientId - Stable client identifier (e.g. `'claude-code'`). When
 *   provided, runtime-truth lookup is enabled for hook-first race detection.
 * @returns Function that checks whether an adapter session is Makaio-managed
 */
export function createDefaultCheckMakaioManaged(clientId?: string): (sessionId: string) => Promise<boolean> {
  return async (adapterSessionId: string): Promise<boolean> => {
    try {
      // Runtime truth: fast in-memory check against the client runtime registry.
      // This catches the hook-first race: even when the DB only has a tracking
      // stub (isImported=true), the runtime registry knows the session is
      // adapter-managed because it was registered via client.runtime.observe.
      if (clientId !== undefined) {
        try {
          const runtimeResult = await MakaioBus.requestOptional(ClientSubjects.runtime.isAdapterManaged, {
            adapterSessionId,
            clientId,
          });
          if (runtimeResult.handled && runtimeResult.data.managed) {
            return true;
          }
        } catch {
          // Runtime truth unavailable (bus error) — storage truth remains a
          // valid fallback, so we fall through to the storage query below.
        }
      }

      // Storage truth: original predicate — a non-imported session row exists.
      const result = await MakaioBus.request(SessionSubjects.getByAdapterSessionId, { adapterSessionId });
      return result.session !== null && !result.session.isImported;
    } catch {
      return false;
    }
  };
}

/**
 * Caches and deduplicates Makaio-managed session checks per adapter session.
 *
 * Supports targeted invalidation so external signals (e.g.
 * `client.runtime.started`) can evict a stale false-negative verdict.
 */
export class MakaioManagedSessionCache {
  private readonly checkedSessions = new Map<string, boolean>();
  private readonly inFlight = new Map<string, { generation: number; promise: Promise<boolean> }>();

  /**
   * Invalidation generation per adapter session ID.
   *
   * Incremented by {@link invalidate}; captured at check start. When the
   * generation at result-time differs from the generation at start-time, the
   * in-flight result is discarded instead of being persisted into the cache
   * — the awaiting caller re-evaluates with a fresh check.
   */
  private readonly generations = new Map<string, number>();

  /**
   * Check whether an adapter session should be skipped, reusing in-flight work.
   *
   * When an in-flight check is invalidated mid-flight, awaiting callers
   * detect the generation mismatch and re-evaluate instead of returning
   * the stale result.
   * @param adapterSessionId - External adapter session identifier
   * @param checkMakaioManaged - Detector function for native Makaio sessions
   * @param onSkipped - Callback invoked when the session should be skipped
   * @returns Promise resolving to true when the session should be skipped
   */
  public async isSkipped(
    adapterSessionId: string,
    checkMakaioManaged: (adapterSessionId: string) => Promise<boolean>,
    onSkipped: (adapterSessionId: string) => void,
  ): Promise<boolean> {
    // Re-evaluation loop: when an in-flight check is invalidated before the
    // awaiter consumes its result, the awaiter retries with the current
    // generation. The loop terminates because each iteration either caches
    // (generation stable) or retries against a strictly newer generation;
    // invalidations are finite in practice (bounded by external signals).
    while (true) {
      const cached = this.checkedSessions.get(adapterSessionId);
      if (cached !== undefined) {
        return cached;
      }

      const startGeneration = this.generations.get(adapterSessionId) ?? 0;

      const existing = this.inFlight.get(adapterSessionId);
      let promise: Promise<boolean>;

      if (existing && existing.generation === startGeneration) {
        promise = existing.promise;
      } else {
        promise = checkMakaioManaged(adapterSessionId)
          .then((isManaged) => {
            // Only persist when no invalidation occurred during the
            // async check — stale verdicts must not re-populate the cache.
            const currentGen = this.generations.get(adapterSessionId) ?? 0;
            if (currentGen === startGeneration) {
              this.checkedSessions.set(adapterSessionId, isManaged);
              if (isManaged) {
                onSkipped(adapterSessionId);
              }
            }
            return isManaged;
          })
          .finally(() => {
            // Only clean up our own registration: an invalidation may
            // have evicted this entry and a newer check may already be
            // in flight.
            const current = this.inFlight.get(adapterSessionId);
            if (current && current.generation === startGeneration) {
              this.inFlight.delete(adapterSessionId);
            }
          });
        this.inFlight.set(adapterSessionId, {
          generation: startGeneration,
          promise,
        });
      }

      await promise;

      // If the generation changed while we were awaiting, the result is
      // stale — loop back and re-evaluate with the current generation.
      const currentGeneration = this.generations.get(adapterSessionId) ?? 0;
      if (currentGeneration === startGeneration) {
        // Generation stable: the .then() handler above already cached the
        // result. Return it (or, if it somehow missed, the loop retries).
        const result = this.checkedSessions.get(adapterSessionId);
        if (result !== undefined) {
          return result;
        }
        // Defensive: result not cached despite stable generation — retry.
        continue;
      }
      // Generation changed: discard stale result, re-evaluate.
    }
  }

  /**
   * Remove the cached verdict for a specific adapter session ID.
   *
   * Called when external signals (e.g. `client.runtime.started`) indicate
   * that a previously cached verdict may be stale. Evicts both the cached
   * verdict and any in-flight check so the next `isSkipped` call starts a
   * fresh evaluation; the generation counter additionally prevents the
   * evicted in-flight check from re-populating the cache when it settles.
   * Callers already awaiting the evicted promise detect the generation
   * mismatch and re-evaluate with a fresh check, ensuring they receive a
   * current verdict rather than the stale one.
   * @param adapterSessionId - Adapter session ID whose verdict should be evicted
   */
  public invalidate(adapterSessionId: string): void {
    this.checkedSessions.delete(adapterSessionId);
    this.inFlight.delete(adapterSessionId);
    this.generations.set(adapterSessionId, (this.generations.get(adapterSessionId) ?? 0) + 1);
  }

  /** Clear cached and in-flight session checks. */
  public clear(): void {
    this.checkedSessions.clear();
    this.inFlight.clear();
    this.generations.clear();
  }
}
