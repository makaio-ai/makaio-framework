/**
 * Unit tests for `WebSocketClientTransport`.
 *
 * Covers lifecycle callbacks, send/connect guards, subscription buffering and
 * wire messages, readiness state, ready-promise resolution, reconnect backoff,
 * and getSubscriptions tracking.
 *
 * Tests use `MockWebSocket` via the `createWebSocket` factory to control socket
 * lifecycle without touching the network.
 */

import { describe, it, expect, mock, jest, beforeEach, afterEach } from 'bun:test';
import { advanceTimersByTimeAsync } from '@makaio/test-utils';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { MockWebSocket } from './test-helpers.js';
import { waitForCondition } from './test-utils.js';
import type { TransportAuth } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a `WebSocketClientTransport` backed by a controllable `MockWebSocket`.
 *
 * Reconnection is disabled by default to keep tests deterministic. Pass
 * `autoReconnect: { baseMs, maxMs }` to enable it.
 * @param options - Partial override for transport options
 * @returns Transport instance and the underlying mock socket
 */
function makeTransport(options: {
  onConnected?: () => void;
  onDisconnected?: () => void;
  autoReconnect?: { baseMs: number; maxMs: number } | false;
  auth?: TransportAuth;
}): { transport: WebSocketClientTransport; mock: MockWebSocket } {
  const mockWs = new MockWebSocket();
  const transport = new WebSocketClientTransport({
    url: 'ws://localhost:9999',
    createWebSocket: () => mockWs,
    autoReconnect: options.autoReconnect ?? false,
    onConnected: options.onConnected,
    onDisconnected: options.onDisconnected,
    auth: options.auth,
  });
  return { transport, mock: mockWs };
}

// ---------------------------------------------------------------------------
// onConnected
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — onConnected', () => {
  it('fires after connect() resolves', async () => {
    const onConnected = mock<() => void>();
    const { transport } = makeTransport({ onConnected });

    await transport.connect();

    expect(onConnected).toHaveBeenCalledTimes(1);

    await transport.disconnect();
  });

  it('does not fire when no callback is provided', async () => {
    // No onConnected — should not throw
    const { transport } = makeTransport({});

    await expect(transport.connect()).resolves.toBeUndefined();

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// onDisconnected
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — onDisconnected', () => {
  let onDisconnected: ReturnType<typeof mock<() => void>>;
  let transport: WebSocketClientTransport;
  let mockWs: MockWebSocket;

  beforeEach(() => {
    onDisconnected = mock<() => void>();
    ({ transport, mock: mockWs } = makeTransport({
      onDisconnected,
      autoReconnect: { baseMs: 50, maxMs: 100 },
    }));
  });

  it('fires when socket closes unexpectedly (reconnect enabled)', async () => {
    await transport.connect();
    expect(onDisconnected).not.toHaveBeenCalled();

    // Simulate unexpected close.
    mockWs.close();

    // Give the reconnect loop one tick to detect the closure.
    await waitForCondition(() => onDisconnected.mock.calls.length > 0, 1000, 'onDisconnected not called after close');

    expect(onDisconnected).toHaveBeenCalledTimes(1);

    await transport.disconnect();
  });

  it('does NOT fire when disconnect() is called explicitly', async () => {
    await transport.connect();
    expect(onDisconnected).not.toHaveBeenCalled();

    await transport.disconnect();

    // Allow any pending microtasks/macrotasks to flush.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(onDisconnected).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// send guard
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — send guard', () => {
  it('throws "not connected" when called before connect()', async () => {
    const { transport } = makeTransport({});

    await expect(
      transport.send({
        type: 'event',
        subject: 'test.ping',
        namespace: 'test',
        messageId: 'msg-1',
        payload: {},
      }),
    ).rejects.toThrow('WebSocketClientTransport: not connected');
  });
});

// ---------------------------------------------------------------------------
// connect guard
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — connect guard', () => {
  it('throws "already connected" when connect() is called a second time', async () => {
    const { transport } = makeTransport({});
    await transport.connect();

    await expect(transport.connect()).rejects.toThrow('WebSocketClientTransport: already connected');

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// subscribe buffering
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — subscribe buffering', () => {
  it('buffers a subscribe call before connect and sends it on connect', async () => {
    const { transport, mock: mockWs } = makeTransport({});

    // Subscribe before connecting — socket is null, so buffered only.
    await transport.subscribe('test.*');
    expect(mockWs.sentMessages).toHaveLength(0);

    // Now connect — connectOnce replays localSubscriptions.
    await transport.connect();

    // One subscribe wire message should have been sent during replay.
    const parsed = mockWs.sentMessages.map(
      (m) => JSON.parse(m) as { type: string; subjects: Record<string, number[]> },
    );
    const subscribeMsg = parsed.find((m) => m.type === 'subscribe');
    expect(subscribeMsg).toBeDefined();
    // The subjects value must be a number[] (priority array) — even an empty one.
    expect(Array.isArray(subscribeMsg?.subjects['test.*'])).toBe(true);
    for (const priority of subscribeMsg?.subjects['test.*'] ?? []) {
      expect(typeof priority).toBe('number');
    }

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// unsubscribe wire message
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — unsubscribe', () => {
  it('sends an unsubscribe wire message when the socket is open', async () => {
    const { transport, mock: mockWs } = makeTransport({});
    await transport.connect();
    await transport.subscribe('test.*');

    mockWs.clearSentMessages();

    await transport.unsubscribe('test.*');

    expect(mockWs.sentMessages).toHaveLength(1);
    const msg = JSON.parse(mockWs.sentMessages[0]) as { type: string; subjects: Record<string, number[]> };
    expect(msg.type).toBe('unsubscribe');
    expect(Object.keys(msg.subjects)).toContain('test.*');
    // The subjects value must be a number[] (priority array) — even an empty one.
    expect(Array.isArray(msg.subjects['test.*'])).toBe(true);
    for (const priority of msg.subjects['test.*']) {
      expect(typeof priority).toBe('number');
    }

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// isReady
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — isReady', () => {
  it('reflects connection state accurately', async () => {
    const { transport } = makeTransport({});

    expect(transport.isReady()).toBe(false);

    await transport.connect();
    expect(transport.isReady()).toBe(true);

    await transport.disconnect();
    expect(transport.isReady()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ready promise
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — ready promise', () => {
  it('resolves when subscribe-sync-complete is received', async () => {
    const { transport, mock: mockWs } = makeTransport({});
    await transport.connect();

    // The ready promise is pending until the handshake arrives.
    let resolved = false;
    void transport.ready.then(() => {
      resolved = true;
    });

    // Flush microtasks — ready should still be pending.
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Server sends subscribe-sync-complete.
    mockWs.receiveMessage(JSON.stringify({ type: 'subscribe-sync-complete' }));

    await waitForCondition(() => resolved, 1000, 'ready promise did not resolve');

    await transport.disconnect();
  });

  it('resolves pending ready promise when disconnect() is called', async () => {
    const { transport } = makeTransport({});
    await transport.connect();

    let resolved = false;
    void transport.ready.then(() => {
      resolved = true;
    });

    // Disconnect before the handshake — ready must not hang.
    await transport.disconnect();

    await waitForCondition(() => resolved, 1000, 'ready promise did not resolve after disconnect');
  });
});

// ---------------------------------------------------------------------------
// auth lifecycle
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — auth lifecycle', () => {
  it('cleans auth resources on explicit disconnect', async () => {
    const auth: TransportAuth = {
      authenticateClient: mock(async () => {}),
      authenticateServer: mock(async () => {}),
      handleAuthMessage: mock(() => false),
      cleanupSocket: mock(),
      cleanup: mock(),
    };
    const { transport } = makeTransport({ auth });

    await transport.connect();
    await transport.disconnect();

    expect(auth.cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans pending auth when disconnecting mid-handshake', async () => {
    let rejectAuth: ((error: Error) => void) | undefined;
    const auth: TransportAuth = {
      authenticateClient: mock(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectAuth = reject;
          }),
      ),
      authenticateServer: mock(async () => {}),
      handleAuthMessage: mock(() => false),
      cleanupSocket: mock(),
      cleanup: mock(() => {
        rejectAuth?.(new Error('auth cleanup'));
      }),
    };
    const { transport } = makeTransport({ auth });

    const connectPromise = transport.connect();
    await waitForCondition(() => rejectAuth !== undefined, 1000, 'authenticateClient was not called before disconnect');

    await transport.disconnect();

    expect(auth.cleanup).toHaveBeenCalledTimes(1);
    await expect(connectPromise).rejects.toThrow('auth cleanup');
  });
});

// ---------------------------------------------------------------------------
// reconnect backoff
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — reconnect backoff', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('calls createWebSocket again after an unexpected close', async () => {
    jest.useFakeTimers();

    let callCount = 0;
    const mocks: MockWebSocket[] = [];

    // We need a custom factory to track createWebSocket call count.
    const mock0 = new MockWebSocket();
    let currentMock = mock0;
    const factory = (): MockWebSocket => {
      callCount++;
      const m = new MockWebSocket();
      mocks.push(m);
      currentMock = m;
      return m;
    };

    const trackingTransport = new (await import('../ws-client-transport.js')).WebSocketClientTransport({
      url: 'ws://localhost:9999',
      createWebSocket: factory,
      autoReconnect: { baseMs: 50, maxMs: 200 },
    });

    await trackingTransport.connect();
    expect(callCount).toBe(1);

    // Simulate unexpected close.
    currentMock.close();

    // Drain microtasks so the reconnect loop advances past waitForClose (which
    // resolves immediately since readyState is already 3) and registers the
    // backoff sleep timer before we advance the fake clock.
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }

    // Advance fake timers past the first backoff window.
    await advanceTimersByTimeAsync(200);

    // Drain microtasks so connectOnce resolves and invokes the wsFactory.
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }

    // The factory should have been called at least twice (initial + reconnect attempt).
    expect(callCount).toBeGreaterThanOrEqual(2);

    await trackingTransport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// getSubscriptions
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — getSubscriptions', () => {
  it('returns the set of currently subscribed subjects', async () => {
    const { transport } = makeTransport({});
    await transport.connect();

    await transport.subscribe('topic.a');
    await transport.subscribe('topic.b');

    const subs = transport.getSubscriptions();
    expect(subs.has('topic.a')).toBe(true);
    expect(subs.has('topic.b')).toBe(true);
    expect(subs.size).toBe(2);

    await transport.disconnect();
  });
});
