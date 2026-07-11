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
 * Tracks inbound evidence (`message` events and pong frames). A resettable
 * idle timer fires exactly `config.intervalMs` after the most recent inbound
 * evidence; when it fires a ping probe is sent and a `config.timeoutMs`
 * deadline armed. Evidence clears the deadline and re-arms the idle timer;
 * deadline expiry stops the watchdog and terminates the socket. The watchdog
 * self-stops when the socket closes and is inert for sockets without ping
 * support.
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
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let probeDeadline: ReturnType<typeof setTimeout> | null = null;

  /**
   * Schedule the idle check to fire `config.intervalMs` after the most
   * recent inbound evidence. Only called when no idle timer is pending:
   * a pending timer that fires too early (because fresher evidence moved
   * `lastInboundAt` forward) lazily re-schedules itself in `onIdleTick`
   * instead of being reset on every message — keeping the per-message
   * hot path free of timer churn.
   */
  const scheduleIdleCheck = (): void => {
    if (stopped) return;
    const elapsed = Date.now() - lastInboundAt;
    const delay = Math.max(0, config.intervalMs - elapsed);
    idleTimer = setTimeout(onIdleTick, delay);
    unrefTimer(idleTimer);
  };

  /** Terminate the socket after the probe deadline expires with no evidence. */
  const onDeadlineExpired = (): void => {
    probeDeadline = null;
    stop();
    if (ctx.debug) {
      console.warn(
        `[WebSocketClientTransport:${ctx.name}] ${new Date().toISOString()} Heartbeat deadline expired (no message/pong within ${config.timeoutMs}ms) — terminating socket`,
      );
    }
    ws.terminate();
  };

  /** Fired when `intervalMs` has elapsed since the last inbound evidence. */
  const onIdleTick = (): void => {
    idleTimer = null;
    if (stopped) return;
    if (probeDeadline !== null) return; // Probe already in flight; its deadline decides.
    if (Date.now() - lastInboundAt < config.intervalMs) {
      // Evidence arrived after we were scheduled but before we fired.
      scheduleIdleCheck();
      return;
    }
    if (ws.readyState !== 1) return; // Not open — close handling owns this.
    ws.ping();
    probeDeadline = setTimeout(onDeadlineExpired, config.timeoutMs);
    unrefTimer(probeDeadline);
  };

  /** Inbound evidence (message or pong): the peer is alive right now. */
  const onEvidence = (): void => {
    lastInboundAt = Date.now();
    if (probeDeadline !== null) {
      clearTimeout(probeDeadline);
      probeDeadline = null;
    }
    // Re-arm only when no idle timer is pending (i.e. after a probe was
    // sent); otherwise the pending timer lazily re-schedules on fire.
    if (idleTimer === null) {
      scheduleIdleCheck();
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
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
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

  scheduleIdleCheck();

  return stop;
}
