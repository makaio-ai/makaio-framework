import { emit } from '../methods/emit.js';
import { broadcast as executeBroadcast } from '../methods/broadcast.js';
import { LocalSubjectError, NoHandlerError } from '../errors/index.js';
import type {
  BusBroadcastMessage,
  BusBroadcastResponseMessage,
  BusEventMessage,
  BusMessage,
  BusRequestMessage,
  BusTransport,
  BusTransportError,
  MakaioBusContext,
} from '../types/index.js';
import type { TransportRegistration } from '../types/bus.js';
import { getSubjectFromBusMessage, getReadyTransports, serializeError, sendErrorResponse } from '../utils/index.js';
import type { MessagePayload, SubjectDefinition, TransportReceiveContext } from '@makaio/core';
import { dispatch } from '../methods/request/dispatch.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../types/options.js';
import { syncAllSubjectsToTransport } from './advertised-state.js';
import { propagateSubscribe, propagateUnsubscribe, purgeRemoteHandlersForTransport } from './remote-subscriptions.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BusTransportRegistry extends Record<string, BusTransport> {}
export type BusTransportKeys = keyof BusTransportRegistry;

interface RegisteredTransport {
  transport: BusTransport;
  unsubscribe: () => void;
  /** Aborted on unregister to cancel the in-flight initial subject sync. */
  syncAbort: AbortController;
}

const resolveSubjectDefinition = (
  message: BusEventMessage | BusRequestMessage | BusBroadcastMessage,
  isRequest: boolean,
): SubjectDefinition => {
  return {
    subject: message.subject,
    $meta: {
      namespace: message.namespace,
      isRequest,
      payload: {} as never,
      local: false,
      channel: false,
    },
  };
};

/**
 * Get transports eligible to receive a relayed message (event, request, or broadcast).
 *
 * Used for all relay paths — both event relay and RPC (request/broadcast) relay.
 * Uses readiness filtering (not subscription filtering). Subscriptions are an
 * inbound concern — they tell the server which subjects to forward back to
 * this client. They must not gate outbound relay, because a client may emit
 * events it does not subscribe to (e.g., Electron renderer emits `ui.ready`
 * without listening to it).
 * @param context - Bus context
 * @param sourceTransportName - Transport to exclude (message origin)
 * @returns Array of `{ name, transport }` pairs eligible for relay
 */
const getRelayTargets = (
  context: MakaioBusContext,
  sourceTransportName: BusTransportKeys,
): Array<{ name: BusTransportKeys; transport: BusTransport }> => {
  return getReadyTransports(context, sourceTransportName);
};

/**
 * Handle an event received from a transport.
 *
 * Relays events to other transports (excluding source), except collector-only
 * subjects, which are handled locally without lateral relay.
 * Executes local handlers unconditionally — `emit()` no-ops gracefully when
 * no handlers or schema exist for the subject.
 * @param context - Bus context
 * @param sourceTransportName - Name of the transport the event arrived from
 * @param message - The event message
 * @param receiveContext - Trusted context supplied by the receiving transport
 */
const handleEventMessage = async (
  context: MakaioBusContext,
  sourceTransportName: BusTransportKeys,
  message: BusEventMessage,
  receiveContext?: TransportReceiveContext,
): Promise<void> => {
  const fullSubject = getSubjectFromBusMessage(message);
  if (!fullSubject) {
    return;
  }

  // SECURITY: Reject events targeting local-only subjects. Local subjects must
  // never cross transport boundaries — silently drop and warn rather than error,
  // because events have no response channel to communicate the rejection to the
  // remote peer.
  if (context.namespaceRegistry.isLocalSubject(fullSubject)) {
    console.warn(
      `[TransportRegistry] Dropping inbound event '${fullSubject}' from transport ` +
        `'${String(sourceTransportName)}': subject is local-only and cannot be invoked remotely.`,
    );
    return;
  }

  // PHASE 1: RELAY — forward to other transports (excluding source)
  // This happens unless the subject is collector-only, even when no schema exists (SharedWorker relay case).
  // Uses readiness filtering (not subscription filtering) — see getRelayTargets.
  if (!context.namespaceRegistry.isCollectorOnlySubject(fullSubject)) {
    const relayTargets = getRelayTargets(context, sourceTransportName);
    const relayResults = await Promise.allSettled(relayTargets.map(async ({ transport }) => transport.send(message)));
    for (const [index, result] of relayResults.entries()) {
      if (result.status === 'rejected') {
        console.error(
          `[TransportRegistry] Failed to relay event '${fullSubject}' to transport '${String(relayTargets[index].name)}':`,
          result.reason,
        );
      }
    }
  }

  // PHASE 2: LOCAL PROCESSING — emit to matching event handlers.
  // emit() gracefully no-ops when no handlers match or no schema exists
  // (validateEventPayload returns early if schema is missing).
  const definition = resolveSubjectDefinition(message, false);
  await emit(context, definition, message.payload as MessagePayload, {
    messageId: message.messageId,
    correlationId: message.correlationId,
    transports: [], // Local-only, relay already happened above
    transport: receiveContext,
  });
};

/**
 * Handle a request message received from a transport.
 *
 * Delegates to the priority cursor dispatch function, which merges local and
 * remote handler entries and walks them in priority order starting from the
 * cursor supplied by the caller (`message.priority`). This enables cross-node
 * priority interleaving: a remote hop contributes only its handlers that fall
 * below the cursor so the overall chain proceeds in strict priority order.
 *
 * When dispatch produces a result, the result is sent back to the source
 * transport. When the chain is exhausted (`handled: false`), a
 * {@link NoHandlerError} response is returned so the caller can continue its
 * own dispatch from the next lower priority.
 * @param context - Bus context
 * @param _sourceTransportName - Name of the transport the request arrived from (reserved for future use)
 * @param transport - Transport instance to send the response back to
 * @param message - The request message to handle
 * @param receiveContext - Trusted context supplied by the receiving transport
 */
const handleRequestMessage = async (
  context: MakaioBusContext,
  _sourceTransportName: BusTransportKeys,
  transport: BusTransport,
  message: BusRequestMessage,
  receiveContext?: TransportReceiveContext,
): Promise<void> => {
  const fullSubject = getSubjectFromBusMessage(message);
  const relayTimeout = message.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!fullSubject) {
    await sendErrorResponse(transport, message, new Error('Invalid subject in request message'));
    return;
  }

  // SECURITY: Reject requests targeting local-only subjects. Local subjects must
  // never cross transport boundaries — send an explicit error so the remote peer
  // knows the request was rejected rather than silently timing out.
  if (context.namespaceRegistry.isLocalSubject(fullSubject)) {
    await sendErrorResponse(transport, message, new LocalSubjectError(fullSubject));
    return;
  }

  // Host-local request subjects accept direct remote ingress but must never be
  // relayed onward. Locally registered semantics suppress all remote dispatch;
  // learned per-route provenance is enforced separately by dispatch below.
  // The request wire remains free of caller-controlled locality flags.
  const hostLocalRequest = context.namespaceRegistry.isHostLocalRequestSubject(fullSubject);

  const definition = resolveSubjectDefinition(message, true);

  try {
    // Timeout enforcement for local handlers is intentionally omitted here.
    // The caller's time budget is enforced at the transport layer (correlation
    // tracker) and by the caller's AbortSignal. dispatch() enforces timeouts
    // only on remote hops via awaitWithTimeoutAndSignal. A hung local handler
    // is a handler bug, not a dispatch bug — adding timeout wrapping here
    // would mask the real issue and add complexity to the hot path.
    const outcome = await dispatch(context, definition, message.payload as MessagePayload, {
      correlationId: message.correlationId,
      messageId: message.messageId,
      timeout: relayTimeout,
      deadline: message.deadline,
      // Start dispatch from the cursor sent by the originating node (if any).
      priority: message.priority,
      transport: receiveContext,
      // An inbound request has already consumed its first hop. Learned
      // first-hop-only routes are excluded, while local and relayable routes
      // remain eligible for mixed topologies.
      excludeFirstHopOnlyRemote: true,
      // Host-local request: run receiver-local handlers only, never forward
      // to another transport. This is the relay-suppression enforcement point.
      ...(hostLocalRequest && { localOnly: true }),
    });

    if (!outcome.handled) {
      // Chain exhausted below the cursor — tell the caller to continue dispatch.
      await sendErrorResponse(transport, message, new NoHandlerError(fullSubject));
      return;
    }

    await transport.send({
      type: 'response',
      correlationId: message.correlationId,
      result: outcome.value,
    });
  } catch (error) {
    await sendErrorResponse(transport, message, error);
  }
};

/**
 * Deliver broadcast results to the originating transport.
 *
 * Prefers the {@link BusTransport.onBroadcastResults} seam when implemented,
 * falling back to a legacy `send({ type: 'broadcast-response' })` for
 * transports that do not yet implement the seam.
 * @param transport - Transport to deliver results to
 * @param correlationId - Correlation ID of the originating broadcast
 * @param results - Aggregated results; pass `[]` on error paths
 * @param error - Optional structured error forwarded to onBroadcastResults and
 * included in the legacy fallback payload when used
 */
const deliverBroadcastResults = async (
  transport: BusTransport,
  correlationId: string,
  results: Array<{ nodeId: string; payload: unknown }>,
  error?: BusTransportError,
): Promise<void> => {
  if (transport.onBroadcastResults) {
    transport.onBroadcastResults(correlationId, results, error);
    return;
  }
  const responseMessage: BusBroadcastResponseMessage = {
    type: 'broadcast-response',
    correlationId,
    ...(results.length > 0 ? { results } : {}),
    ...(error ? { error } : {}),
  };
  await transport.send(responseMessage);
};

/**
 * Handle a broadcast message received from a transport.
 *
 * Executes local handlers and relays to all other transports in parallel,
 * then merges and returns all collected results.
 *
 * - Phase 1 (local): calls `executeBroadcast(..., { transports: [] })` so
 *   only local handlers run — transport dispatch is suppressed because relay
 *   is handled explicitly below.
 * - Phase 2 (relay): uses {@link getRelayTargets}, which excludes only the
 *   source transport to prevent loops. Relay is intentionally unfiltered
 *   (no subscription matching) because subscriptions are eventually-consistent
 *   and silently excluding a transport could produce an incomplete result array
 *   with no error signal — the same rationale as request relay.
 * @param context - Bus context
 * @param sourceTransportName - Name of the transport the broadcast arrived from
 * @param transport - Transport instance to send the response back to
 * @param message - The broadcast message to handle
 * @param receiveContext - Trusted context supplied by the receiving transport
 */
const handleBroadcastMessage = async (
  context: MakaioBusContext,
  sourceTransportName: BusTransportKeys,
  transport: BusTransport,
  message: BusBroadcastMessage,
  receiveContext?: TransportReceiveContext,
): Promise<void> => {
  const fullSubject = getSubjectFromBusMessage(message);
  const relayTimeout = message.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!fullSubject) {
    await deliverBroadcastResults(
      transport,
      message.correlationId,
      [],
      serializeError(new Error('Invalid subject in broadcast message')),
    );
    return;
  }

  // SECURITY: Reject broadcasts targeting local-only subjects. Local subjects must
  // never cross transport boundaries — return an error result so the remote peer
  // knows the broadcast was rejected rather than silently receiving empty results.
  if (context.namespaceRegistry.isLocalSubject(fullSubject)) {
    await deliverBroadcastResults(
      transport,
      message.correlationId,
      [],
      serializeError(new LocalSubjectError(fullSubject)),
    );
    return;
  }

  try {
    // Collect results from all sources in parallel
    const allResults: Array<{ nodeId: string; payload: unknown }> = [];
    let localError: BusTransportError | undefined;

    // PHASE 1: Execute local handlers unconditionally — executeBroadcast calls
    // getMatchingHandlers internally and returns [] when no handlers exist.
    const definition = resolveSubjectDefinition(message, true);
    const localPromise = executeBroadcast(context, definition, message.payload as MessagePayload, {
      messageId: message.messageId,
      correlationId: message.correlationId,
      timeout: relayTimeout,
      transports: [], // Local-only — relay already handled below
      transport: receiveContext,
    })
      .then((results) => allResults.push(...results))
      .catch((error: unknown) => {
        // Keep collecting relay results, but preserve local execution failure so
        // the origin transport receives an explicit error signal.
        localError = serializeError(error);
      });

    // PHASE 2: Relay to other transports (excluding source), collect their results.
    // Uses unfiltered RPC relay (same as requests) because subscription filtering
    // can silently drop valid respondents, producing incomplete result arrays
    // with no error signal.
    const relayTargets = getRelayTargets(context, sourceTransportName);
    const relayPromises = relayTargets.map(async ({ name: targetName, transport: targetTransport }) => {
      try {
        allResults.push(...(await targetTransport.send(message, relayTimeout)));
      } catch (error) {
        console.error(
          `[TransportRegistry] Failed to relay broadcast '${fullSubject}' to transport '${String(targetName)}':`,
          error,
        );
      }
    });

    // Safe to use Promise.all: localPromise and each relay promise handle their
    // own errors internally, so this await only coordinates completion.
    await Promise.all([localPromise, ...relayPromises]);
    await deliverBroadcastResults(transport, message.correlationId, allResults, localError);
  } catch (error) {
    await deliverBroadcastResults(transport, message.correlationId, [], serializeError(error));
  }
};

/**
 * Register a transport's `ready` promise in the pending-ready map.
 *
 * Self-cleans on settlement (resolve or reject) using an identity guard so
 * that a replacement transport registered at the same key is not accidentally
 * evicted by the stale callback from the previous transport's settlement.
 * @param pendingReady - Map to update
 * @param name - Transport key
 * @param readyPromise - Promise to track; no-op when `undefined`
 */
const trackPendingReady = (
  pendingReady: Map<BusTransportKeys, Promise<void>>,
  name: BusTransportKeys,
  readyPromise: Promise<void> | undefined,
): void => {
  if (readyPromise === undefined) return;
  pendingReady.set(name, readyPromise);
  const cleanup = (): void => {
    if (pendingReady.get(name) === readyPromise) {
      pendingReady.delete(name);
    }
  };
  void readyPromise.then(cleanup, cleanup);
};

/**
 * Creates the transport registry used by a bus context.
 *
 * Manages connected transports, handles inbound message routing (events,
 * requests, broadcasts), and relays messages to other registered transports.
 * @param context - Bus context that owns this registry
 * @returns Transport registry with registerTransport, getTransport, all,
 *   names, and getPendingReady methods
 */

/**
 * Callback interface for transport lifecycle event emission.
 *
 * Set on the transport registry by the bus after construction so that
 * connect/disconnect transitions emit `BusLifecycle.connected` /
 * `BusLifecycle.disconnected` automatically for every registered transport.
 */
interface TransportLifecycleEmitter {
  /**
   * Called when a transport establishes a connection.
   * @param transportName - Name of the connected transport.
   */
  onConnected(transportName: string): void;
  /**
   * Called when a transport loses connection unexpectedly.
   * @param transportName - Name of the disconnected transport.
   */
  onDisconnected(transportName: string): void;
}

// eslint-disable-next-line max-lines-per-function -- syncAbort lifecycle adds ~3 lines across register/unregister/replace
const createTransportRegistry = (context: MakaioBusContext) => {
  const registeredTransports = new Map<BusTransportKeys, RegisteredTransport>();
  let lifecycleEmitter: TransportLifecycleEmitter | undefined;
  /** Unresolved `ready` promises keyed by transport name; used for dispatch-level gating. */
  const pendingReady = new Map<BusTransportKeys, Promise<void>>();

  const handleIncomingMessage = async (
    transportName: BusTransportKeys,
    transport: BusTransport,
    message: BusMessage,
    receiveContext?: TransportReceiveContext,
  ): Promise<void> => {
    try {
      if (message.type === 'subscribe-sync-complete') {
        // Handshake sent by the bus after initial subscribe sync — the transport
        // resolves its ready promise on receipt. No further processing needed here.
        return;
      }

      if (message.type === 'subscription-ack') {
        // Dynamic subscription acknowledgements are consumed by transport
        // implementations before application-level bus dispatch.
        return;
      }

      if (message.type === 'subscribe') {
        await propagateSubscribe(context, transportName, message);
        return;
      }

      if (message.type === 'unsubscribe') {
        await propagateUnsubscribe(context, transportName, message);
        return;
      }

      // Synthesize a guaranteed TransportReceiveContext so that ctx.transport is
      // always populated for all inbound transport messages, making
      // origin.local = !ctx.transport correct everywhere. The transport name is
      // filled in from the registration key when the auth layer omits it.
      const effectiveReceiveContext: TransportReceiveContext = receiveContext
        ? { ...receiveContext, transportName: receiveContext.transportName || String(transportName) }
        : { transportName: String(transportName) };

      if (message.type === 'event') {
        await handleEventMessage(context, transportName, message, effectiveReceiveContext);
      } else if (message.type === 'request') {
        await handleRequestMessage(context, transportName, transport, message, effectiveReceiveContext);
      } else if (message.type === 'broadcast') {
        await handleBroadcastMessage(context, transportName, transport, message, effectiveReceiveContext);
      }
    } catch (error) {
      console.error('[TransportRegistry] Unhandled error processing transport message:', error);
    }
  };

  return {
    registerTransport<K extends BusTransportKeys>(name: K, transport: BusTransportRegistry[K]): TransportRegistration {
      const existing = registeredTransports.get(name);
      if (existing) {
        console.warn(
          `[TransportRegistry] Replacing existing transport '${name}'. ` +
            `This unsubscribes the old transport's handler - if unintended, use a different name.`,
        );
        purgeRemoteHandlersForTransport(context, String(name));
        existing.syncAbort.abort();
        existing.unsubscribe();
        existing.transport.onNewReadySession = undefined; // Detach: late reconnect must not pollute this registry.
        existing.transport.onConnected = undefined;
        existing.transport.onDisconnected = undefined;
        pendingReady.delete(name); // Evict eagerly; self-clean guard handles late resolution.
      }

      const unsubscribe = transport.onReceive(async (message: BusMessage, receiveContext?: TransportReceiveContext) => {
        await handleIncomingMessage(name, transport, message, receiveContext);
      });

      const syncAbort = new AbortController();
      registeredTransports.set(name, { transport, unsubscribe, syncAbort });

      trackPendingReady(pendingReady, name, transport.ready);

      // Reconnecting transports call this to push each session's ready promise into the registry.
      transport.onNewReadySession = (p: Promise<void>): void => trackPendingReady(pendingReady, name, p);
      transport.onConnected = (): void => lifecycleEmitter?.onConnected(String(name));
      transport.onDisconnected = (): void => lifecycleEmitter?.onDisconnected(String(name));

      void syncAllSubjectsToTransport(context, name, transport as BusTransport, syncAbort.signal);

      const unregister = (): void => {
        const current = registeredTransports.get(name);
        // Guard: only act if this is still OUR registration (not a later replacement).
        if (current?.transport === transport) {
          current.syncAbort.abort();
          current.unsubscribe();
          registeredTransports.delete(name);
          pendingReady.delete(name);
          transport.onNewReadySession = undefined; // Detach: late reconnect must not pollute this registry.
          transport.onConnected = undefined;
          transport.onDisconnected = undefined;
          purgeRemoteHandlersForTransport(context, String(name));
        }
      };

      return {
        unregister,
        ready: transport.ready ?? Promise.resolve(),
      };
    },

    getTransport<K extends BusTransportKeys>(name: K): BusTransportRegistry[K] | undefined {
      return registeredTransports.get(name)?.transport as BusTransportRegistry[K] | undefined;
    },

    all(): BusTransport[] {
      return Array.from(registeredTransports.values(), (entry) => entry.transport);
    },

    names(): BusTransportKeys[] {
      return Array.from(registeredTransports.keys());
    },

    /**
     * Return all unresolved transport `ready` promises for dispatch-level gating.
     *
     * Use `Promise.all(registry.getPendingReady())` to await full initialization.
     * @returns Array of pending ready promises (empty when all transports are ready)
     */
    getPendingReady(): Promise<void>[] {
      return Array.from(pendingReady.values());
    },

    /**
     * Set the lifecycle emitter used to publish `BusLifecycle.connected` /
     * `BusLifecycle.disconnected` events whenever a transport connects or
     * disconnects.
     *
     * Called once by the owning bus after construction. Subsequent transport
     * registrations automatically pick up the emitter through the closure.
     * @param emitter - Lifecycle emitter to install.
     */
    setLifecycleEmitter(emitter: TransportLifecycleEmitter): void {
      lifecycleEmitter = emitter;
    },
  };
};

export type TransportRegistry = ReturnType<typeof createTransportRegistry>;

export { createTransportRegistry };
