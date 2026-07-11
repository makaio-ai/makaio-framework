/**
 * Unit tests for the heartbeat liveness watchdog (issue #374).
 *
 * Tests `startHeartbeatWatchdog` and `supportsPing` directly against
 * `MockWebSocket` with real timers and tiny intervals. The watchdog contract:
 * probe with RFC-6455 pings after `intervalMs` of inbound silence, terminate
 * the socket when no evidence (message or pong) arrives within `timeoutMs`
 * of a probe, self-stop on socket close, and stay inert for sockets without
 * ping support.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startHeartbeatWatchdog, supportsPing, type HeartbeatWatchdogContext } from '../ws-client-heartbeat.js';
import { resolveHeartbeatConfig } from '../ws-client-options.js';
import type { WebSocketLike } from '../types.js';
import { MockWebSocket } from './test-helpers.js';
import { waitForCondition } from './test-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX: HeartbeatWatchdogContext = { name: 'heartbeat-test', debug: false };

/**
 * Build a resolved heartbeat config with tiny timings for real-timer tests.
 * @param intervalMs - Idle interval between liveness checks
 * @param timeoutMs - Probe deadline before termination
 */
function heartbeatConfig(intervalMs = 25, timeoutMs = 25): { intervalMs: number; timeoutMs: number } {
  return { intervalMs, timeoutMs };
}

/**
 * Sleep for a bounded, short duration (only used to prove absence of events).
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a minimal `WebSocketLike` WITHOUT ping capability (browser-style).
 * @param onClose - Invoked when `close()` is called
 */
function makePlainSocket(onClose?: () => void): WebSocketLike {
  return {
    readyState: 1,
    send: () => {},
    close: () => {
      onClose?.();
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

describe('heartbeat watchdog — unit', () => {
  /** Stop functions registered by tests; always released, even on failure. */
  const stops: Array<() => void> = [];

  afterEach(() => {
    while (stops.length > 0) {
      stops.pop()?.();
    }
  });

  // -------------------------------------------------------------------------
  // (a) supportsPing
  // -------------------------------------------------------------------------

  it('supportsPing detects ping capability on the extended mock and rejects plain sockets', () => {
    expect(supportsPing(new MockWebSocket())).toBe(true);
    expect(supportsPing(makePlainSocket())).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (b) dead socket → terminate
  // -------------------------------------------------------------------------

  it('terminates a half-open socket after interval + deadline of total silence', async () => {
    const ws = new MockWebSocket();
    ws.autoPong = false; // Peer is dead: pings are never answered.
    stops.push(startHeartbeatWatchdog(ws, heartbeatConfig(25, 25), CTX));

    await waitForCondition(() => ws.terminated, 1000, 'watchdog did not terminate the dead socket');
    expect(ws.pingCount).toBeGreaterThanOrEqual(1);
    expect(ws.readyState).toBe(3);
  });

  // -------------------------------------------------------------------------
  // (c + e) responsive socket survives; pong evidence clears the deadline
  // -------------------------------------------------------------------------

  it('keeps probing an idle responsive socket without terminating it (pongs clear the deadline)', async () => {
    const ws = new MockWebSocket(); // autoPong defaults to true — every ping is answered.
    stops.push(startHeartbeatWatchdog(ws, heartbeatConfig(20, 20), CTX));

    // The socket is otherwise idle, so probes must actually be sent — and the
    // pong answers must keep clearing the deadline across ≥3 cycles.
    await waitForCondition(() => ws.pingCount >= 3, 1000, 'watchdog did not send ping probes on an idle connection');
    expect(ws.terminated).toBe(false);
    expect(ws.readyState).toBe(1);
  });

  // -------------------------------------------------------------------------
  // (d) inbound messages suppress probes
  // -------------------------------------------------------------------------

  it('suppresses probes entirely while inbound messages arrive within every interval', async () => {
    const ws = new MockWebSocket();
    ws.autoPong = false; // Pongs must not be needed when messages flow.
    stops.push(startHeartbeatWatchdog(ws, heartbeatConfig(30, 30), CTX));

    // Feed inbound traffic every 10 ms for ~5 interval cycles.
    for (let i = 0; i < 15; i++) {
      ws.receiveMessage(JSON.stringify({ type: 'event', subject: 'noise', namespace: 'test', payload: {} }));
      await sleep(10);
    }

    expect(ws.pingCount).toBe(0);
    expect(ws.terminated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (e2) inbound MESSAGE clears an already-armed probe deadline
  // -------------------------------------------------------------------------

  it('clears an armed probe deadline when an inbound message (not pong) arrives', async () => {
    const ws = new MockWebSocket();
    ws.autoPong = false; // Peer never answers pings — deadline relies on messages.
    // Short interval to trigger the first probe quickly, long timeout so the
    // second probe's deadline does not expire during the assertion window.
    stops.push(startHeartbeatWatchdog(ws, heartbeatConfig(20, 150), CTX));

    // Wait for the watchdog to send at least one probe (deadline is now armed).
    await waitForCondition(() => ws.pingCount >= 1, 1000, 'watchdog did not send a probe');

    // Feed an inbound message while the 150 ms deadline is armed — this must
    // clear the deadline and prevent termination. The evidence also resets the
    // idle timer, so the next probe fires ~20 ms later (its own 150 ms
    // deadline expires well after our assertion).
    ws.receiveMessage(JSON.stringify({ type: 'event', subject: 'alive', namespace: 'test', payload: {} }));

    // Sleep past the original deadline (150 ms). Without the message clearing
    // the first deadline, the socket would have been terminated. The second
    // probe's deadline (from the re-armed idle timer) expires ~170 ms after
    // the message, so at 160 ms the socket is still alive.
    await sleep(160);
    expect(ws.terminated).toBe(false);
    expect(ws.readyState).toBe(1);
  });

  // -------------------------------------------------------------------------
  // (f) non-ping-capable socket → inert
  // -------------------------------------------------------------------------

  it('is inert on a socket without ping support', async () => {
    let closed = false;
    const ws = makePlainSocket(() => {
      closed = true;
    });
    const stop = startHeartbeatWatchdog(ws, heartbeatConfig(20, 20), CTX);

    await sleep(120); // > 2 × (interval + timeout) — nothing may happen.
    expect(closed).toBe(false);
    stop(); // Must be callable without effect.
  });

  // -------------------------------------------------------------------------
  // (g) stop() halts probing, idempotent
  // -------------------------------------------------------------------------

  it('stop() halts probing, removes timers, and is idempotent', async () => {
    const ws = new MockWebSocket();
    const stop = startHeartbeatWatchdog(ws, heartbeatConfig(20, 20), CTX);
    stops.push(stop);

    await waitForCondition(() => ws.pingCount >= 1, 1000, 'watchdog never sent a probe before stop()');
    stop();
    const countAtStop = ws.pingCount;

    await sleep(120); // > interval + timeout — no further probes allowed.
    expect(ws.pingCount).toBe(countAtStop);
    expect(ws.terminated).toBe(false);

    stop(); // Second call must be safe.
  });

  // -------------------------------------------------------------------------
  // (h) socket close self-stops the watchdog
  // -------------------------------------------------------------------------

  it('self-stops when the socket closes — no further pings, no terminate', async () => {
    const ws = new MockWebSocket();
    stops.push(startHeartbeatWatchdog(ws, heartbeatConfig(20, 20), CTX));

    await waitForCondition(() => ws.pingCount >= 1, 1000, 'watchdog never sent a probe before close');
    ws.close();
    const countAtClose = ws.pingCount;

    // A leaked probe timer would throw (ping on a closed socket) and any
    // terminate call would flip the flag — both must not happen.
    await sleep(120);
    expect(ws.pingCount).toBe(countAtClose);
    expect(ws.terminated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveHeartbeatConfig — input validation (finding #3)
// ---------------------------------------------------------------------------

describe('resolveHeartbeatConfig — input validation', () => {
  it('returns false when heartbeat is disabled', () => {
    expect(resolveHeartbeatConfig(false)).toBe(false);
  });

  it('returns defaults when heartbeat is undefined', () => {
    const config = resolveHeartbeatConfig(undefined);
    expect(config).toEqual({ intervalMs: 30_000, timeoutMs: 10_000 });
  });

  it.each([0, -1, NaN, Infinity, -Infinity])('throws RangeError for invalid intervalMs: %s', (value) => {
    expect(() => resolveHeartbeatConfig({ intervalMs: value })).toThrow(RangeError);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])('throws RangeError for invalid timeoutMs: %s', (value) => {
    expect(() => resolveHeartbeatConfig({ timeoutMs: value })).toThrow(RangeError);
  });

  it('accepts valid positive finite values', () => {
    const config = resolveHeartbeatConfig({ intervalMs: 5000, timeoutMs: 2000 });
    expect(config).toEqual({ intervalMs: 5000, timeoutMs: 2000 });
  });
});
