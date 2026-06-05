import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { createBusContext, createBusInstance } from '../index.js';
import { MockTransport } from './helpers/transport-fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an isolated bus instance with a freshly registered namespace containing
 * one event subject and one request subject.
 * @returns Bus instance and its registered namespace subjects.
 */
function createTestBus() {
  const bus = createBusInstance({ context: createBusContext() });
  const namespace = bus.registerNamespace(
    createBusNamespace('origin-test', {
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

// ---------------------------------------------------------------------------
// Request origin
// ---------------------------------------------------------------------------

describe('MessageOrigin — request', () => {
  it('sets origin.local = true for a locally dispatched request', async () => {
    const { bus, namespace } = createTestBus();

    const capturedOrigin = vi.fn();
    bus.on(namespace.subjects.compute, (ctx) => {
      capturedOrigin(ctx.origin);
      ctx.setResult({ output: 'ok' });
    });

    await bus.request(namespace.subjects.compute, { input: 'x' });

    expect(capturedOrigin).toHaveBeenCalledOnce();
    expect(capturedOrigin.mock.calls[0][0]).toEqual({ local: true });
  });

  it('sets origin.local = false for a request arriving via transport', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('req-transport');
    bus.registerTransport(transport);

    const capturedOrigin = vi.fn();
    bus.on(namespace.subjects.compute, (ctx) => {
      capturedOrigin(ctx.origin);
      ctx.setResult({ output: 'remote-ok' });
    });

    await transport.simulateReceive({
      type: 'request',
      namespace: 'origin-test',
      subject: 'compute',
      payload: { input: 'y' },
      correlationId: 'corr-r1',
      messageId: 'msg-r1',
    });

    expect(capturedOrigin).toHaveBeenCalledOnce();
    expect(capturedOrigin.mock.calls[0][0]).toEqual({ local: false });
  });

  it('transport field is undefined for local requests', async () => {
    const { bus, namespace } = createTestBus();

    const capturedTransport = vi.fn();
    bus.on(namespace.subjects.compute, (ctx) => {
      capturedTransport(ctx.transport);
      ctx.setResult({ output: 'ok' });
    });

    await bus.request(namespace.subjects.compute, { input: 'x' });

    expect(capturedTransport).toHaveBeenCalledOnce();
    expect(capturedTransport.mock.calls[0][0]).toBeUndefined();
  });

  it('transport field is defined for remote requests', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('req-transport-2');
    bus.registerTransport(transport);

    const capturedTransport = vi.fn();
    bus.on(namespace.subjects.compute, (ctx) => {
      capturedTransport(ctx.transport);
      ctx.setResult({ output: 'remote-ok' });
    });

    await transport.simulateReceive({
      type: 'request',
      namespace: 'origin-test',
      subject: 'compute',
      payload: { input: 'y' },
      correlationId: 'corr-r2',
      messageId: 'msg-r2',
    });

    expect(capturedTransport).toHaveBeenCalledOnce();
    expect(capturedTransport.mock.calls[0][0]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Event origin
// ---------------------------------------------------------------------------

describe('MessageOrigin — event', () => {
  it('sets origin.local = true for a locally emitted event', async () => {
    const { bus, namespace } = createTestBus();

    const capturedOrigin = vi.fn();
    bus.on(namespace.subjects.happened, (ctx) => {
      capturedOrigin(ctx.origin);
    });

    await bus.emit(namespace.subjects.happened, { value: 'local' });

    expect(capturedOrigin).toHaveBeenCalledOnce();
    expect(capturedOrigin.mock.calls[0][0]).toEqual({ local: true });
  });

  it('sets origin.local = false for an event arriving via transport', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('evt-transport');
    bus.registerTransport(transport);

    const capturedOrigin = vi.fn();
    bus.on(namespace.subjects.happened, (ctx) => {
      capturedOrigin(ctx.origin);
    });

    await transport.simulateReceive({
      type: 'event',
      namespace: 'origin-test',
      subject: 'happened',
      payload: { value: 'remote' },
      messageId: 'msg-e1',
    });

    expect(capturedOrigin).toHaveBeenCalledOnce();
    expect(capturedOrigin.mock.calls[0][0]).toEqual({ local: false });
  });

  it('transport is undefined for local events', async () => {
    const { bus, namespace } = createTestBus();

    const capturedTransport = vi.fn();
    bus.on(namespace.subjects.happened, (ctx) => {
      capturedTransport(ctx.transport);
    });

    await bus.emit(namespace.subjects.happened, { value: 'local' });

    expect(capturedTransport).toHaveBeenCalledOnce();
    expect(capturedTransport.mock.calls[0][0]).toBeUndefined();
  });

  it('transport is defined for remote events', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('evt-transport-2');
    bus.registerTransport(transport);

    const capturedTransport = vi.fn();
    bus.on(namespace.subjects.happened, (ctx) => {
      capturedTransport(ctx.transport);
    });

    await transport.simulateReceive({
      type: 'event',
      namespace: 'origin-test',
      subject: 'happened',
      payload: { value: 'remote' },
      messageId: 'msg-e2',
    });

    expect(capturedTransport).toHaveBeenCalledOnce();
    expect(capturedTransport.mock.calls[0][0]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Broadcast origin
// ---------------------------------------------------------------------------

describe('MessageOrigin — broadcast', () => {
  it('sets origin.local = true for a locally dispatched broadcast', async () => {
    const { bus, namespace } = createTestBus();

    const capturedOrigin = vi.fn();
    bus.on(namespace.subjects.collect, (ctx) => {
      capturedOrigin(ctx.origin);
      ctx.identify?.('local');
      ctx.setResult({ nodeId: 'local' });
    });

    await bus.broadcast(namespace.subjects.collect, { tag: 'test' });

    expect(capturedOrigin).toHaveBeenCalledOnce();
    expect(capturedOrigin.mock.calls[0][0]).toEqual({ local: true });
  });

  it('sets origin.local = false for a broadcast arriving via transport', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('bc-transport');
    bus.registerTransport(transport);

    const capturedOrigin = vi.fn();
    bus.on(namespace.subjects.collect, (ctx) => {
      capturedOrigin(ctx.origin);
      ctx.identify?.('local');
      ctx.setResult({ nodeId: 'local' });
    });

    await transport.simulateReceive({
      type: 'broadcast',
      namespace: 'origin-test',
      subject: 'collect',
      payload: { tag: 'remote' },
      correlationId: 'corr-bc1',
      messageId: 'msg-bc1',
    });

    expect(capturedOrigin).toHaveBeenCalledOnce();
    expect(capturedOrigin.mock.calls[0][0]).toEqual({ local: false });
  });

  it('transport is undefined for local broadcasts', async () => {
    const { bus, namespace } = createTestBus();

    const capturedTransport = vi.fn();
    bus.on(namespace.subjects.collect, (ctx) => {
      capturedTransport(ctx.transport);
      ctx.identify?.('local');
      ctx.setResult({ nodeId: 'local' });
    });

    await bus.broadcast(namespace.subjects.collect, { tag: 'test' });

    expect(capturedTransport).toHaveBeenCalledOnce();
    expect(capturedTransport.mock.calls[0][0]).toBeUndefined();
  });

  it('transport is defined for remote broadcasts', async () => {
    const { bus, namespace } = createTestBus();
    const transport = new MockTransport('bc-transport-2');
    bus.registerTransport(transport);

    const capturedTransport = vi.fn();
    bus.on(namespace.subjects.collect, (ctx) => {
      capturedTransport(ctx.transport);
      ctx.identify?.('local');
      ctx.setResult({ nodeId: 'local' });
    });

    await transport.simulateReceive({
      type: 'broadcast',
      namespace: 'origin-test',
      subject: 'collect',
      payload: { tag: 'remote' },
      correlationId: 'corr-bc2',
      messageId: 'msg-bc2',
    });

    expect(capturedTransport).toHaveBeenCalledOnce();
    expect(capturedTransport.mock.calls[0][0]).toBeDefined();
  });
});
