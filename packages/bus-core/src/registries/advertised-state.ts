/**
 * Centralized advertised-state computation for cross-transport subscribe propagation.
 *
 * Each (target transport, subject) pair has exactly one authoritative view of what
 * priorities and event-handler presence the bus exposes. These functions compute
 * that view and push it to the target transport as a single subscribe or unsubscribe
 * call, eliminating the partial-snapshot / replace-semantics race that existed when
 * propagateSubscribe and on.ts both called target.subscribe() independently.
 */

import type { MakaioBusContext } from '../types/bus.js';
import type { BusTransport } from '../types/transports.js';
import type { BusTransportKeys } from './transport-registry.js';

/**
 * Push the full advertised state for one (target, subject) pair.
 *
 * Computes the union of:
 * - Local request handler priorities for `subject`
 * - Foreign remote handler priorities (excluding entries owned by the target)
 * - Presence of event-only handlers
 *
 * Then calls `targetTransport.subscribe()` (with the aggregated priority set) or
 * `targetTransport.unsubscribe()` when no handlers remain. Both paths are
 * best-effort: failures are logged at debug level and never propagate.
 * @param context - Bus context containing handler maps and remote handler registry
 * @param targetTransportName - Name of the transport to push state to (used to
 *   exclude its own remote entries to avoid routing loops)
 * @param targetTransport - Transport instance to call subscribe/unsubscribe on
 * @param subject - Full subject key (e.g. `'namespace.subject'`) to advertise
 * @returns A promise that resolves when the subscribe or unsubscribe call settles.
 *   Always resolves (never rejects) — errors are caught and logged internally.
 */
export function pushAdvertisedSubject(
  context: MakaioBusContext,
  targetTransportName: string,
  targetTransport: BusTransport,
  subject: string,
): Promise<void> {
  const prioritySet = new Set<number>();

  // Collect local request handler priorities.
  const localEntries = context.requestHandlers.get(subject);
  if (localEntries) {
    for (const entry of localEntries) {
      prioritySet.add(entry.priority);
    }
  }

  // Collect event-only handler presence (no priorities needed, but affects subscribe/unsubscribe decision).
  const hasLocalEventHandlers = context.eventHandlers.has(subject);

  // Collect foreign remote handler priorities, excluding entries owned by the target
  // to avoid the target thinking it should route requests back to itself.
  const remoteEntries = context.remoteRequestHandlers.get(subject);
  if (remoteEntries) {
    for (const entry of remoteEntries) {
      if (entry.transport === targetTransportName) continue;
      prioritySet.add(entry.priority);
    }
  }

  // Check if any foreign transport has event-only handlers for this subject.
  // Event-only subscriptions produce no priority entries in remoteRequestHandlers
  // but must still trigger a subscribe (with empty priority array) to peers.
  const remoteEventSet = context.remoteEventHandlers.get(subject);
  const hasForeignEventHandlers =
    remoteEventSet !== undefined &&
    (remoteEventSet.size > 1 || (remoteEventSet.size === 1 && !remoteEventSet.has(targetTransportName)));

  if (prioritySet.size === 0 && !hasLocalEventHandlers && !hasForeignEventHandlers) {
    // Nothing to advertise for this subject — tell the target to stop routing it.
    return Promise.resolve(targetTransport.unsubscribe(subject)).catch((error: unknown) => {
      console.debug('[AdvertisedState] unsubscribe propagation failed', {
        transport: targetTransportName,
        subject,
        error,
      });
    });
  } else {
    // Advertise the full priority set (may be empty for event-only subjects).
    return Promise.resolve(targetTransport.subscribe(subject, undefined, [...prioritySet])).catch((error: unknown) => {
      console.debug('[AdvertisedState] subscribe propagation failed', {
        transport: targetTransportName,
        subject,
        priorities: [...prioritySet],
        error,
      });
    });
  }
}

/**
 * Push updated advertised state for the given subjects to all registered transports
 * except the excluded one.
 *
 * Used after subscribe/unsubscribe wire messages arrive (exclude source) and after
 * local handler registration changes (exclude `null` — include all transports).
 * @param context - Bus context
 * @param excludeTransportName - Transport to skip (the message source); pass `null`
 *   to push to all registered transports (used by `on.ts` local handler changes)
 * @param affectedSubjects - Subjects whose advertised state may have changed
 * @returns A promise that resolves when all per-transport advertised-state pushes
 *   have settled. Always resolves (never rejects) — each push catches its own errors
 *   internally. Callers may optionally await this to ensure subscription propagation
 *   is complete before proceeding.
 */
export function pushAdvertisedSubjectsToPeers(
  context: MakaioBusContext,
  excludeTransportName: BusTransportKeys | null,
  affectedSubjects: string[],
): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const name of context.transportRegistry.names()) {
    if (excludeTransportName !== null && name === excludeTransportName) continue;
    const target = context.transportRegistry.getTransport(name);
    if (!target) continue;
    for (const subject of affectedSubjects) {
      promises.push(pushAdvertisedSubject(context, String(name), target, subject));
    }
  }
  // allSettled (not .all) enforces the "never rejects" contract documented
  // above, matching syncAllSubjectsToTransport which uses the same pattern.
  return promises.length > 0 ? Promise.allSettled(promises).then(() => undefined) : Promise.resolve();
}

/**
 * Sync the full current handler state to a newly registered transport, then
 * send the subscribe-sync-complete handshake.
 *
 * Collects all subjects from `requestHandlers`, `eventHandlers`, and
 * `remoteRequestHandlers`, calls {@link pushAdvertisedSubject} for each, and
 * finally sends `{ type: 'subscribe-sync-complete' }` via `transport.send()`.
 * The handshake lets the transport resolve its `ready` promise, signalling that
 * initial subscription state is available for priority-based request routing.
 *
 * Replaces the previous `syncExistingSubscriptionsToTransport` which did not
 * send the completion handshake.
 * @param context - Bus context
 * @param transportName - Registry key of the newly registered transport
 * @param transport - Transport instance to sync
 * @param signal - Abort signal from the transport registration; when aborted
 *   (e.g. on disconnect/unregister), the handshake send is skipped to avoid
 *   writing to a closed socket
 */
export async function syncAllSubjectsToTransport(
  context: MakaioBusContext,
  transportName: BusTransportKeys,
  transport: BusTransport,
  signal?: AbortSignal,
): Promise<void> {
  // Collect all subjects across all handler maps.
  const subjects = new Set<string>();
  for (const subject of context.requestHandlers.keys()) subjects.add(subject);
  for (const subject of context.eventHandlers.keys()) subjects.add(subject);
  for (const subject of context.remoteRequestHandlers.keys()) subjects.add(subject);
  for (const subject of context.remoteEventHandlers.keys()) subjects.add(subject);

  const nameStr = String(transportName);
  const promises: Promise<void>[] = [];
  for (const subject of subjects) {
    promises.push(pushAdvertisedSubject(context, nameStr, transport, subject));
  }

  // Wait for all subscribe/unsubscribe calls to settle before sending the handshake.
  // Each promise already catches its own errors (best-effort), so allSettled is
  // used only for coordination — it never rejects.
  await Promise.allSettled(promises);

  // If the transport was unregistered or disconnected while we were awaiting
  // the subject sync, skip the handshake — the socket is already closed or
  // closing. Two complementary guards:
  //   - signal?.aborted: set by unregister() when the registry entry is removed
  //   - transport.isReady?.() === false: set by the transport itself when the
  //     socket closes (covers disconnect-before-unregister ordering in bus.ts)
  if (signal?.aborted) return;
  if (transport.isReady?.() === false) return;

  // Send the handshake so the remote peer can resolve its ready promise.
  // Only sent when the transport declares a `ready` property — this signals
  // that the transport bridges to a remote peer that needs the handshake.
  // Real transports (WsClientTransport, TabBridgeTransport, WorkerTransport)
  // declare `ready`; test doubles and loopback transports omit it, avoiding
  // subscribe-sync-complete noise in spy assertions.
  if (transport.ready !== undefined) {
    void Promise.resolve(transport.send({ type: 'subscribe-sync-complete' })).catch((error: unknown) => {
      console.debug('[AdvertisedState] subscribe-sync-complete send failed', {
        transport: nameStr,
        error,
      });
    });
  }
}
