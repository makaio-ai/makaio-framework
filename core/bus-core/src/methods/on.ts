import type { HandlerEntry, MakaioBusContext, OnOptions } from '../types/index.js';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';
import { matchesFilter } from '../utils/payload-filter.js';
import { insertSorted } from '../utils/insert-sorted.js';
import { pushAdvertisedSubjectsToPeers } from '../registries/advertised-state.js';
import { warnIfUnregistered } from '../utils/warn-unregistered.js';
import { ignoredSubscription, subscriptionSignal, trackSubscription } from '../subscription-lifetime.js';
import {
  type EventHandler,
  type HandlerForSubjectDefinition,
  type PartyRef,
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
 * Wait until a handler registration has propagated to registered transports.
 *
 * `on()` still returns a plain cleanup function for public ergonomics, but
 * remote transports subscribe asynchronously. Callers that publish readiness
 * based on remote routability can await this helper before proceeding.
 * @param cleanup - Cleanup function returned by {@link on}.
 */
export async function waitForSubscriptionPropagation(cleanup: (() => void) | null | undefined): Promise<void> {
  await (getOnPropagationPromise(cleanup) ?? Promise.resolve());
}

/**
 * Add a handler to a handler map with priority-based ordering.
 * @param context - Makaio bus context
 * @param mapKey - Which handler map to add to
 * @param fullSubjectKey - Full subject key including namespace (used for map storage/lookup)
 * @param entry - Handler and its registration metadata
 */
function addToHandlerMap(
  context: MakaioBusContext,
  mapKey: HandlerMapKey,
  fullSubjectKey: string,
  entry: HandlerEntry<AnyHandler>,
): void {
  const map = context[mapKey];
  if (!map.has(fullSubjectKey)) {
    map.set(fullSubjectKey, []);
  }
  const entries = map.get(fullSubjectKey)!;
  insertSorted(entries, entry);
}

/**
 * Remove a handler from a handler map and clean up empty entries.
 * @param context - Makaio bus context
 * @param mapKey - Which handler map to remove from
 * @param fullSubjectKey - Full subject key including namespace (used for map storage/lookup)
 * @param entry - Registration to remove, even if the callback has since been registered again
 */
function removeFromHandlerMap(
  context: MakaioBusContext,
  mapKey: HandlerMapKey,
  fullSubjectKey: string,
  entry: HandlerEntry<AnyHandler>,
): void {
  const map = context[mapKey];
  const entries = map.get(fullSubjectKey);
  if (entries) {
    const index = entries.findIndex((registered) => registered === entry);
    if (index !== -1) {
      entries.splice(index, 1);
    }
    if (entries.length === 0) {
      map.delete(fullSubjectKey);
    }
  }
}

/**
 * Protect an exclusive local request from a competing registration.
 * @param context - Shared bus state.
 * @param fullSubjectKey - Exact subject or subscription pattern.
 * @param options - Subscription options supplied by the caller.
 * @param isExactRequest - Whether this handler serves one specific request.
 * @returns Whether this registration reserves the dispatcher slot.
 */
function checkRequestReservation(
  context: MakaioBusContext,
  fullSubjectKey: string,
  options: OnOptions | undefined,
  isExactRequest: boolean,
): boolean {
  const exclusive = options?.exclusive === true;
  const existing = context.requestHandlers.get(fullSubjectKey);
  if (exclusive && options.filter !== undefined) {
    throw new TypeError('Exclusive handlers cannot use a payload filter');
  }
  if (exclusive && (!isExactRequest || !context.namespaceRegistry.isHostLocalRequestSubject(fullSubjectKey))) {
    throw new Error('Exclusive handlers require an exact host-local request');
  }
  if (existing?.[0]?.exclusive || (exclusive && existing?.length)) {
    throw new Error(`Request "${fullSubjectKey}" already has a handler`);
  }
  return exclusive;
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
 * @param owner - Carrier of the bus instance registering the handler; stored as `HandlerEntry.owner`
 * @param subjectDefinition - Subject definition with subject pattern and metadata
 * @param handler - Handler function (EventHandler for events, RequestHandler for requests)
 * @param options - Optional filter and other subscription options
 * @param onSubscribeResult - Observer for a transport's subscription result.
 * @returns Unsubscribe function
 * @see {@link IMakaioBus.on} for full documentation and examples.
 */
export function on<T extends SubjectDefinition>(
  context: MakaioBusContext,
  owner: PartyRef,
  subjectDefinition: T,
  handler: HandlerForSubjectDefinition<T>,
  options?: OnOptions,
  onSubscribeResult?: (accepted: boolean, error?: unknown) => void,
): () => void {
  const subject = subjectDefinition.subject;
  const fullSubjectKey = getFullSubjectForSubjectDefinition(subjectDefinition);
  const signal = subscriptionSignal(owner, fullSubjectKey, context.debugLog);
  if (signal === false) return ignoredSubscription;
  const isRequest = subjectDefinition.$meta.isRequest;
  const isWildcard = subject.includes(WildcardSubjectKey) || subject.includes(':');
  const isAmbiguousWildcard = isWildcard && !isRequest;

  const exclusive = checkRequestReservation(context, fullSubjectKey, options, isRequest && !isWildcard);

  if (!isWildcard) {
    warnIfUnregistered(context, subjectDefinition, fullSubjectKey);
  }

  const callback = signal ? handler.bind(undefined) : handler;

  // Wrap handler with filter if provided
  const effectiveHandler: EventHandler<unknown> | RequestHandler<unknown, unknown> = options?.filter
    ? (ctx: { payload: unknown }) => {
        if (!matchesFilter(ctx.payload, options.filter!)) {
          return; // Filter didn't match, skip handler
        }
        return (callback as (ctx: unknown) => void | Promise<void>)(ctx);
      }
    : (callback as EventHandler<unknown> | RequestHandler<unknown, unknown>);

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
  const entry: HandlerEntry<AnyHandler> = { handler: effectiveHandler, owner, priority: options?.priority ?? 0 };
  if (exclusive) entry.exclusive = true;
  for (const mapKey of maps) {
    addToHandlerMap(context, mapKey, fullSubjectKey, entry);
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
  const propagated = pushAdvertisedSubjectsToPeers(context, null, [fullSubjectKey], onSubscribeResult);

  // Return unsubscribe function that cleans up from all registered maps
  const unsubscribe: OnCleanup = (): void => {
    for (const mapKey of maps) {
      removeFromHandlerMap(context, mapKey, fullSubjectKey, entry);
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

  return trackSubscription(unsubscribe, signal);
}
