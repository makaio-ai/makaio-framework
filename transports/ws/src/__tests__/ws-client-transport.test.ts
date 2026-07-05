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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { MockWebSocket } from './test-helpers.js';
import { waitForCondition } from './test-utils.js';
import type { TransportAuth } from '../types.js';
import type { TransportReceiveContext } from '@makaio/core';

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
  const mock = new MockWebSocket();
  const transport = new WebSocketClientTransport({
    url: 'ws://localhost:9999',
    createWebSocket: () => mock,
    autoReconnect: options.autoReconnect ?? false,
    onConnected: options.onConnected,
    onDisconnected: options.onDisconnected,
    auth: options.auth,
  });
  return { transport, mock };
}

/**
 * Acknowledge the latest dynamic subscription message sent by a mock socket.
 * @param mock - Socket whose last sent message carries the ack id.
 */
async function acknowledgeLatestSubscription(mock: MockWebSocket): Promise<void> {
  await waitForCondition(() => mock.sentMessages.length > 0, 1000, 'subscription message was not sent');
  const last = mock.sentMessages.at(-1);
  expect(last).toBeDefined();
  const message = JSON.parse(last!) as { ackId?: string };
  expect(message.ackId).toEqual(expect.any(String));
  mock.receiveMessage(JSON.stringify({ type: 'subscription-ack', ackId: message.ackId }));
}

// ---------------------------------------------------------------------------
// onConnected
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — onConnected', () => {
  it('fires after connect() resolves', async () => {
    const onConnected = vi.fn();
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
  let onDisconnected: ReturnType<typeof vi.fn<() => void>>;
  let transport: WebSocketClientTransport;
  let mock: MockWebSocket;

  beforeEach(() => {
    onDisconnected = vi.fn<() => void>();
    ({ transport, mock } = makeTransport({
      onDisconnected,
      autoReconnect: { baseMs: 50, maxMs: 100 },
    }));
  });

  it('fires when socket closes unexpectedly (reconnect enabled)', async () => {
    await transport.connect();
    expect(onDisconnected).not.toHaveBeenCalled();

    // Simulate unexpected close.
    mock.close();

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
    const { transport, mock } = makeTransport({});

    // Subscribe before connecting — socket is null, so buffered only.
    await transport.subscribe('test.*');
    expect(mock.sentMessages).toHaveLength(0);

    // Now connect — connectOnce replays localSubscriptions.
    await transport.connect();

    // One subscribe wire message should have been sent during replay.
    const parsed = mock.sentMessages.map((m) => JSON.parse(m) as { type: string; subjects: Record<string, number[]> });
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
    const { transport, mock } = makeTransport({});
    await transport.connect();
    const subscribe = transport.subscribe('test.*');
    await acknowledgeLatestSubscription(mock);
    await subscribe;

    mock.clearSentMessages();

    const unsubscribe = transport.unsubscribe('test.*');
    await acknowledgeLatestSubscription(mock);
    await unsubscribe;

    expect(mock.sentMessages).toHaveLength(1);
    const msg = JSON.parse(mock.sentMessages[0]) as {
      type: string;
      ackId?: string;
      subjects: Record<string, number[]>;
    };
    expect(msg.type).toBe('unsubscribe');
    expect(msg.ackId).toEqual(expect.any(String));
    expect(Object.keys(msg.subjects)).toContain('test.*');
    // The subjects value must be a number[] (priority array) — even an empty one.
    expect(Array.isArray(msg.subjects['test.*'])).toBe(true);
    for (const priority of msg.subjects['test.*']) {
      expect(typeof priority).toBe('number');
    }

    await transport.disconnect();
  });

  it('keeps subscribe pending until the server acknowledges routing state', async () => {
    const { transport, mock } = makeTransport({});
    await transport.connect();

    let settled = false;
    const subscribe = transport.subscribe('test.*').then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    await acknowledgeLatestSubscription(mock);
    await subscribe;
    expect(settled).toBe(true);

    await transport.disconnect();
  });

  it('acknowledges inbound subscription updates after local handlers run', async () => {
    const { transport, mock } = makeTransport({});
    const handled: string[] = [];
    transport.onReceive(async (message) => {
      if (message.type === 'subscribe') {
        handled.push(Object.keys(message.subjects)[0] ?? '');
      }
    });
    await transport.connect();

    mock.receiveMessage(
      JSON.stringify({
        type: 'subscribe',
        ackId: 'peer-subscribe-1',
        subjects: { 'peer.topic': [] },
      }),
    );

    await waitForCondition(
      () =>
        mock.sentMessages.some((entry) => {
          const message = JSON.parse(entry) as { type?: string; ackId?: string };
          return message.type === 'subscription-ack' && message.ackId === 'peer-subscribe-1';
        }),
      1000,
      'subscription ack was not sent',
    );
    expect(handled).toEqual(['peer.topic']);

    await transport.disconnect();
  });

  it('does not acknowledge inbound subscription updates when a local handler fails', async () => {
    const { transport, mock } = makeTransport({});
    let handlerFinished = false;
    transport.onReceive(async (message) => {
      if (message.type === 'subscribe') {
        handlerFinished = true;
        throw new Error('subscription handler failed');
      }
    });
    await transport.connect();

    mock.receiveMessage(
      JSON.stringify({
        type: 'subscribe',
        ackId: 'peer-subscribe-failed',
        subjects: { 'peer.topic': [] },
      }),
    );

    await waitForCondition(() => handlerFinished, 1000, 'failing handler did not run');
    expect(
      mock.sentMessages.some((entry) => {
        const message = JSON.parse(entry) as { type?: string; ackId?: string };
        return message.type === 'subscription-ack' && message.ackId === 'peer-subscribe-failed';
      }),
    ).toBe(false);

    await transport.disconnect();
  });

  it('contains inbound subscription acknowledgement send failures', async () => {
    const ackEncodeError = new Error('subscription ack encode failed');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    const mock = new MockWebSocket();
    const transport = new WebSocketClientTransport({
      url: 'ws://localhost:9999',
      createWebSocket: () => mock,
      autoReconnect: false,
      debug: true,
      codec: {
        encode: async (message) => {
          if (message.type === 'subscription-ack') {
            throw ackEncodeError;
          }
          return JSON.stringify(message);
        },
        decode: async (message) => message as import('@makaio/bus-core').BusMessage,
      },
    });

    let handled = false;
    transport.onReceive(async (message) => {
      if (message.type === 'subscribe') {
        handled = true;
      }
    });

    try {
      await transport.connect();

      mock.receiveMessage(
        JSON.stringify({
          type: 'subscribe',
          ackId: 'peer-subscribe-encode-fails',
          subjects: { 'peer.topic': [] },
        }),
      );

      await waitForCondition(() => consoleErrorSpy.mock.calls.length > 0, 1000, 'ack failure was not logged');
      await Promise.resolve();

      expect(handled).toBe(true);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[WebSocketClientTransport:ws-client] Handler dispatch error:',
        ackEncodeError,
      );
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      consoleErrorSpy.mockRestore();
      if (transport.isReady()) {
        await transport.disconnect();
      }
    }
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
    const { transport, mock } = makeTransport({});
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
    mock.receiveMessage(JSON.stringify({ type: 'subscribe-sync-complete' }));

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
  it('merges auth receive context into inbound handler context', async () => {
    const receiveContext: TransportReceiveContext = {
      transportName: '',
      peer: { kind: 'workflow-execution', id: 'exec-1', authenticated: true },
    };
    const auth: TransportAuth = {
      authenticateClient: vi.fn(async () => {}),
      authenticateServer: vi.fn(async () => {}),
      handleAuthMessage: vi.fn(() => false),
      getReceiveContext: vi.fn(() => receiveContext),
      cleanupSocket: vi.fn(),
      cleanup: vi.fn(),
    };
    const { transport, mock } = makeTransport({ auth });
    const receivedContexts: Array<TransportReceiveContext | undefined> = [];
    transport.onReceive(async (_message, context) => {
      receivedContexts.push(context);
    });

    await transport.connect();
    mock.receiveMessage(
      JSON.stringify({
        type: 'event',
        namespace: 'test',
        subject: 'received',
        messageId: 'msg-auth-context',
        payload: {},
      }),
    );

    await waitForCondition(() => receivedContexts.length === 1, 1000, 'inbound handler did not receive message');
    expect(auth.getReceiveContext).toHaveBeenCalledTimes(1);
    expect(receivedContexts[0]).toEqual({
      transportName: 'ws-client',
      peer: { kind: 'workflow-execution', id: 'exec-1', authenticated: true },
    });

    await transport.disconnect();
  });

  it('cleans auth resources on explicit disconnect', async () => {
    const auth: TransportAuth = {
      authenticateClient: vi.fn(async () => {}),
      authenticateServer: vi.fn(async () => {}),
      handleAuthMessage: vi.fn(() => false),
      cleanupSocket: vi.fn(),
      cleanup: vi.fn(),
    };
    const { transport } = makeTransport({ auth });

    await transport.connect();
    await transport.disconnect();

    expect(auth.cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans pending auth when disconnecting mid-handshake', async () => {
    let rejectAuth: ((error: Error) => void) | undefined;
    const auth: TransportAuth = {
      authenticateClient: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectAuth = reject;
          }),
      ),
      authenticateServer: vi.fn(async () => {}),
      handleAuthMessage: vi.fn(() => false),
      cleanupSocket: vi.fn(),
      cleanup: vi.fn(() => {
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
    vi.useRealTimers();
  });

  it('calls createWebSocket again after an unexpected close', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const mocks: MockWebSocket[] = [];

    // The makeTransport helper is not used here — we need a custom factory.
    // We recreate the transport directly to track createWebSocket call count.
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

    // Advance fake timers past the first backoff window.
    await vi.advanceTimersByTimeAsync(200);

    // The factory should have been called at least twice (initial + reconnect attempt).
    expect(callCount).toBeGreaterThanOrEqual(2);

    await trackingTransport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// in-flight request rejection on reconnect
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — in-flight request rejection on reconnect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects pending request correlations when socket closes and reconnects', async () => {
    const mocks: MockWebSocket[] = [];
    const factory = (): MockWebSocket => {
      const m = new MockWebSocket();
      mocks.push(m);
      return m;
    };

    const transport = new WebSocketClientTransport({
      url: 'ws://localhost:9999',
      createWebSocket: factory,
      autoReconnect: { baseMs: 50, maxMs: 200 },
    });

    await transport.connect();
    const firstSocket = mocks[0];

    // Send a request — the response will never arrive because we close the socket.
    const requestPromise = transport.send({
      type: 'request' as const,
      subject: 'test.action',
      namespace: 'test',
      messageId: 'msg-inflight',
      correlationId: 'corr-inflight-1',
      payload: { data: 'value' },
    });

    // Wait for the send to actually transmit (codec encode is async).
    await waitForCondition(
      () => firstSocket.sentMessages.some((m) => m.includes('corr-inflight-1')),
      1000,
      'request was not sent on the wire',
    );

    // Socket drops — response is lost.
    firstSocket.close();

    // The reconnect loop detects the close and rejects pending correlations.
    // The in-flight request must be rejected with a connection-loss error,
    // NOT left pending until timeout and NOT surfaced as NO_HANDLER.
    await expect(requestPromise).rejects.toThrow(/connection lost/i);

    await transport.disconnect();
  });

  it('rejects in-flight requests before the reconnect backoff delay', async () => {
    const mocks: MockWebSocket[] = [];
    const factory = (): MockWebSocket => {
      const m = new MockWebSocket();
      mocks.push(m);
      return m;
    };

    const transport = new WebSocketClientTransport({
      url: 'ws://localhost:9999',
      createWebSocket: factory,
      autoReconnect: { baseMs: 5000, maxMs: 10000 },
    });

    await transport.connect();
    const firstSocket = mocks[0];

    // Send a request with a long timeout so it would not time out on its own.
    const requestPromise = transport.send(
      {
        type: 'request' as const,
        subject: 'test.action',
        namespace: 'test',
        messageId: 'msg-inflight-2',
        correlationId: 'corr-inflight-2',
        payload: {},
      },
      30_000,
    );

    // Wait for the send to actually transmit.
    await waitForCondition(
      () => firstSocket.sentMessages.some((m) => m.includes('corr-inflight-2')),
      1000,
      'request was not sent on the wire',
    );

    // Socket drops.
    firstSocket.close();

    // Must already be rejected — not still pending even though backoff hasn't started.
    await expect(requestPromise).rejects.toThrow(/connection lost/i);

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// in-flight drain before rejectAll
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — in-flight drain before rejectAll', () => {
  it('resolves correlation when socket closes mid async codec.decode', async () => {
    // Use a codec whose decode() is delayed so that rejectAll fires first in
    // broken code, but after the drain fix the correlation resolves correctly.
    let resolveDecodeBarrier!: () => void;
    const decodeBarrier = new Promise<void>((res) => {
      resolveDecodeBarrier = res;
    });

    const mock = new MockWebSocket();
    const transport = new WebSocketClientTransport({
      url: 'ws://localhost:9999',
      createWebSocket: () => mock,
      autoReconnect: false,
      codec: {
        encode: async (msg) => JSON.stringify(msg),
        decode: async (msg) => {
          // Hold the decode until we release it — simulates a slow async step
          await decodeBarrier;
          return msg as import('@makaio/bus-core').BusMessage;
        },
      },
    });

    await transport.connect();

    // Register a handler so the message gets processed after decode
    transport.onReceive(async () => {});

    // Issue a request — correlation is tracked
    const requestPromise = transport.send({
      type: 'request' as const,
      subject: 'test.drain',
      namespace: 'test',
      messageId: 'msg-drain-1',
      correlationId: 'corr-drain-1',
      payload: {},
    });

    // Wait for the request to be sent on the wire
    await waitForCondition(
      () => mock.sentMessages.some((m) => m.includes('corr-drain-1')),
      1000,
      'request was not sent on the wire',
    );

    // Server sends the response frame — this kicks off handleInboundMessage
    // but codec.decode is held by the barrier so it hasn't resolved yet
    mock.receiveMessage(
      JSON.stringify({
        type: 'response',
        correlationId: 'corr-drain-1',
        result: { answer: 42 },
      }),
    );

    // Close the socket immediately — before decode resolves
    mock.close();

    // Now release the decode barrier — the response should still resolve
    resolveDecodeBarrier();

    // With the drain fix: the correlation resolves with the response result.
    // Without the fix: rejectAll fires first → ConnectionLostError.
    await expect(requestPromise).resolves.toEqual({ answer: 42 });

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// drain does not block on stuck application handlers
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — drain does not block on stuck application handlers', () => {
  it('rejects pending outgoing correlations promptly even when an inbound REQUEST handler never resolves', async () => {
    const mock = new MockWebSocket();
    const transport = new WebSocketClientTransport({
      url: 'ws://localhost:9999',
      createWebSocket: () => mock,
      autoReconnect: false,
    });

    // Register a handler that returns a never-resolving promise for request messages.
    transport.onReceive(async (message) => {
      if (message.type === 'request') {
        await new Promise<void>(() => {
          // intentionally never resolves
        });
      }
    });

    await transport.connect();

    // Issue an outgoing request — this creates a pending correlation.
    const outgoingRequestPromise = transport.send({
      type: 'request' as const,
      subject: 'test.action',
      namespace: 'test',
      messageId: 'msg-stuck-handler-out',
      correlationId: 'corr-stuck-handler-out',
      payload: {},
    });

    // Wait for outgoing request to be on the wire.
    await waitForCondition(
      () => mock.sentMessages.some((m) => m.includes('corr-stuck-handler-out')),
      1000,
      'outgoing request was not sent on the wire',
    );

    // Server sends an inbound REQUEST — this triggers the never-resolving handler.
    mock.receiveMessage(
      JSON.stringify({
        type: 'request',
        subject: 'test.inbound',
        namespace: 'test',
        messageId: 'msg-stuck-handler-in',
        correlationId: 'corr-stuck-handler-in',
        payload: {},
      }),
    );

    // Give the inbound handler a tick to start (but not finish — it never finishes).
    await Promise.resolve();

    // Close the socket — drainAndRejectPendingCorrelations must NOT wait on the
    // stuck handler; it must only wait for the correlation phase to complete.
    mock.close();

    // The pending outgoing correlation must be rejected promptly with
    // ConnectionLostError — the test timeout proves "promptly".
    await expect(outgoingRequestPromise).rejects.toThrow(/connection lost/i);

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// getSubscriptions
// ---------------------------------------------------------------------------

describe('WebSocketClientTransport — getSubscriptions', () => {
  it('returns the set of currently subscribed subjects', async () => {
    const { transport, mock } = makeTransport({});
    await transport.connect();

    const subscribeA = transport.subscribe('topic.a');
    await acknowledgeLatestSubscription(mock);
    await subscribeA;
    const subscribeB = transport.subscribe('topic.b');
    await acknowledgeLatestSubscription(mock);
    await subscribeB;

    const subs = transport.getSubscriptions();
    expect(subs.has('topic.a')).toBe(true);
    expect(subs.has('topic.b')).toBe(true);
    expect(subs.size).toBe(2);

    await transport.disconnect();
  });
});
