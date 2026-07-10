/**
 * RFC-6455 ping/pong liveness watchdog for `WebSocketClientTransport`.
 *
 * Detects half-open TCP connections: an established connection whose peer
 * dies without a close frame keeps `readyState === 1` forever. The watchdog
 * probes an idle socket with ping frames and terminates it when no inbound
 * evidence (message or pong) arrives before the probe deadline, handing
 * recovery to the existing reconnect machinery (issue #374).
 */

import type { WebSocketLike } from './types.js';
import type { WebSocketClientTransportHeartbeatOptions } from './ws-client-options.js';

/**
 * Logging context for the heartbeat watchdog, mirroring the transport's
 * debug conventions.
 */
export interface HeartbeatWatchdogContext {
  /** Transport name used in debug log prefixes. */
  readonly name: string;
  /** Whether verbose debug logging is enabled. */
  readonly debug: boolean;
}

/**
 * WebSocket that supports RFC-6455 ping/pong control frames plus hard
 * termination — the `ws`-package surface the watchdog relies on.
 *
 * Browser `WebSocket` instances do not expose these members; the watchdog is
 * inert for them (see {@link supportsPing}).
 */
export interface PingCapableWebSocket extends WebSocketLike {
  /** Send an RFC-6455 ping control frame to the peer. */
  ping(): void;

  /** Forcibly destroy the underlying connection without a close handshake. */
  terminate(): void;

  /**
   * Register a pong-frame listener (Node `EventEmitter` style, as exposed by
   * the `ws` package).
   * @param event - Event name (`'pong'`)
   * @param listener - Invoked for each received pong frame
   */
  on(event: 'pong', listener: () => void): void;

  /**
   * Remove a previously registered pong-frame listener.
   * @param event - Event name (`'pong'`)
   * @param listener - Listener to remove
   */
  off(event: 'pong', listener: () => void): void;
}

/**
 * Duck-type guard: whether the socket supports ping/pong probing and hard
 * termination (`ping`, `terminate`, `on`, and `off` are all functions).
 * @param ws - Candidate socket
 * @returns `true` when the watchdog can operate on the socket
 */
export function supportsPing(ws: WebSocketLike): ws is PingCapableWebSocket {
  const candidate = ws as Partial<PingCapableWebSocket>;
  return (
    typeof candidate.ping === 'function' &&
    typeof candidate.terminate === 'function' &&
    typeof candidate.on === 'function' &&
    typeof candidate.off === 'function'
  );
}

/**
 * Unref a timer when the runtime supports it (Node does; browsers return
 * plain numbers) so an armed watchdog never keeps the process alive.
 * @param timer - Interval or timeout handle to unref
 */
function unrefTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

/**
 * Start the liveness watchdog on a connected socket.
 *
 * Tracks inbound evidence (`message` events and pong frames). Every
 * `config.intervalMs`: when no evidence arrived within the last interval, a
 * ping probe is sent and a `config.timeoutMs` deadline armed; evidence clears
 * the deadline, expiry stops the watchdog and terminates the socket. The
 * watchdog self-stops when the socket closes and is inert for sockets
 * without ping support.
 * @param ws - Connected socket to supervise
 * @param config - Resolved heartbeat timing configuration
 * @param ctx - Transport logging context
 * @returns Idempotent stop function that removes all timers and listeners
 */
export function startHeartbeatWatchdog(
  ws: WebSocketLike,
  config: Required<WebSocketClientTransportHeartbeatOptions>,
  ctx: HeartbeatWatchdogContext,
): () => void {
  if (!supportsPing(ws)) {
    // Browser-style socket without ping/terminate — the watchdog is inert.
    return () => {};
  }

  let stopped = false;
  let lastInboundAt = Date.now();
  let interval: ReturnType<typeof setInterval> | null = null;
  let probeDeadline: ReturnType<typeof setTimeout> | null = null;

  /** Inbound evidence (message or pong): the peer is alive right now. */
  const onEvidence = (): void => {
    lastInboundAt = Date.now();
    if (probeDeadline !== null) {
      clearTimeout(probeDeadline);
      probeDeadline = null;
    }
  };

  /** Self-stop when the socket closes for any reason (clean or terminated). */
  const onClose = (): void => {
    stop();
  };

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    if (probeDeadline !== null) {
      clearTimeout(probeDeadline);
      probeDeadline = null;
    }
    ws.removeEventListener('message', onEvidence);
    ws.removeEventListener('close', onClose);
    ws.off('pong', onEvidence);
  };

  ws.addEventListener('message', onEvidence);
  ws.on('pong', onEvidence);
  ws.addEventListener('close', onClose);

  interval = setInterval(() => {
    if (probeDeadline !== null) {
      // A probe is already in flight; its deadline decides.
      return;
    }
    if (Date.now() - lastInboundAt < config.intervalMs) {
      // Fresh inbound evidence — no probe needed this cycle.
      return;
    }
    if (ws.readyState !== 1) {
      // Not open (yet/anymore) — pinging would throw; close handling owns this.
      return;
    }
    ws.ping();
    probeDeadline = setTimeout(() => {
      probeDeadline = null;
      // Stop first so no timer can fire on the terminated socket, then
      // terminate (not close: a dead peer never answers a close handshake).
      stop();
      if (ctx.debug) {
        console.warn(
          `[WebSocketClientTransport:${ctx.name}] ${new Date().toISOString()} Heartbeat deadline expired (no message/pong within ${config.timeoutMs}ms) — terminating socket`,
        );
      }
      ws.terminate();
    }, config.timeoutMs);
    unrefTimer(probeDeadline);
  }, config.intervalMs);
  unrefTimer(interval);

  return stop;
}
