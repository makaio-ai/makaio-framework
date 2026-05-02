/**
 * General-purpose BusTransport implementation backed by a MessagePort-like channel.
 *
 * Wraps any {@link MessagePortLike} (browser `MessagePort`, Node.js
 * `worker_threads.MessagePort`, or a custom adapter), translating between a
 * local MakaioBus and a remote peer. Uses {@link CorrelationTracker} for
 * request/response matching.
 *
 * Key design:
 * - Implements the `BusTransport` interface from `@makaio/bus-core`
 * - Optionally wraps messages in a `{ channel: 'bus', message }` envelope for
 *   multiplexed channels (e.g. SharedWorker with multiple logical channels)
 * - Uses `CorrelationTracker` for request/response correlation
 * - Manages a local subscription set for smart-routing on the remote side
 * - Tracks last-seen priorities and filters per subject for correct re-subscribe
 *   and ref-counted unsubscribe semantics
 */

import type {
  BusMessage,
  BusRequestMessage,
  BusBroadcastMessage,
  BusSubscribeMessage,
  BusUnsubscribeMessage,
  BusTransport,
} from '@makaio/bus-core';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  CorrelationTracker,
  handleCorrelationResponse,
  trackMessageCorrelation,
} from '@makaio/bus-core';
import type { PayloadFilter } from '@makaio/core';
import type { MessagePortTransportOptions } from './types.js';

/**
 * Extended transport interface with subscription management and readiness
 * signalling.
 *
 * The extended methods mirror the contract first established by
 * `WorkerTransport` in `@makaio/services/window-coordinator/bus`.
 */
export interface MessagePortTransport extends BusTransport {
  /**
   * Resolves when the remote bus has completed initial subscribe
   * synchronization and requests can safely route through this transport.
   *
   * Resolved upon receipt of the `subscribe-sync-complete` handshake message
   * (see `BusSubscribeSyncCompleteMessage`). Before this resolves,
   * `remoteRequestHandlers` for this transport may be incomplete and requests
   * must not be routed through it.
   */
  readonly ready: Promise<void>;

  /**
   * Subscribe to a subject on the remote peer with optional payload filter and
   * handler priorities.
   * @param subject - Subject pattern (may include wildcards like `'adapter.*'`)
   * @param filter - Optional payload filter for server-side smart-routing
   * @param priorities - Handler priorities registered for this subject; an
   *   empty array signals event-only handlers
   */
  subscribe(subject: string, filter?: PayloadFilter, priorities?: number[]): Promise<void>;

  /**
   * Unsubscribe from a subject on the remote peer.
   * @param subject - Subject to unsubscribe from
   */
  unsubscribe(subject: string): Promise<void>;

  /**
   * Get the local subscription set for this transport.
   * @returns Set of subscribed subject patterns
   */
  getSubscriptions(): Set<string>;
}

/**
 * Create a `BusTransport` backed by a {@link MessagePortLike}.
 *
 * The transport is suitable for any environment that exposes a MessageChannel
 * primitive, including browser `MessagePort`, Node.js `worker_threads`, and
 * custom bridge adapters.
 * @param options - Transport configuration
 * @returns `MessagePortTransport` instance with subscription management
 * @example
 * ```typescript
 * const { port1, port2 } = new MessageChannel();
 *
 * const transport = createMessagePortTransport({
 *   port: port1,
 *   name: 'worker',
 *   envelope: true,
 *   debug: true,
 * });
 *
 * await transport.connect();
 * await transport.subscribe('adapter.*');
 * ```
 */
// eslint-disable-next-line max-lines-per-function -- Transport is cohesive; splitting would scatter related logic
export function createMessagePortTransport(options: MessagePortTransportOptions): MessagePortTransport {
  const { port, debug = false } = options;
  const transportName = options.name ?? 'message-port';
  const useEnvelope = options.envelope ?? false;

  const handlers = new Set<(message: BusMessage) => Promise<void>>();
  const correlations = new CorrelationTracker();

  // Messages that arrive before any handler is registered via onReceive().
  // This can happen because the remote peer sends subscribe messages during
  // the handshake (before the local bus calls registerTransport → onReceive).
  // Once the first handler is added, buffered messages are replayed in order.
  const preRegistrationBuffer: BusMessage[] = [];

  // Set to true when 'subscribe-sync-complete' is received. The ready promise
  // is deferred until both this flag is true AND the pre-registration buffer
  // replay has fully completed, so callers awaiting transport.ready are
  // guaranteed to see a fully-populated remoteRequestHandlers set.
  let syncCompleteReceived = false;

  // Track local subscriptions for this client
  const localSubscriptions = new Set<string>();

  // Track the priorities last sent for each subscribed subject so that
  // unsubscribe can echo them back to the remote side for ref-counted removal.
  const localPriorities = new Map<string, number[]>();

  // Track the filter last sent for each subscribed subject so that
  // priority-only re-subscriptions (filter === undefined) preserve it.
  const localFilters = new Map<string, PayloadFilter | undefined>();

  /** Stored reference to the current message handler for cleanup. */
  let messageHandler: ((event: MessageEvent) => void) | null = null;

  /** Resolver for the ready promise; null after it has been resolved. */
  let readyResolve: (() => void) | null = null;

  // The ready promise is created once and never reset. This transport is
  // single-use by design — each IndexWorker.start() / WorkerTransport
  // creation produces a fresh instance. Reconnect is not supported.
  /** Resolves when the remote peer sends the subscribe-sync-complete handshake. */
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  /**
   * Send a raw bus message over the port, applying the envelope if configured.
   * @param message - Bus message to transmit
   */
  function transmit(message: BusMessage): void {
    if (useEnvelope) {
      port.postMessage({ channel: 'bus', message });
    } else {
      port.postMessage(message);
    }
  }

  /**
   * Handle an incoming MessagePort message event.
   * @param event - MessageEvent from the port
   */
  async function handleMessage(event: MessageEvent): Promise<void> {
    try {
      const { data } = event;

      // Parse message out of the optional envelope
      let message: BusMessage;
      if (useEnvelope) {
        if (typeof data !== 'object' || data === null || !('channel' in data) || data.channel !== 'bus') {
          if (debug) {
            console.error(`[${transportName}] Invalid or non-bus envelope:`, data);
          }
          return;
        }
        message = data.message as BusMessage;
      } else {
        if (typeof data !== 'object' || data === null || !('type' in data)) {
          if (debug) {
            console.error(`[${transportName}] Invalid message structure:`, data);
          }
          return;
        }
        message = data as BusMessage;
      }

      // Filter heartbeat messages before any processing
      if (message.type === 'heartbeat') {
        return;
      }

      // Signal that the remote bus has completed subscribe synchronization.
      // Ready is deferred until the pre-registration buffer is also fully
      // drained so callers awaiting transport.ready see a fully-populated
      // handler set.
      //
      // Two cases where ready resolves immediately here:
      //   1. Normal bus.connect() flow: onReceive registered first, buffer is
      //      empty, so the replay in onReceive already finished.
      //   2. subscribe-sync-complete arrives before any subscribe messages and
      //      handlers are already registered (buffer is empty).
      if (message.type === 'subscribe-sync-complete') {
        syncCompleteReceived = true;
        if (handlers.size > 0 && preRegistrationBuffer.length === 0) {
          readyResolve?.();
          readyResolve = null;
        }
        // Otherwise defer: onReceive will resolve ready after the replay loop.
        return;
      }

      // Handle response messages for correlation tracking
      if (handleCorrelationResponse(message, correlations)) {
        return;
      }

      // Buffer messages that arrive before any handler is registered.
      if (handlers.size === 0) {
        preRegistrationBuffer.push(message);
        return;
      }

      // Call all registered handlers in parallel
      await Promise.all(
        Array.from(handlers).map(async (handler) => {
          try {
            await handler(message);
          } catch (error) {
            if (debug) {
              console.error(`[${transportName}] Handler error:`, error);
            }
          }
        }),
      );
    } catch (error) {
      if (debug) {
        console.error(`[${transportName}] Failed to handle message:`, error);
      }
    }
  }

  /**
   * Connect the transport by attaching the message handler to the port.
   */
  async function connect(): Promise<void> {
    // Fire-and-forget is the established pattern across all bus transports
    // (WS client, WS server, WS e2e-client). MessagePort dispatches onmessage
    // callbacks sequentially from the event loop, so concurrent invocations
    // only occur if a handler yields. Bus subscribe handlers are synchronous
    // map operations — no serialization queue is needed.
    messageHandler = (event: MessageEvent): void => {
      void handleMessage(event);
    };
    port.onmessage = messageHandler;

    if (debug) {
      console.info(`[${transportName}] Connected`);
    }
  }

  /**
   * Disconnect the transport and release all resources.
   */
  async function disconnect(): Promise<void> {
    correlations.cleanup();

    // Resolve the ready promise to prevent callers awaiting it from hanging
    // if disconnect is called before the handshake arrives.
    readyResolve?.();
    readyResolve = null;
    syncCompleteReceived = false;

    if (messageHandler) {
      port.onmessage = null;
      messageHandler = null;
    }

    handlers.clear();
    preRegistrationBuffer.length = 0;
    localSubscriptions.clear();
    localPriorities.clear();
    localFilters.clear();

    if (debug) {
      console.info(`[${transportName}] Disconnected`);
    }
  }

  /**
   * Send a message over the port and track correlation for request/response.
   * @param message - The bus message to send
   * @param timeout - Correlation timeout in milliseconds; `0` means no automatic timeout
   * @returns Promise resolving to response (requests), array of results
   *   (broadcasts), or boolean (events)
   */
  async function send<TMessage extends BusMessage>(
    message: TMessage,
    timeout?: number,
  ): Promise<
    TMessage extends BusRequestMessage
      ? unknown
      : TMessage extends BusBroadcastMessage
        ? Array<{ nodeId: string; payload: unknown }>
        : boolean
  > {
    transmit(message);
    return trackMessageCorrelation(message, correlations, timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  /**
   * Register a handler for incoming messages.
   *
   * If messages arrived before any handler was registered (pre-registration
   * buffer), they are replayed in order. After the replay settles, if
   * `subscribe-sync-complete` has already been received, the ready promise
   * is resolved so callers see a fully-populated handler set.
   * @param handler - Handler function for incoming messages
   * @returns Unsubscribe function
   */
  function onReceive(handler: (message: BusMessage) => Promise<void>): () => void {
    handlers.add(handler);

    if (preRegistrationBuffer.length > 0) {
      // Replay messages that arrived before any handler was registered (e.g.
      // subscribe messages sent by the remote peer during the handshake), then
      // resolve the ready promise once all replayed messages have been processed.
      // Messages are replayed sequentially to preserve arrival order — concurrent
      // replay could race when multiple subscribe updates target the same subject.
      const buffered = preRegistrationBuffer.splice(0);
      // Use an async IIFE so onReceive returns the unsubscribe fn synchronously.
      void (async () => {
        for (const msg of buffered) {
          try {
            await handler(msg);
          } catch (error: unknown) {
            if (debug) {
              console.error(`[${transportName}] Error replaying buffered message:`, error);
            }
          }
        }
        if (syncCompleteReceived) {
          readyResolve?.();
          readyResolve = null;
        }
      })();
    } else if (syncCompleteReceived) {
      // subscribe-sync-complete arrived before any subscribe messages and before
      // the first onReceive call. Buffer is empty, so no replay is needed —
      // resolve ready now that a handler is registered.
      readyResolve?.();
      readyResolve = null;
    }

    return () => {
      handlers.delete(handler);
    };
  }

  /**
   * Subscribe to a subject on the remote peer.
   *
   * Sends a subscribe message and tracks the subscription locally.
   * Preserves the existing filter when only priorities change
   * (`filter === undefined` means "no change", not "clear filter") — mirrors
   * `client-transport.ts` semantics.
   * @param subject - Subject to subscribe to (may include wildcards)
   * @param filter - Optional payload filter for server-side smart-routing
   * @param priorities - Handler priorities registered for this subject
   * @returns Promise that resolves when the subscribe message is sent
   */
  async function subscribe(subject: string, filter?: PayloadFilter, priorities?: number[]): Promise<void> {
    // Preserve the existing filter when only priorities change.
    const resolvedFilter = filter ?? localFilters.get(subject);

    localSubscriptions.add(subject);
    localPriorities.set(subject, priorities ?? []);
    localFilters.set(subject, resolvedFilter);

    const message: BusSubscribeMessage = {
      type: 'subscribe',
      subjects: { [subject]: priorities ?? [] },
      ...(resolvedFilter && { filters: { [subject]: resolvedFilter } }),
    };

    transmit(message);

    if (debug) {
      console.info(`[${transportName}] Subscribed to ${subject}${resolvedFilter ? ' with filter' : ''}`);
    }
  }

  /**
   * Unsubscribe from a subject on the remote peer.
   *
   * Sends the previously-tracked priorities back so the remote side can
   * perform ref-counted removal.
   * @param subject - Subject to unsubscribe from
   * @returns Promise that resolves when the unsubscribe message is sent
   */
  async function unsubscribe(subject: string): Promise<void> {
    const priorities = localPriorities.get(subject) ?? [];
    localSubscriptions.delete(subject);
    localPriorities.delete(subject);
    localFilters.delete(subject);

    const message: BusUnsubscribeMessage = {
      type: 'unsubscribe',
      subjects: { [subject]: priorities },
    };

    transmit(message);

    if (debug) {
      console.info(`[${transportName}] Unsubscribed from ${subject}`);
    }
  }

  /**
   * Get the local subscription set for this transport.
   * @returns Set of subscribed subject patterns
   */
  function getSubscriptions(): Set<string> {
    return new Set(localSubscriptions);
  }

  /**
   * Cancel a pending request correlation for this transport.
   * @param correlationId - Correlation ID to cancel
   * @param error - Optional cancellation error
   */
  function cancelRequest(correlationId: string, error?: Error): void {
    correlations.cancel(correlationId, error);
  }

  return {
    name: transportName,
    connect,
    disconnect,
    send,
    cancelRequest,
    onReceive,
    subscribe,
    unsubscribe,
    getSubscriptions,
    ready: readyPromise,
  };
}
