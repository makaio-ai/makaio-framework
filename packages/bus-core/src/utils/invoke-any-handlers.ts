import type { MakaioBusContext } from '../types/index.js';

/**
 * Maximum number of correlationIds to retain in the dedup cache before evicting
 * the oldest half. Sized to cover bursts of concurrent in-flight requests.
 */
const DEDUP_CACHE_MAX_SIZE = 1000;

/**
 * Module-level dedup cache for `__onAny` handlers.
 *
 * In a multi-hop dispatch chain (A→B→A), `invokeAnyHandlers` is called once per
 * local execution — meaning a 3-hop chain would fire `__onAny` 3 times for the
 * same logical request. This cache ensures `__onAny` fires at most once per logical
 * request (identified by `correlationId`) across all hops.
 *
 * Events and broadcasts never set a `correlationId`, so they are unaffected by this
 * cache and always fire normally.
 */
const seenCorrelationIds = new Set<string>();

/**
 * Record a correlationId as seen, evicting the oldest half of entries when the
 * cache exceeds {@link DEDUP_CACHE_MAX_SIZE}.
 * @param correlationId - The correlationId to record
 */
function markSeen(correlationId: string): void {
  if (seenCorrelationIds.size >= DEDUP_CACHE_MAX_SIZE) {
    const evictCount = DEDUP_CACHE_MAX_SIZE / 2;
    let evicted = 0;
    for (const id of seenCorrelationIds) {
      seenCorrelationIds.delete(id);
      evicted++;
      if (evicted >= evictCount) break;
    }
  }
  seenCorrelationIds.add(correlationId);
}

/**
 * Reset the deduplication cache for `__onAny` handlers.
 *
 * Intended for test teardown — clears the module-level `seenCorrelationIds` Set
 * so that correlation IDs from one test cannot suppress `__onAny` invocations in
 * the next test. This function is a no-op in production.
 */
export function resetSeenCorrelationIds(): void {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  seenCorrelationIds.clear();
}

/**
 * Invoke __onAny handlers for debugging/testing.
 * Fire and forget - errors are logged but don't block execution.
 * Noops in production.
 *
 * When a `correlationId` is provided (requests), this function deduplicates across
 * multi-hop dispatch chains: if `__onAny` has already fired for this `correlationId`
 * on this node, the call is a no-op. Events and broadcasts omit `correlationId` and
 * are always dispatched.
 * @param context - Makaio bus context containing anyHandlers set
 * @param type - Message type ('event', 'request', or 'broadcast')
 * @param subject - Subject identifier
 * @param namespace - Namespace identifier
 * @param payload - Message payload
 * @param messageId - Unique message identifier
 * @param correlationId - Optional correlation identifier for request tracking; used for deduplication
 */
export function invokeAnyHandlers(
  context: MakaioBusContext,
  type: 'event' | 'request' | 'broadcast',
  subject: string,
  namespace: string,
  payload: unknown,
  messageId: string,
  correlationId?: string,
): void {
  if (process.env.NODE_ENV === 'production' || context.anyHandlers.size === 0) {
    return;
  }

  if (correlationId !== undefined) {
    if (seenCorrelationIds.has(correlationId)) {
      return;
    }
    markSeen(correlationId);
  }

  const anyContext = { type, subject, namespace, payload, messageId, correlationId };
  for (const anyHandler of context.anyHandlers) {
    Promise.resolve()
      .then(() => anyHandler(anyContext))
      .catch((error) => {
        console.error(`[${messageId}] Error in __onAny handler:`, error);
      });
  }
}
