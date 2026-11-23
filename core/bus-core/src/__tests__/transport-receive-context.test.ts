import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { createBusInstance } from '../index.js';
import { createBusContext } from '../kernel-api.js';
import { MockTransport } from './helpers/transport-fixtures.js';

describe('transport receive context', () => {
  it('threads trusted transport context into request handlers', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const namespace = bus.registerNamespace(
      createBusNamespace('receiveContextTest', {
        read: {
          request: z.object({ value: z.string() }),
          response: z.object({ principalId: z.string().optional() }),
        },
      }),
    );
    const transport = new MockTransport('context-transport');
    bus.registerTransport(transport);

    const observed = vi.fn();
    const caller = { kind: 'acme.user', id: 'user-1' };
    bus.on(namespace.subjects.read, (ctx) => {
      observed(ctx.transport, ctx.call.principal);
      ctx.setResult({ principalId: ctx.call.principal.id });
    });

    await transport.simulateReceive(
      {
        type: 'request',
        namespace: 'receiveContextTest',
        subject: 'read',
        payload: { value: 'a' },
        correlationId: 'corr-1',
        messageId: 'msg-1',
      },
      {
        transportName: 'context-transport',
        connectionId: 'conn-1',
        caller,
      },
    );

    expect(observed).toHaveBeenCalledWith(
      {
        transportName: 'context-transport',
        connectionId: 'conn-1',
        caller,
      },
      caller,
    );
    expect(transport.messages).toContainEqual({
      type: 'response',
      correlationId: 'corr-1',
      result: { principalId: 'user-1' },
    });
  });

  it('threads trusted transport context into event handlers', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const namespace = bus.registerNamespace(
      createBusNamespace('receiveContextEventTest', {
        changed: z.object({ value: z.string() }),
      }),
    );
    const transport = new MockTransport('context-transport');
    bus.registerTransport(transport);

    const observed = vi.fn();
    const caller = { kind: 'acme.user', id: 'user-event-1' };
    bus.on(namespace.subjects.changed, (ctx) => {
      observed(ctx.transport, ctx.call.principal);
    });

    await transport.simulateReceive(
      {
        type: 'event',
        namespace: 'receiveContextEventTest',
        subject: 'changed',
        payload: { value: 'a' },
        messageId: 'msg-event-1',
      },
      {
        transportName: 'context-transport',
        connectionId: 'conn-event-1',
        caller,
      },
    );

    expect(observed).toHaveBeenCalledWith(
      {
        transportName: 'context-transport',
        connectionId: 'conn-event-1',
        caller,
      },
      caller,
    );
  });

  it('threads trusted transport context into broadcast handlers', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const namespace = bus.registerNamespace(
      createBusNamespace('receiveContextBroadcastTest', {
        collect: {
          request: z.object({ value: z.string() }),
          response: z.object({ principalId: z.string().optional() }),
        },
      }),
    );
    const transport = new MockTransport('context-transport');
    bus.registerTransport(transport);

    bus.on(namespace.subjects.collect, (ctx) => {
      ctx.identify?.('local');
      ctx.setResult({ principalId: ctx.call.principal.id });
    });

    await transport.simulateReceive(
      {
        type: 'broadcast',
        namespace: 'receiveContextBroadcastTest',
        subject: 'collect',
        payload: { value: 'a' },
        correlationId: 'corr-broadcast-1',
        messageId: 'msg-broadcast-1',
      },
      {
        transportName: 'context-transport',
        connectionId: 'conn-broadcast-1',
        caller: { kind: 'acme.user', id: 'user-broadcast-1' },
      },
    );

    expect(transport.messages).toContainEqual({
      type: 'broadcast-response',
      correlationId: 'corr-broadcast-1',
      results: [{ nodeId: 'local', payload: { principalId: 'user-broadcast-1' } }],
    });
  });

  it('does not serialize receive context when relaying to another transport', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    const source = new MockTransport('source');
    const peer = new MockTransport('peer');
    bus.registerTransport(source);
    bus.registerTransport(peer);

    await source.simulateReceive(
      {
        type: 'event',
        namespace: 'unregistered',
        subject: 'event',
        payload: { value: 'a' },
        messageId: 'msg-relay-1',
      },
      {
        transportName: 'source',
        connectionId: 'conn-relay-1',
        caller: { kind: 'acme.user', id: 'user-relay-1' },
      },
    );

    expect(peer.messages).toHaveLength(1);
    expect(peer.messages[0]).toEqual({
      type: 'event',
      namespace: 'unregistered',
      subject: 'event',
      payload: { value: 'a' },
      messageId: 'msg-relay-1',
      // The relaying host vouches for the principal it received; nothing of the receive context crosses.
      metadata: { principal: { kind: 'acme.user', id: 'user-relay-1' } },
    });
    expect(peer.messages[0]).not.toHaveProperty('transport');
    expect(peer.messages[0]).not.toHaveProperty('principal');
    expect(peer.messages[0]).not.toHaveProperty('caller');
  });
});
