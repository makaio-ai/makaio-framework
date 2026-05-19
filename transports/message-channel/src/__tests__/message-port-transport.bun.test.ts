/**
 * Unit tests for `createMessagePortTransport`.
 *
 * Tests verify the public contract of the transport: lifecycle, envelope mode,
 * pre-registration buffering, the ready handshake, correlation tracking,
 * subscribe/unsubscribe semantics, heartbeat filtering, and disconnect cleanup.
 *
 * All tests use a simple `MockPort` that stores posted messages and lets the
 * test drive incoming message delivery — no mocking of the SUT itself.
 *
 * MockPort invokes `onmessage` synchronously (no event-loop scheduling), which
 * is intentional: the transport's bus subscribe/unsubscribe handlers are fully
 * synchronous Map operations, so the scheduling difference does not affect
 * correctness. Using a real `MessageChannel` would add async complexity without
 * exercising different code paths.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { waitFor } from '@makaio/test-utils';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { createBusInstance } from '@makaio/bus-core';
import type { BusMessage, BusEventMessage, BusSubscribeMessage } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { createMessagePortTransport } from '../message-port-transport.js';
import type { MessagePortLike } from '../types.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// MockPort helpers
// ---------------------------------------------------------------------------

/**
 * Minimal in-test MessagePort stand-in.
 *
 * `posted` holds every value passed to `postMessage` in arrival order.
 * `receive(data)` simulates the port delivering an inbound message by invoking
 * the currently-assigned `onmessage` handler.
 */
interface MockPort {
  /** The {@link MessagePortLike} to pass to `createMessagePortTransport`. */
  port: MessagePortLike;
  /** Messages posted by the transport (outbound from the transport's perspective). */
  posted: unknown[];
  /**
   * Simulate an inbound message arriving on the port.
   * @param data - Raw message data to wrap in a synthetic {@link MessageEvent}
   */
  receive(data: unknown): void;
}

/**
 * Create a controllable {@link MessagePortLike} for testing.
 *
 * The returned object allows tests to inspect every outbound `postMessage` call
 * via `posted` and inject inbound messages via `receive(data)`.
 * @returns A `MockPort` with attached `port`, `posted` array, and `receive` helper
 */
function createMockPort(): MockPort {
  const posted: unknown[] = [];
  let handler: ((event: MessageEvent) => void) | null = null;

  const port: MessagePortLike = {
    postMessage(data: unknown): void {
      posted.push(data);
    },
    get onmessage(): ((event: MessageEvent) => void) | null {
      return handler;
    },
    set onmessage(h: ((event: MessageEvent) => void) | null) {
      handler = h;
    },
  };

  return {
    port,
    posted,
    receive(data: unknown): void {
      handler?.({ data } as MessageEvent);
    },
  };
}

/**
 * Adapt a real Node.js `MessagePort` to the `MessagePortLike` contract used by
 * the transport under test.
 * @param port - Node.js message port to wrap
 * @returns `MessagePortLike` wrapper that mirrors the port's `onmessage` state
 */
function adaptNodeMessagePort(port: MessagePort): MessagePortLike {
  let handler: ((event: MessageEvent) => void) | null = null;
  let listener: ((data: unknown) => void) | null = null;

  return {
    postMessage(data: unknown): void {
      port.postMessage(data);
    },
    get onmessage(): ((event: MessageEvent) => void) | null {
      return handler;
    },
    set onmessage(nextHandler: ((event: MessageEvent) => void) | null) {
      if (listener !== null) {
        port.off('message', listener);
        listener = null;
      }

      handler = nextHandler;
      if (nextHandler === null) return;

      listener = (data: unknown): void => {
        nextHandler({ data } as MessageEvent);
      };
      port.on('message', listener);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared message factories
// ---------------------------------------------------------------------------

/**
 * Build a minimal `BusEventMessage` suitable for delivery tests.
 * @param subject - Event subject
 * @param payload - Optional payload object
 * @returns A `BusEventMessage`
 */
function makeEventMessage(subject: string, payload: unknown = {}): BusEventMessage {
  return {
    type: 'event',
    subject,
    namespace: 'test',
    payload,
    messageId: `msg-${subject}`,
  };
}

/**
 * Wrap a `BusMessage` in the bus envelope used when `envelope: true`.
 * @param message - Message to wrap
 * @returns An envelope object `{ channel: 'bus', message }`
 */
function wrapEnvelope(message: BusMessage): { channel: 'bus'; message: BusMessage } {
  return { channel: 'bus', message };
}

// ---------------------------------------------------------------------------
// subscribe-sync-complete helper
// ---------------------------------------------------------------------------

/**
 * Deliver a `subscribe-sync-complete` message to the mock port.
 * @param mock - The mock port to deliver to
 * @param useEnvelope - Whether the transport is in envelope mode
 */
function deliverSyncComplete(mock: MockPort, useEnvelope: boolean): void {
  const msg: BusMessage = { type: 'subscribe-sync-complete' };
  mock.receive(useEnvelope ? wrapEnvelope(msg) : msg);
}

// ---------------------------------------------------------------------------
// 1. Basic lifecycle
// ---------------------------------------------------------------------------

describe('createMessagePortTransport — lifecycle', () => {
  it('attaches onmessage handler on connect and detaches on disconnect', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port, name: 'test' });

    expect(mock.port.onmessage).toBeNull();

    await transport.connect();
    expect(mock.port.onmessage).toBeTypeOf('function');

    await transport.disconnect();
    expect(mock.port.onmessage).toBeNull();
  });

  it('returns the configured name', () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port, name: 'my-transport' });
    expect(transport.name).toBe('my-transport');
  });

  it('defaults name to "message-port" when not provided', () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    expect(transport.name).toBe('message-port');
  });

  it('onReceive returns an unsubscribe function that removes the handler', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    const received: BusMessage[] = [];
    const unsubscribe = transport.onReceive(async (msg) => {
      received.push(msg);
    });

    const event = makeEventMessage('test.event');
    mock.receive(event);
    await waitFor(() => {
      expect(received).toHaveLength(1);
    });

    unsubscribe();
    mock.receive(makeEventMessage('test.event2'));
    // Give a tick for any async delivery
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 2. Envelope mode
// ---------------------------------------------------------------------------

describe('createMessagePortTransport — envelope mode', () => {
  it('wraps outbound messages in { channel: "bus", message } envelope', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port, envelope: true });
    await transport.connect();

    const subscribeMsg: BusSubscribeMessage = {
      type: 'subscribe',
      subjects: { 'test.subject': [] },
    };
    await transport.subscribe('test.subject');

    // The posted message should be an envelope
    expect(mock.posted[0]).toEqual({ channel: 'bus', message: subscribeMsg });

    await transport.disconnect();
  });

  it('unwraps inbound envelopes and delivers the inner message', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port, envelope: true });
    await transport.connect();

    const received: BusMessage[] = [];
    transport.onReceive(async (msg) => {
      received.push(msg);
    });

    const event = makeEventMessage('envelope.event');
    mock.receive(wrapEnvelope(event));

    await waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toEqual(event);

    await transport.disconnect();
  });

  it('silently drops inbound messages that are not bus envelopes in envelope mode', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port, envelope: true });
    await transport.connect();

    const received: BusMessage[] = [];
    transport.onReceive(async (msg) => {
      received.push(msg);
    });

    // A raw (non-envelope) message — should be ignored
    mock.receive(makeEventMessage('raw.event'));
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(0);

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 3. Non-envelope mode
// ---------------------------------------------------------------------------

describe('createMessagePortTransport — non-envelope mode', () => {
  it('posts raw messages without wrapping', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port, envelope: false });
    await transport.connect();

    await transport.subscribe('raw.subject');

    const posted = mock.posted[0] as BusSubscribeMessage;
    expect(posted).not.toHaveProperty('channel');
    expect(posted.type).toBe('subscribe');

    await transport.disconnect();
  });

  it('delivers raw inbound messages directly to handlers', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    const received: BusMessage[] = [];
    transport.onReceive(async (msg) => {
      received.push(msg);
    });

    const event = makeEventMessage('raw.delivery');
    mock.receive(event);

    await waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toEqual(event);

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 4. Pre-registration buffer
// ---------------------------------------------------------------------------

describe('createMessagePortTransport — pre-registration buffer', () => {
  it('buffers messages arriving before onReceive and replays them in order', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    const e1 = makeEventMessage('buffered.1');
    const e2 = makeEventMessage('buffered.2');
    const e3 = makeEventMessage('buffered.3');

    // Deliver before any handler is registered
    mock.receive(e1);
    mock.receive(e2);
    mock.receive(e3);

    const received: BusMessage[] = [];
    transport.onReceive(async (msg) => {
      received.push(msg);
    });

    // Replay is async (IIFE inside onReceive); waitFor must throw on failure
    // (not return false) so that it retries until the condition is met.
    await waitFor(() => {
      expect(received).toHaveLength(3);
    });

    expect(received[0]).toEqual(e1);
    expect(received[1]).toEqual(e2);
    expect(received[2]).toEqual(e3);

    await transport.disconnect();
  });

  it('does not replay already-delivered messages to a second handler', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    const e1 = makeEventMessage('buffered.only-first');
    mock.receive(e1);

    const firstReceived: BusMessage[] = [];
    transport.onReceive(async (msg) => {
      firstReceived.push(msg);
    });

    await waitFor(() => {
      expect(firstReceived).toHaveLength(1);
    });

    const secondReceived: BusMessage[] = [];
    transport.onReceive(async (msg) => {
      secondReceived.push(msg);
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(secondReceived).toHaveLength(0);

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 5 & 6. Ready handshake
// ---------------------------------------------------------------------------

describe('createMessagePortTransport — ready promise', () => {
  it('resolves after subscribe-sync-complete is received and buffer is empty (handler registered first)', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    // Register handler before sync-complete arrives (normal bus.connect() flow)
    transport.onReceive(async () => {});

    let resolved = false;
    void transport.ready.then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    deliverSyncComplete(mock, false);

    await transport.ready;
    expect(resolved).toBe(true);

    await transport.disconnect();
  });

  it('resolves immediately when subscribe-sync-complete arrives after handler registered and buffer is empty', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    transport.onReceive(async () => {});

    // deliver sync-complete
    deliverSyncComplete(mock, false);

    // Should already resolve after one microtask
    await transport.ready;

    await transport.disconnect();
  });

  it('defers ready until buffer replay completes after subscribe-sync-complete', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    // Deliver messages before handler and sync-complete
    const e1 = makeEventMessage('pre-sync.event');
    mock.receive(e1);

    // Deliver sync-complete before any handler is registered
    deliverSyncComplete(mock, false);

    const handlerOrder: string[] = [];
    transport.onReceive(async (msg) => {
      if (msg.type === 'event') {
        handlerOrder.push((msg as BusEventMessage).subject);
      }
    });

    // ready resolves only after replay finishes
    await transport.ready;

    // Confirm replay happened before ready resolved
    expect(handlerOrder).toContain('pre-sync.event');

    await transport.disconnect();
  });

  it('resolves ready (without hanging) on disconnect before handshake arrives', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    // Disconnect before sync-complete — ready must not hang
    await transport.disconnect();

    await expect(transport.ready).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Correlation tracking
// ---------------------------------------------------------------------------

describe('createMessagePortTransport — correlation tracking', () => {
  it('send() posts a request message and resolves when a matching response arrives', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    const correlationId = 'corr-test-1';
    const requestMsg: BusMessage = {
      type: 'request',
      subject: 'test.subject',
      namespace: 'test',
      payload: { foo: 'bar' },
      correlationId,
      messageId: 'msg-1',
    };

    // Send the request — this will pend until response arrives
    const sendPromise = transport.send(requestMsg, 5_000);

    // Simulate the remote peer sending back a response
    const responseMsg: BusMessage = {
      type: 'response',
      correlationId,
      result: { answer: 42 },
    };
    mock.receive(responseMsg);

    const result = await sendPromise;
    expect(result).toEqual({ answer: 42 });

    await transport.disconnect();
  });

  it('cancelRequest() rejects the pending correlation promise', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    const correlationId = 'corr-cancel-1';
    const requestMsg: BusMessage = {
      type: 'request',
      subject: 'test.cancel',
      namespace: 'test',
      payload: {},
      correlationId,
      messageId: 'msg-cancel-1',
    };

    const sendPromise = transport.send(requestMsg, 0);
    const cancelError = new Error('Cancelled by test');
    // cancelRequest is optional on BusTransport but always provided by this transport
    expect(transport.cancelRequest).toBeTypeOf('function');
    transport.cancelRequest?.(correlationId, cancelError);

    await expect(sendPromise).rejects.toThrow('Cancelled by test');

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 9. Real MessageChannel pair
// ---------------------------------------------------------------------------

describe('createMessagePortTransport — real MessageChannel pair', () => {
  it('round-trips request/response, event delivery, ready handshake, and disconnect cleanup', async () => {
    const busA = createBusInstance();
    const busB = createBusInstance();

    const { subjects: SubjectsA } = busA.registerNamespace(
      createBusNamespace('messageChannelTransport', {
        ping: {
          request: z.object({
            input: z.string(),
          }),
          response: z.object({
            output: z.string(),
          }),
        },
        notice: z.object({
          label: z.string(),
        }),
      }),
    );

    const { subjects: SubjectsB } = busB.registerNamespace(
      createBusNamespace('messageChannelTransport', {
        ping: {
          request: z.object({
            input: z.string(),
          }),
          response: z.object({
            output: z.string(),
          }),
        },
        notice: z.object({
          label: z.string(),
        }),
      }),
    );

    const { port1, port2 } = new MessageChannel();
    const adaptedPort1 = adaptNodeMessagePort(port1);
    const adaptedPort2 = adaptNodeMessagePort(port2);
    const transportA = createMessagePortTransport({ port: adaptedPort1, name: 'real-a' });
    const transportB = createMessagePortTransport({ port: adaptedPort2, name: 'real-b' });

    const notices: string[] = [];
    busB.on(SubjectsB.notice, (ctx) => {
      notices.push(ctx.payload.label);
    });
    busB.on(SubjectsB.ping, (ctx) => {
      ctx.setResult({ output: `pong:${ctx.payload.input}` });
    });

    busA.registerTransport(transportA);
    busB.registerTransport(transportB);

    const readyA = transportA.ready;
    const readyB = transportB.ready;

    await Promise.all([busA.connect(), busB.connect()]);
    await Promise.all([readyA, readyB]);

    const response = await busA.request(SubjectsA.ping, { input: 'hello' });
    expect(response).toEqual({ output: 'pong:hello' });

    await busA.emit(SubjectsA.notice, { label: 'delivered' });
    await waitFor(() => {
      expect(notices).toEqual(['delivered']);
    });

    await Promise.all([busA.disconnect(), busB.disconnect()]);

    expect(adaptedPort1.onmessage).toBeNull();
    expect(adaptedPort2.onmessage).toBeNull();

    port1.close();
    port2.close();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 10. Subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe('createMessagePortTransport — subscribe / unsubscribe', () => {
  let mock: MockPort;

  beforeEach(() => {
    mock = createMockPort();
  });

  it('subscribe() adds subject to local subscriptions and posts a subscribe message', async () => {
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    await transport.subscribe('adapter.event', undefined, [100, 200]);

    expect(transport.getSubscriptions().has('adapter.event')).toBe(true);

    const posted = mock.posted[0] as BusSubscribeMessage;
    expect(posted.type).toBe('subscribe');
    expect(posted.subjects).toEqual({ 'adapter.event': [100, 200] });

    await transport.disconnect();
  });

  it('unsubscribe() removes subject from local subscriptions and posts an unsubscribe message', async () => {
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    await transport.subscribe('adapter.event', undefined, [100]);
    mock.posted.length = 0; // clear subscribe post

    await transport.unsubscribe('adapter.event');

    expect(transport.getSubscriptions().has('adapter.event')).toBe(false);

    const posted = mock.posted[0] as { type: string; subjects: Record<string, number[]> };
    expect(posted.type).toBe('unsubscribe');
    expect(posted.subjects).toEqual({ 'adapter.event': [100] });

    await transport.disconnect();
  });

  it('preserves existing filter when re-subscribing with only new priorities', async () => {
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    const filter = { agentId: 'agent-1' };
    await transport.subscribe('agent.event', filter, [100]);
    mock.posted.length = 0;

    // Re-subscribe with new priorities, no filter provided (should preserve)
    await transport.subscribe('agent.event', undefined, [200]);

    const posted = mock.posted[0] as BusSubscribeMessage;
    expect(posted.subjects).toEqual({ 'agent.event': [200] });
    expect(posted.filters).toEqual({ 'agent.event': filter });

    await transport.disconnect();
  });

  it('getSubscriptions() returns a snapshot (not the live set)', async () => {
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    await transport.subscribe('snap.subject');
    const snapshot1 = transport.getSubscriptions();

    await transport.unsubscribe('snap.subject');
    const snapshot2 = transport.getSubscriptions();

    // snapshot1 was taken before unsubscribe — it should still contain the subject
    expect(snapshot1.has('snap.subject')).toBe(true);
    expect(snapshot2.has('snap.subject')).toBe(false);

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 9. Heartbeat filtering
// ---------------------------------------------------------------------------

describe('createMessagePortTransport — heartbeat filtering', () => {
  it('silently drops heartbeat messages without delivering them to handlers', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    const received: BusMessage[] = [];
    transport.onReceive(async (msg) => {
      received.push(msg);
    });

    const heartbeat: BusMessage = { type: 'heartbeat', timestamp: Date.now() };
    mock.receive(heartbeat);

    // Give async delivery a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(0);

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 10. Disconnect cleanup
// ---------------------------------------------------------------------------

describe('createMessagePortTransport — disconnect cleanup', () => {
  it('clears correlations, ready, handlers, and subscriptions on disconnect', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    await transport.subscribe('cleanup.subject');
    transport.onReceive(async () => {});

    // Start a pending correlation (timeout 0 = no auto-timeout)
    const correlationId = 'corr-cleanup-1';
    const pendingRequest: BusMessage = {
      type: 'request',
      subject: 'cleanup.subject',
      namespace: 'test',
      payload: {},
      correlationId,
      messageId: 'msg-cleanup-1',
    };
    const sendPromise = transport.send(pendingRequest, 0);

    await transport.disconnect();

    // Pending correlation is rejected by CorrelationTracker.cleanup() with a
    // "Transport disconnected" error — callers must handle this rejection.
    await expect(sendPromise).rejects.toThrow('Transport disconnected');

    // Subscriptions are cleared
    expect(transport.getSubscriptions().size).toBe(0);

    // onmessage is cleared
    expect(mock.port.onmessage).toBeNull();

    // ready is resolved (does not hang)
    await expect(transport.ready).resolves.toBeUndefined();
  });

  it('does not deliver messages after disconnect', async () => {
    const mock = createMockPort();
    const transport = createMessagePortTransport({ port: mock.port });
    await transport.connect();

    const received: BusMessage[] = [];
    transport.onReceive(async (msg) => {
      received.push(msg);
    });

    await transport.disconnect();

    // Deliver after disconnect — handler should not fire (onmessage is null)
    mock.receive(makeEventMessage('post-disconnect.event'));
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(0);
  });
});
