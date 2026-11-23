import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CorePartyKind, createBusNamespace, type Party } from '@makaio/core';
import { createBusInstance } from '../index.js';
import { createBusContext } from '../kernel-api.js';
import { MockTransport } from './helpers/transport-fixtures.js';

const REMOTE_CALLER: Party = { kind: CorePartyKind.e2ePeer, id: 'remote-device' };

/**
 * Build an isolated bus instance with a freshly registered namespace containing
 * subjects for events, requests, and broadcasts.
 * @returns Bus instance and its registered namespace subjects.
 */
function createTestBus() {
  const bus = createBusInstance({ context: createBusContext() });
  const namespace = bus.registerNamespace(
    createBusNamespace('transport-context-test', {
      happened: z.object({ value: z.string() }),
      compute: {
        request: z.object({ input: z.string() }),
        response: z.object({ output: z.string() }),
      },
      collect: {
        request: z.object({ tag: z.string() }),
        response: z.object({ nodeId: z.string() }),
      },
    }),
  );
  return { bus, namespace };
}

describe('Handler transport context — request', () => {
  it('keeps the in-process call for a local request', async () => {
    const { bus, namespace } = createTestBus();

    const capturedContext = vi.fn();
    bus.on(namespace.subjects.compute, (ctx) => {
      capturedContext(ctx.transport, ctx.call);
      ctx.setResult({ output: 'ok' });
    });

    const call = bus.own('root');
    await bus.request(call, namespace.subjects.compute, { input: 'x' });

    expect(capturedContext).toHaveBeenCalledOnce();
    expect(capturedContext).toHaveBeenCalledWith(undefined, call);
  });

  it('uses the transport-supplied caller for a remote request', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('req-transport');
    bus.registerTransport(transport);

    const capturedContext = vi.fn();
    bus.on(namespace.subjects.compute, (ctx) => {
      capturedContext(ctx.transport?.transportName, ctx.call.caller);
      ctx.setResult({ output: 'remote-ok' });
    });

    const receiveContext = { transportName: transport.name, caller: REMOTE_CALLER };
    await transport.simulateReceive(
      {
        type: 'request',
        namespace: 'transport-context-test',
        subject: 'compute',
        payload: { input: 'y' },
        correlationId: 'corr-r1',
        messageId: 'msg-r1',
      },
      receiveContext,
    );

    expect(capturedContext).toHaveBeenCalledOnce();
    expect(capturedContext).toHaveBeenCalledWith(transport.name, REMOTE_CALLER);
  });

  it('transport field is undefined for local requests', async () => {
    const { bus, namespace } = createTestBus();

    const capturedTransport = vi.fn();
    bus.on(namespace.subjects.compute, (ctx) => {
      capturedTransport(ctx.transport);
      ctx.setResult({ output: 'ok' });
    });

    await bus.request(bus.own('root'), namespace.subjects.compute, { input: 'x' });

    expect(capturedTransport).toHaveBeenCalledOnce();
    expect(capturedTransport.mock.calls[0][0]).toBeUndefined();
  });

  it('provides an anonymous caller and transport context for a remote request without metadata', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('req-transport-2');
    bus.registerTransport(transport);

    const capturedContext = vi.fn();
    bus.on(namespace.subjects.compute, (ctx) => {
      capturedContext(ctx.transport, ctx.call.caller);
      ctx.setResult({ output: 'remote-ok' });
    });

    await transport.simulateReceive({
      type: 'request',
      namespace: 'transport-context-test',
      subject: 'compute',
      payload: { input: 'y' },
      correlationId: 'corr-r2',
      messageId: 'msg-r2',
    });

    expect(capturedContext).toHaveBeenCalledOnce();
    expect(capturedContext).toHaveBeenCalledWith(
      { transportName: transport.name },
      { kind: CorePartyKind.anonymous, id: transport.name },
    );
  });
});

describe('Handler transport context — event', () => {
  it('keeps the in-process call for a local event', async () => {
    const { bus, namespace } = createTestBus();

    const capturedContext = vi.fn();
    bus.on(namespace.subjects.happened, (ctx) => {
      capturedContext(ctx.transport, ctx.call);
    });

    const call = bus.own('root');
    await bus.emit(call, namespace.subjects.happened, { value: 'local' });

    expect(capturedContext).toHaveBeenCalledOnce();
    expect(capturedContext).toHaveBeenCalledWith(undefined, call);
  });

  it('uses the transport-supplied caller for a remote event', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('evt-transport');
    bus.registerTransport(transport);

    const capturedContext = vi.fn();
    bus.on(namespace.subjects.happened, (ctx) => {
      capturedContext(ctx.transport?.transportName, ctx.call.caller);
    });

    const receiveContext = { transportName: transport.name, caller: REMOTE_CALLER };
    await transport.simulateReceive(
      {
        type: 'event',
        namespace: 'transport-context-test',
        subject: 'happened',
        payload: { value: 'remote' },
        messageId: 'msg-e1',
      },
      receiveContext,
    );

    expect(capturedContext).toHaveBeenCalledOnce();
    expect(capturedContext).toHaveBeenCalledWith(transport.name, REMOTE_CALLER);
  });

  it('transport is undefined for local events', async () => {
    const { bus, namespace } = createTestBus();

    const capturedTransport = vi.fn();
    bus.on(namespace.subjects.happened, (ctx) => {
      capturedTransport(ctx.transport);
    });

    await bus.emit(bus.own('root'), namespace.subjects.happened, { value: 'local' });

    expect(capturedTransport).toHaveBeenCalledOnce();
    expect(capturedTransport.mock.calls[0][0]).toBeUndefined();
  });

  it('provides an anonymous caller and transport context for a remote event without metadata', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('evt-transport-2');
    bus.registerTransport(transport);

    const capturedContext = vi.fn();
    bus.on(namespace.subjects.happened, (ctx) => {
      capturedContext(ctx.transport, ctx.call.caller);
    });

    await transport.simulateReceive({
      type: 'event',
      namespace: 'transport-context-test',
      subject: 'happened',
      payload: { value: 'remote' },
      messageId: 'msg-e2',
    });

    expect(capturedContext).toHaveBeenCalledOnce();
    expect(capturedContext).toHaveBeenCalledWith(
      { transportName: transport.name },
      { kind: CorePartyKind.anonymous, id: transport.name },
    );
  });
});

describe('Handler transport context — broadcast', () => {
  it('keeps the in-process call for a local broadcast', async () => {
    const { bus, namespace } = createTestBus();

    const capturedContext = vi.fn();
    bus.on(namespace.subjects.collect, (ctx) => {
      capturedContext(ctx.transport, ctx.call);
      ctx.identify?.('local');
      ctx.setResult({ nodeId: 'local' });
    });

    const call = bus.own('root');
    await bus.broadcast(call, namespace.subjects.collect, { tag: 'test' });

    expect(capturedContext).toHaveBeenCalledOnce();
    expect(capturedContext).toHaveBeenCalledWith(undefined, call);
  });

  it('uses the transport-supplied caller for a remote broadcast', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('bc-transport');
    bus.registerTransport(transport);

    const capturedContext = vi.fn();
    bus.on(namespace.subjects.collect, (ctx) => {
      capturedContext(ctx.transport?.transportName, ctx.call.caller);
      ctx.identify?.('local');
      ctx.setResult({ nodeId: 'local' });
    });

    const receiveContext = { transportName: transport.name, caller: REMOTE_CALLER };
    await transport.simulateReceive(
      {
        type: 'broadcast',
        namespace: 'transport-context-test',
        subject: 'collect',
        payload: { tag: 'remote' },
        correlationId: 'corr-bc1',
        messageId: 'msg-bc1',
      },
      receiveContext,
    );

    expect(capturedContext).toHaveBeenCalledOnce();
    expect(capturedContext).toHaveBeenCalledWith(transport.name, REMOTE_CALLER);
  });

  it('transport is undefined for local broadcasts', async () => {
    const { bus, namespace } = createTestBus();

    const capturedTransport = vi.fn();
    bus.on(namespace.subjects.collect, (ctx) => {
      capturedTransport(ctx.transport);
      ctx.identify?.('local');
      ctx.setResult({ nodeId: 'local' });
    });

    await bus.broadcast(bus.own('root'), namespace.subjects.collect, { tag: 'test' });

    expect(capturedTransport).toHaveBeenCalledOnce();
    expect(capturedTransport.mock.calls[0][0]).toBeUndefined();
  });

  it('provides an anonymous caller and transport context for a remote broadcast without metadata', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('bc-transport-2');
    bus.registerTransport(transport);

    const capturedContext = vi.fn();
    bus.on(namespace.subjects.collect, (ctx) => {
      capturedContext(ctx.transport, ctx.call.caller);
      ctx.identify?.('local');
      ctx.setResult({ nodeId: 'local' });
    });

    await transport.simulateReceive({
      type: 'broadcast',
      namespace: 'transport-context-test',
      subject: 'collect',
      payload: { tag: 'remote' },
      correlationId: 'corr-bc2',
      messageId: 'msg-bc2',
    });

    expect(capturedContext).toHaveBeenCalledOnce();
    expect(capturedContext).toHaveBeenCalledWith(
      { transportName: transport.name },
      { kind: CorePartyKind.anonymous, id: transport.name },
    );
  });
});
