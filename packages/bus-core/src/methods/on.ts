import type { HandlerEntry, MakaioBusContext, OnOptions } from '../types/index.js';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';
import { matchesFilter } from '../utils/payload-filter.js';
import { insertSorted } from '../utils/insert-sorted.js';
import { pushAdvertisedSubjectsToPeers } from '../registries/advertised-state.js';
import {
  type EventHandler,
  type HandlerForSubjectDefinition,
  type RequestHandler,
  type SubjectDefinition,
  WildcardSubjectKey,
} from '@makaio/core';

type HandlerMapKey = 'eventHandlers' | 'requestHandlers';

type AnyHandler = EventHandler<unknown> | RequestHandler<unknown, unknown>;
type OnCleanup = (() => void) & { [onPropagationPromiseSymbol]?: Promise<void> };

const onPropagationPromiseSymbol = Symbol('onPropagationPromise');

/**
 * Read the propagation promise attached to an `on()` cleanup function.
 *
 * Internal-only seam used by `once()` to defer timeout start until transport
 * subscription propagation settles. Public callers still see `() => void`.
 * @param cleanup - Cleanup function returned by {@link on}
 * @returns Propagation promise when the cleanup originated from {@link on}
 */
export function getOnPropagationPromise(cleanup: (() => void) | null | undefined): Promise<void> | undefined {
  return (cleanup as OnCleanup | null | undefined)?.[onPropagationPromiseSymbol];
}

/**
 * Add a handler to a handler map with priority-based ordering.
 * @param context - Makaio bus context
 * @param mapKey - Which handler map to add to
 * @param fullSubjectKey - Full subject key including namespace (used for map storage/lookup)
 * @param handler - Handler to add
 * @param priority - Handler priority (higher runs first, default: 0)
 */
function addToHandlerMap(
  context: MakaioBusContext,
  mapKey: HandlerMapKey,
  fullSubjectKey: string,
  handler: AnyHandler,
  priority: number,
): void {
  const map = context[mapKey];
  if (!map.has(fullSubjectKey)) {
    map.set(fullSubjectKey, []);
  }
  const entries = map.get(fullSubjectKey)!;
  insertSorted(entries, { handler, priority } as HandlerEntry<AnyHandler>);
}

/**
 * Remove a handler from a handler map and clean up empty entries.
 * @param context - Makaio bus context
 * @param mapKey - Which handler map to remove from
 * @param fullSubjectKey - Full subject key including namespace (used for map storage/lookup)
 * @param handler - Handler to remove
 */
function removeFromHandlerMap(
  context: MakaioBusContext,
  mapKey: HandlerMapKey,
  fullSubjectKey: string,
  handler: AnyHandler,
): void {
  const map = context[mapKey];
  const entries = map.get(fullSubjectKey);
  if (entries) {
    const index = entries.findIndex((entry) => entry.handler === handler);
    if (index !== -1) {
      entries.splice(index, 1);
    }
    if (entries.length === 0) {
      map.delete(fullSubjectKey);
    }
  }
}

/**
 * Register an event or request handler.
 *
 * Note on subject vs fullSubjectKey:
 * - `subject` is the short form (e.g., 'adapter.log')
 * - `fullSubjectKey` includes namespace (e.g., 'mynamespace:adapter.log')
 * - Message payloads use `subject` + `namespace` separately
 * - Handler maps/caching use `fullSubjectKey` for storage/lookup
 * @param context - Makaio bus context
 * @param subjectDefinition - Subject definition with subject pattern and metadata
 * @param handler - Handler function (EventHandler for events, RequestHandler for requests)
 * @param options - Optional filter and other subscription options
 * @returns Unsubscribe function
 * @see {@link IMakaioBus.on} for full documentation and examples.
 */
export function on<T extends SubjectDefinition>(
  context: MakaioBusContext,
  subjectDefinition: T,
  handler: HandlerForSubjectDefinition<T>,
  options?: OnOptions,
): () => void {
  const subject = subjectDefinition.subject;
  const fullSubjectKey = getFullSubjectForSubjectDefinition(subjectDefinition);
  const isRequest = subjectDefinition.$meta.isRequest;
  const isWildcard = subject.includes(WildcardSubjectKey) || subject.includes(':');
  const isAmbiguousWildcard = isWildcard && !isRequest;

  // Wrap handler with filter if provided
  const effectiveHandler: EventHandler<unknown> | RequestHandler<unknown, unknown> = options?.filter
    ? (ctx: { payload: unknown }) => {
        if (!matchesFilter(ctx.payload, options.filter!)) {
          return; // Filter didn't match, skip handler
        }
        return (handler as (ctx: unknown) => void | Promise<void>)(ctx);
      }
    : (handler as EventHandler<unknown> | RequestHandler<unknown, unknown>);

  // Determine which handler maps to register in
  // - Ambiguous wildcards: both event and request maps (can match either type)
  // - Request subjects: only request map
  // - Event subjects: only event map
  const handlerKind = isWildcard ? options?.handlerKind : undefined;
  const maps: HandlerMapKey[] =
    handlerKind === 'both'
      ? ['eventHandlers', 'requestHandlers']
      : handlerKind === 'event'
        ? ['eventHandlers']
        : handlerKind === 'request'
          ? ['requestHandlers']
          : isAmbiguousWildcard
            ? ['eventHandlers', 'requestHandlers']
            : isRequest
              ? ['requestHandlers']
              : ['eventHandlers'];

  // Add handler to appropriate map(s) using fullSubjectKey for storage
  const priority = options?.priority ?? 0;
  for (const mapKey of maps) {
    addToHandlerMap(context, mapKey, fullSubjectKey, effectiveHandler, priority);
  }

  // Design: Handler-level payload filters (options.filter) are applied locally
  // in the handler wrapper above — they are NOT propagated to transport subscribe
  // messages. This is intentional for two reasons:
  //
  // 1. For requests: A filter miss in the handler wrapper returns undefined,
  //    which auto-advances the dispatch chain to the next entry. The priority
  //    cursor is unaffected — remote nodes see the correct priority ordering.
  //    No correctness issue.
  //
  // 2. For events: All transports support filter-based delivery gating via
  //    BusSubscribeMessage.filters, but propagating handler filters requires
  //    solving the aggregation problem: when multiple handlers register for
  //    the same subject with different filters, what single filter should be
  //    advertised? (Union? No filter? Per-handler?) Until that design is
  //    resolved, local filtering is correct but slightly wasteful — remote
  //    peers deliver all events for the subject, and non-matching ones are
  //    dropped locally.
  //
  // To add transport-level filter propagation: thread options.filter through
  // pushAdvertisedSubjectsToPeers → pushAdvertisedSubject → transport.subscribe()
  // and resolve the multi-handler aggregation semantics.

  // Propagate the full aggregated advertised state to all transports.
  // Passing null for excludeTransportName includes all registered transports
  // (local handler change — not sourced from any specific transport).
  const propagated = pushAdvertisedSubjectsToPeers(context, null, [fullSubjectKey]);

  // Return unsubscribe function that cleans up from all registered maps
  const unsubscribe: OnCleanup = (): void => {
    for (const mapKey of maps) {
      removeFromHandlerMap(context, mapKey, fullSubjectKey, effectiveHandler);
    }

    // Push updated advertised state to all transports after handler removal.
    // The centralized function handles both cases:
    // - handlers remain → subscribe with updated (reduced) priority set
    // - no handlers remain → unsubscribe
    // Passing null includes all registered transports (local handler change).
    void pushAdvertisedSubjectsToPeers(context, null, [fullSubjectKey]);
  };

  // Attach propagation promise for internal consumers (once).
  // The public type remains () => void — only once.ts reads the internal symbol.
  unsubscribe[onPropagationPromiseSymbol] = propagated;

  return unsubscribe;
}
