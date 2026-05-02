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
import type { BusMessage, CorrelationTracker } from '@makaio/bus-core';
import { sendEncoded, waitForSocketOpen } from './transport-helpers.js';
import { buildSubscribeMessage, type SubscriptionEntry } from './subscribe-message.js';
import { backoffMs, sleep, type WebSocketClientTransportReconnectOptions } from './ws-client-reconnect.js';
import { handleInboundMessage } from './ws-client-message-handler.js';

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
  readonly handlers: Set<(message: BusMessage) => Promise<void>>;
  /** Buffered local subscriptions to replay on each new connection. */
  readonly localSubscriptions: Map<string, SubscriptionEntry>;
  /** WebSocket factory — creates a new socket for each connect attempt. */
  readonly wsFactory: (url: string) => WebSocketLike | Promise<WebSocketLike>;
  /** Target WebSocket server URL. */
  readonly url: string;

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
  /** Create a new ready promise for the upcoming session and notify the registry. */
  resetReadyPromise(): void;

  /** Called after a successful connect (auth + subscriptions replayed). */
  notifyConnected(): void;
  /** Called when a connection is lost unexpectedly (not on clean disconnect). */
  notifyDisconnected(): void;
}

// ---------------------------------------------------------------------------
// Helpers — socket listener management
// ---------------------------------------------------------------------------

/**
 * Attach the message listener to the given socket and store the reference in
 * `deps` so it can be removed later.
 * @param ws - The socket to attach to
 * @param deps - Connection deps (provides state accessors and handler config)
 */
function attachMessageListener(ws: WebSocketLike, deps: ConnectionDeps): void {
  const listener = (event: { data: string | Buffer }): void => {
    void handleInboundMessage(event.data, {
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
    });
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
 * Perform a single connect attempt: create socket, wait for open, authenticate,
 * replay subscriptions.
 *
 * Resets the ready promise for the new session, removes listeners from any
 * previous socket, and notifies the transport on success. Throws on failure
 * so the reconnect loop can back off and retry.
 * @param deps - Connection lifecycle dependencies
 */
export async function connectOnce(deps: ConnectionDeps): Promise<void> {
  // Resolve any stale ready promise from the previous session to avoid hanging awaiters.
  deps.resolveReady();
  // Create a fresh ready promise and notify the registry.
  deps.resetReadyPromise();

  // Remove listeners from the previous socket before creating the new one.
  const prevSocket = deps.getSocket();
  if (prevSocket !== null) {
    removeSocketListeners(prevSocket, deps);
  }

  const ws = await deps.wsFactory(deps.url);
  deps.setSocket(ws);
  deps.setAuthComplete(false);

  try {
    // Attach message listener before waiting for open so auth frames arriving
    // during the WebSocket handshake are captured immediately.
    attachMessageListener(ws, deps);

    await waitForSocketOpen(ws);

    if (deps.auth) {
      await deps.auth.authenticateClient((message: unknown) => {
        if (ws.readyState !== 1) {
          throw new Error('WebSocketClientTransport: cannot send auth message — socket not open');
        }
        ws.send(JSON.stringify(message));
      });
    }

    deps.setAuthComplete(true);

    if (deps.debug) {
      console.info(`[WebSocketClientTransport:${deps.name}] Connected to ${deps.url}`);
    }

    // Replay subscriptions — no-op on initial connect; restores routing state on reconnect.
    if (deps.localSubscriptions.size > 0) {
      const resubMessage = buildSubscribeMessage(deps.localSubscriptions);
      await sendEncoded(resubMessage, deps.codec, ws);

      if (deps.debug) {
        console.info(
          `[WebSocketClientTransport:${deps.name}] Replayed ${deps.localSubscriptions.size} subscription(s)`,
        );
      }
    }

    // Notify after auth + subscription replay so that reconnect handlers
    // can assume server-side subscription state is fully restored.
    deps.notifyConnected();
  } catch (error) {
    // Clean up the failed socket — do not leave it dangling.
    const ownsFailedSocket = deps.getSocket() === ws;
    if (ownsFailedSocket) {
      deps.auth?.cleanup();
    }
    removeSocketListeners(ws, deps);
    if (ownsFailedSocket) {
      deps.setSocket(null);
    }
    deps.setAuthComplete(false);
    if (ownsFailedSocket && (ws.readyState === 0 || ws.readyState === 1)) {
      ws.close();
    }
    throw error;
  }
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

      if (hadConnection) {
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
          await connectOnce(deps);
          attempt = 0;

          const newWs = deps.getSocket();
          if (newWs !== null) {
            const closeListener = (): void => {
              deps.auth?.cleanup();
              deps.setAuthComplete(false);
              if (deps.debug) {
                console.info(`[WebSocketClientTransport:${deps.name}] ${new Date().toISOString()} Connection closed`);
              }
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
  const onClose = (): void => {
    deps.auth?.cleanup();
    removeSocketListeners(ws, deps);
    deps.setAuthComplete(false);
    deps.setSocket(null);
    clearReconnectAbort();
    deps.resolveReady();
    deps.notifyDisconnected();
  };
  deps.setCloseListener(onClose);
  ws.addEventListener('close', onClose);
}
