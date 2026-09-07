/**
 * Connection lifecycle helpers for `WebSocketClientTransport`.
 *
 * Extracts the `connectOnce` and `runReconnectLoop` logic from the transport
 * class so the main module stays focused on the `BusTransport` contract and
 * state management.
 *
 * Both functions accept a `ConnectionDeps` context that provides access to the
 * transport's mutable state via callbacks and references — the same pattern
 * used in `ws-client-message-handler.ts`.
 */

import type { WebSocketLike, TransportAuth, ClientTransportCodec } from './types.js';
import type { BusMessage, BusReceiveHandler, CorrelationTracker } from '@makaio/bus-core';
import { ConnectionLostError } from '@makaio/bus-core';
import { disposeSocket, extractSocketErrorMessage, sendEncoded, waitForSocketOpen } from './transport-helpers.js';
import { connectionClosedError, WebSocketConnectionError } from './connection-error.js';
import { buildSubscribeMessage, type SubscriptionEntry } from './subscribe-message.js';
import { backoffMs, sleep, type WebSocketClientTransportReconnectOptions } from './ws-client-reconnect.js';
import { handleInboundMessage } from './ws-client-message-handler.js';
import { startHeartbeatWatchdog } from './ws-client-heartbeat.js';
import type { WebSocketClientTransportHeartbeatOptions } from './ws-client-options.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mutable socket-lifecycle state shared between `connectOnce` and
 * `runReconnectLoop`. Callbacks let the functions read and update class fields
 * without coupling to the class directly.
 */
export interface ConnectionDeps {
  /** Transport name used in debug log prefixes. */
  readonly name: string;
  /** Whether verbose debug logging is enabled. */
  readonly debug: boolean;
  /** Optional authentication strategy. */
  readonly auth: TransportAuth | undefined;
  /** Wire codec for encoding/decoding messages. */
  readonly codec: ClientTransportCodec;
  /** Optional async transform applied after codec decoding. */
  readonly messageTransform: ((message: BusMessage) => Promise<BusMessage>) | undefined;
  /** Correlation tracker shared with the transport instance. */
  readonly correlations: CorrelationTracker;
  /** Application-level message handlers shared with the transport instance. */
  readonly handlers: Set<BusReceiveHandler>;
  /** Buffered local subscriptions to replay on each new connection. */
  readonly localSubscriptions: Map<string, SubscriptionEntry>;
  /** WebSocket factory — creates a new socket for each connect attempt. */
  readonly wsFactory: (url: string) => WebSocketLike | Promise<WebSocketLike>;
  /** Target WebSocket server URL. */
  readonly url: string;
  /** Bound in milliseconds for socket creation, opening, authentication and replay. */
  readonly connectTimeoutMs: number;
  /**
   * Resolved heartbeat watchdog timing, or `false` when the liveness
   * watchdog is disabled. Started per socket in `connectOnce`; the watchdog
   * self-stops on the socket's `close` event.
   */
  readonly heartbeat: Required<WebSocketClientTransportHeartbeatOptions> | false;

  /** Read the current active socket. */
  getSocket(): WebSocketLike | null;
  /** Replace the active socket (use `null` to clear). */
  setSocket(ws: WebSocketLike | null): void;

  /** Set the auth-complete flag. */
  setAuthComplete(value: boolean): void;

  /** Read the current message listener reference (for removal). */
  getMessageListener(): ((event: { data: string | Buffer }) => void) | null;
  /** Replace the stored message listener reference. */
  setMessageListener(listener: ((event: { data: string | Buffer }) => void) | null): void;

  /** Read the current close listener reference (for removal). */
  getCloseListener(): ((event: unknown) => void) | null;
  /** Replace the stored close listener reference. */
  setCloseListener(listener: ((event: unknown) => void) | null): void;

  /** Resolve the current session's ready promise and clear the resolver. */
  resolveReady(): void;
  /** Create and advertise a new ready promise; return its session-bound resolver. */
  resetReadyPromise(): () => void;
  /** Resolve a pending dynamic subscription acknowledgement. */
  resolveSubscriptionAck(ackId: string): void;
  /** Reject all pending dynamic subscription acknowledgements for a closed session. */
  rejectPendingSubscriptionAcks(error: Error): void;

  /** Called after a successful connect (auth + subscriptions replayed). */
  notifyConnected(): void;
  /** Called when a connection is lost unexpectedly (not on clean disconnect). */
  notifyDisconnected(): void;

  /**
   * Shared set tracking the current socket session's in-flight
   * `handleInboundMessage` promises.
   *
   * The transport passes its own `inFlightMessages` Set by reference so that
   * mutations (add/delete/clear) are reflected on the transport instance.
   * Entries are added in `attachMessageListener` and auto-deleted when each
   * promise settles. `connectOnce` clears the set at the start of a new session
   * (after draining). `drainAndRejectPendingCorrelations` awaits all entries
   * before calling `rejectAll` so that a response frame being decoded
   * concurrently with a socket close still resolves its correlation.
   */
  inFlightMessages: Set<Promise<void>>;
}

// ---------------------------------------------------------------------------
// Helpers — socket listener management
// ---------------------------------------------------------------------------

/**
 * Drain pending in-flight `handleInboundMessage` promises, then reject all
 * pending correlations with a `ConnectionLostError`.
 *
 * Must be awaited at every socket-close site before calling
 * `correlations.rejectAll`. This ensures that a response frame arriving just
 * before the close event still gets a chance to decode and resolve its
 * correlation rather than being overtaken by the rejection.
 * @param deps - Connection lifecycle dependencies
 * @param ws - Socket whose buffered responses are being drained.
 */
async function drainAndRejectPendingCorrelations(deps: ConnectionDeps, ws: WebSocketLike): Promise<void> {
  await Promise.allSettled(deps.inFlightMessages);
  if (deps.getSocket() === ws) deps.correlations.rejectAll(new ConnectionLostError(deps.name));
}

/**
 * Attach the message listener to the given socket and store the reference in
 * `deps` so it can be removed later.
 * @param ws - The socket to attach to
 * @param deps - Connection deps (provides state accessors and handler config)
 */
function attachMessageListener(ws: WebSocketLike, deps: ConnectionDeps): void {
  const listener = (event: { data: string | Buffer }): void => {
    if (deps.getSocket() !== ws) return;
    const p = handleInboundMessage(event.data, {
      isCurrentSession: () => deps.getSocket() === ws,
      name: deps.name,
      debug: deps.debug,
      auth: deps.auth,
      codec: deps.codec,
      messageTransform: deps.messageTransform,
      correlations: deps.correlations,
      handlers: deps.handlers,
      onSyncComplete: () => {
        deps.resolveReady();
      },
      onSubscriptionAck: (ackId) => {
        deps.resolveSubscriptionAck(ackId);
      },
      sendSubscriptionAck: async (ackId) => {
        if (deps.getSocket() !== ws || ws.readyState !== 1) return;
        await sendEncoded({ type: 'subscription-ack', ackId }, deps.codec, ws);
      },
    }).finally(() => {
      deps.inFlightMessages.delete(p);
    });
    deps.inFlightMessages.add(p);
  };
  deps.setMessageListener(listener);
  ws.addEventListener('message', listener);
}

/**
 * Remove the stored message and close listeners from `ws` and clear the stored
 * references in `deps`.
 * @param ws - The socket to detach listeners from
 * @param deps - Connection deps (provides listener references)
 */
export function removeSocketListeners(ws: WebSocketLike, deps: ConnectionDeps): void {
  if (deps.getSocket() !== ws) return;
  const msgListener = deps.getMessageListener();
  if (msgListener !== null) {
    ws.removeEventListener('message', msgListener);
    deps.setMessageListener(null);
  }
  const closeListener = deps.getCloseListener();
  if (closeListener !== null) {
    ws.removeEventListener('close', closeListener);
    deps.setCloseListener(null);
  }
}

// ---------------------------------------------------------------------------
// connectOnce
// ---------------------------------------------------------------------------

/**
 * Release a failed socket without allowing cleanup faults to hide its failure.
 * @param socket - Failed socket whose attempt listeners are already detached.
 * @param deps - Transport state from which socket ownership must be revoked.
 * @param failure - Original connection failure to preserve.
 * @returns Original failure, or an aggregate containing actual cleanup failures.
 */
function disposeFailedSocket(socket: WebSocketLike, deps: ConnectionDeps, failure: unknown): unknown {
  const failures: unknown[] = [failure];
  if (deps.getSocket() === socket) {
    removeSocketListeners(socket, deps);
    deps.setSocket(null);
    deps.setAuthComplete(false);
    try {
      deps.auth?.cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    disposeSocket(socket);
  } catch (error) {
    failures.push(error);
  }
  return failures.length === 1
    ? failure
    : new AggregateError(failures, 'WebSocket connection failed and cleanup was incomplete', { cause: failure });
}

/**
 * Perform a single connect attempt: create socket, wait for open, authenticate,
 * replay subscriptions.
 *
 * Resets the ready promise for the new session, removes listeners from any
 * previous socket, and notifies the transport on success. Throws on failure
 * so the reconnect loop can back off and retry.
 * @param deps - Connection lifecycle dependencies
 * @param signal - Cancellation owned by the transport's connection lifecycle.
 */
export async function connectOnce(deps: ConnectionDeps, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const attempt = new AbortController();
  const onAbort = (): void =>
    attempt.abort(new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'WebSocket connection cancelled'));
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(
    () =>
      attempt.abort(
        new WebSocketConnectionError(
          'WS_CONNECTION_TIMEOUT',
          `WebSocket connection timed out after ${deps.connectTimeoutMs}ms`,
        ),
      ),
    deps.connectTimeoutMs,
  );
  let ws: WebSocketLike | null = null;
  let finishReady: () => void = () => {};
  const removeAttemptListeners = (): void => {
    ws?.removeEventListener('close', onClose);
    ws?.removeEventListener('error', onError);
  };
  const onClose = (event: unknown): void => attempt.abort(connectionClosedError(event));
  const onError = (event: Event): void =>
    attempt.abort(
      new WebSocketConnectionError(
        'WS_CONNECTION_UNAVAILABLE',
        `WebSocket connection failed — ${extractSocketErrorMessage(event)}`,
        { cause: event },
      ),
    );
  const dispose = (failure: unknown): unknown => {
    // Readiness belongs to this attempt even before its factory yields a socket.
    // Its captured resolver must not settle a replacement session's promise.
    finishReady();
    if (ws === null) return failure;
    const socket = ws;
    removeAttemptListeners();
    ws = null;
    return disposeFailedSocket(socket, deps, failure);
  };
  let rejectCancellation: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = () => {
      // Revoke ownership synchronously, but cleanup faults must still settle
      // cancellation rather than escape this event listener or hide its cause.
      reject(dispose(attempt.signal.reason));
    };
    attempt.signal.addEventListener('abort', rejectCancellation);
  });
  try {
    const connect = acquireAndEstablishSocket(
      deps,
      attempt.signal,
      () => {
        finishReady = deps.resetReadyPromise();
      },
      (socket) => {
        ws = socket;
        deps.setSocket(socket);
        deps.setAuthComplete(false);
        socket.addEventListener('close', onClose);
        socket.addEventListener('error', onError);
        attachMessageListener(socket, deps);
      },
    );
    await Promise.race([connect, cancelled]);
  } catch (error) {
    throw dispose(error);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    attempt.signal.removeEventListener('abort', rejectCancellation);
    removeAttemptListeners();
  }
}

/**
 * Drain the previous session, acquire a socket and establish the new session.
 * @param deps - Transport dependencies.
 * @param signal - Owning attempt's deadline and cancellation signal.
 * @param beginReady - Create the readiness session and retain its failure resolver.
 * @param adopt - Transfer the acquired socket into this attempt's ownership.
 */
async function acquireAndEstablishSocket(
  deps: ConnectionDeps,
  signal: AbortSignal,
  beginReady: () => void,
  adopt: (socket: WebSocketLike) => void,
): Promise<void> {
  // Buffered responses still get their chance to resolve before correlation
  // rejection. An interrupted drain must never reject a newer session's work.
  if (deps.inFlightMessages.size > 0) await Promise.allSettled(deps.inFlightMessages);
  signal.throwIfAborted();
  deps.correlations.rejectAll(new ConnectionLostError(deps.name));
  deps.inFlightMessages.clear();
  deps.resolveReady();
  deps.rejectPendingSubscriptionAcks(new Error('WebSocketClientTransport: reconnecting before subscription ack'));
  beginReady();
  signal.throwIfAborted();
  const previous = deps.getSocket();
  if (previous !== null) removeSocketListeners(previous, deps);
  const socket = await deps.wsFactory(deps.url);
  if (signal.aborted) {
    disposeSocket(socket);
    signal.throwIfAborted();
  }
  adopt(socket);
  await establishSocket(socket, deps, signal);
}

/**
 * Complete the acquired socket's bounded open/auth/replay phases.
 * @param socket - Socket owned by this connection attempt.
 * @param deps - Transport dependencies.
 * @param signal - Owning attempt's cancellation and deadline signal.
 */
async function establishSocket(socket: WebSocketLike, deps: ConnectionDeps, signal: AbortSignal): Promise<void> {
  await waitForSocketOpen(socket, undefined, signal);
  signal.throwIfAborted();
  if (deps.auth) {
    await deps.auth.authenticateClient((message: unknown) => {
      signal.throwIfAborted();
      if (socket.readyState !== 1) throw connectionClosedError();
      socket.send(JSON.stringify(message));
    });
    signal.throwIfAborted();
  }
  deps.setAuthComplete(true);
  if (deps.localSubscriptions.size > 0) {
    const payload = await deps.codec.encode(buildSubscribeMessage(deps.localSubscriptions));
    signal.throwIfAborted();
    socket.send(payload);
  }
  // Arm only after replay: no async gap may allow the watchdog to terminate
  // before the caller installs the established-connection close listener.
  if (deps.heartbeat !== false) startHeartbeatWatchdog(socket, deps.heartbeat, deps);
  if (deps.debug) console.info(`[WebSocketClientTransport:${deps.name}] Connected to ${deps.url}`);
  deps.notifyConnected();
}

// ---------------------------------------------------------------------------
// waitForClose
// ---------------------------------------------------------------------------

/**
 * Wait for the given socket to enter the closed state (`readyState === 3`).
 *
 * Resolves immediately if the socket is already closed or the signal is aborted.
 * @param ws - WebSocket to wait on
 * @param signal - AbortSignal that cancels the wait
 * @returns Promise that resolves when the socket closes or the signal fires
 */
export function waitForClose(ws: WebSocketLike, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ws.readyState === 3 || signal.aborted) {
      resolve();
      return;
    }

    const onClose = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      ws.removeEventListener('close', onClose);
      resolve();
    };

    ws.addEventListener('close', onClose);
    signal.addEventListener('abort', onAbort);
  });
}

// ---------------------------------------------------------------------------
// runReconnectLoop
// ---------------------------------------------------------------------------

/**
 * Run the reconnect loop until the abort signal fires.
 *
 * Waits for the current socket to close, then backs off and reconnects.
 * Resets the backoff counter after a full open/close cycle.
 * @param signal - AbortSignal that stops the loop (fires on `disconnect()`)
 * @param config - Resolved reconnect timing configuration
 * @param deps - Connection lifecycle dependencies
 * @param setBackoffWakeAbort - Callback to store/clear the backoff wake controller
 * @param setLoopRunning - Callback to update the `reconnectLoopRunning` flag
 */
export async function runReconnectLoop(
  signal: AbortSignal,
  config: Required<WebSocketClientTransportReconnectOptions>,
  deps: ConnectionDeps,
  setBackoffWakeAbort: (ctrl: AbortController | null) => void,
  setLoopRunning: (running: boolean) => void,
): Promise<void> {
  setLoopRunning(true);
  try {
    while (!signal.aborted) {
      const ws = deps.getSocket();
      const hadConnection = ws !== null;
      if (ws !== null && ws.readyState !== 3) {
        await waitForClose(ws, signal);
      }

      if (signal.aborted) break;

      if (hadConnection && ws !== null) {
        // Drain any in-flight handleInboundMessage calls then reject remaining
        // correlations — their responses were on the old socket and will never
        // arrive. Draining first ensures responses that arrived just before the
        // close still resolve. This must happen before the backoff sleep so
        // callers get a prompt, honest error.
        await drainAndRejectPendingCorrelations(deps, ws);
        if (signal.aborted) break;
        if (deps.debug) {
          console.info(
            `[WebSocketClientTransport:${deps.name}] ${new Date().toISOString()} Connection lost, starting reconnect loop (maxMs=${config.maxMs})`,
          );
        }
        deps.notifyDisconnected();
      }

      let attempt = 0;

      while (!signal.aborted) {
        const delay = backoffMs(attempt, config.baseMs, config.maxMs);
        if (deps.debug) {
          console.info(
            `[WebSocketClientTransport:${deps.name}] ${new Date().toISOString()} Reconnecting in ${delay}ms (attempt ${attempt + 1})`,
          );
        }
        const wakeAbort = new AbortController();
        setBackoffWakeAbort(wakeAbort);
        await sleep(delay, AbortSignal.any([signal, wakeAbort.signal]));
        setBackoffWakeAbort(null);
        if (signal.aborted) break;

        try {
          await connectOnce(deps, signal);
          if (signal.aborted) break;
          attempt = 0;

          const newWs = deps.getSocket();
          if (newWs !== null) {
            const closeListener = async (): Promise<void> => {
              await Promise.allSettled(deps.inFlightMessages);
              if (signal.aborted || deps.getSocket() !== newWs) return;
              deps.correlations.rejectAll(new ConnectionLostError(deps.name));
              deps.auth?.cleanup();
              deps.setAuthComplete(false);
              if (deps.debug) {
                console.info(`[WebSocketClientTransport:${deps.name}] ${new Date().toISOString()} Connection closed`);
              }
              deps.rejectPendingSubscriptionAcks(
                new Error('WebSocketClientTransport: disconnected before subscription ack'),
              );
            };
            deps.setCloseListener(closeListener);
            newWs.addEventListener('close', closeListener);
            await waitForClose(newWs, signal);
          }
          break;
        } catch (error) {
          if (deps.debug) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(
              `[WebSocketClientTransport:${deps.name}] ${new Date().toISOString()} Connect attempt ${attempt + 1} failed: ${message}`,
            );
          }
          attempt++;
        }
      }
    }
  } finally {
    setLoopRunning(false);
  }
}

// ---------------------------------------------------------------------------
// installNoReconnectCloseListener
// ---------------------------------------------------------------------------

/**
 * Install the one-shot close listener used when automatic reconnection is
 * disabled.
 *
 * On close: removes socket listeners, resets auth/socket state, resolves the
 * ready promise, and fires the disconnected notification. Storing the listener
 * reference in `deps` allows `removeSocketListeners` to clean it up on an
 * explicit `disconnect()` call (preserving the "not fired on clean disconnect"
 * contract).
 * @param ws - The connected socket to watch for closure
 * @param deps - Connection lifecycle dependencies
 * @param clearReconnectAbort - Called when the socket closes to reset the reconnect controller
 */
export function installNoReconnectCloseListener(
  ws: WebSocketLike,
  deps: ConnectionDeps,
  clearReconnectAbort: () => void,
): void {
  const onClose = async (): Promise<void> => {
    if (deps.getSocket() !== ws) return;
    removeSocketListeners(ws, deps);
    deps.auth?.cleanup();
    deps.setAuthComplete(false);
    clearReconnectAbort();
    deps.resolveReady();
    deps.notifyDisconnected();
    // Keep the closed socket's identity during decode drain. A buffered reply
    // still belongs to this session, but must not affect a replacement session.
    await drainAndRejectPendingCorrelations(deps, ws);
    if (deps.getSocket() !== ws) return;
    deps.setSocket(null);
    deps.rejectPendingSubscriptionAcks(new Error('WebSocketClientTransport: disconnected before subscription ack'));
  };
  deps.setCloseListener(onClose);
  ws.addEventListener('close', onClose);
}
