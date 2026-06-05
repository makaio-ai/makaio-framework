import { describe, expect, it, vi } from 'vitest';
import { createBusInstance, type BusMessage, type BusTransport } from '@makaio/bus-core';
import { SubjectTelemetryFactSchema } from '@makaio/contracts';
import {
  collectorOnlySubject,
  createBusNamespace,
  localSubject,
  observability,
  type TransportReceiveContext,
} from '@makaio/core';
import { z } from 'zod';
import { attachUpstreamTelemetry } from '../upstream-telemetry.js';

interface TestTransport {
  readonly transport: BusTransport;
  readonly sent: BusMessage[];
}

interface ReceivedEmitOptions {
  readonly messageId: string;
  readonly transport: TransportReceiveContext;
}

function createTransport(): TestTransport {
  const sent: BusMessage[] = [];
  return {
    sent,
    transport: {
      name: 'raw-upstream',
      send: vi.fn(async (message: BusMessage) => {
        sent.push(message);
        return true;
      }) as BusTransport['send'],
      onReceive: () => () => undefined,
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      isReady: () => true,
    },
  };
}

function receivedFromTransport(transportName: string): ReceivedEmitOptions {
  return { messageId: `received-from-${transportName}`, transport: { transportName } };
}

describe('attachUpstreamTelemetry', () => {
  it('connects the projected transport and disconnects it on shutdown without bus registration', async () => {
    const bus = createBusInstance();
    const inner = createTransport();

    const attached = await attachUpstreamTelemetry(bus, 'machine-1', { transport: inner.transport });
    expect(bus.getContext().transportRegistry.names()).not.toContain('upstream-telemetry');
    expect(inner.transport.connect).toHaveBeenCalledTimes(1);

    await attached.shutdown();

    expect(bus.getContext().transportRegistry.names()).not.toContain('upstream-telemetry');
    expect(inner.transport.disconnect).toHaveBeenCalledTimes(1);
  });

  it('uses a custom name when provided', async () => {
    const bus = createBusInstance();
    const inner = createTransport();

    const attached = await attachUpstreamTelemetry(bus, 'machine-2', {
      transport: inner.transport,
      name: 'my-telemetry',
    });
    expect(bus.getContext().transportRegistry.names()).not.toContain('my-telemetry');

    await attached.shutdown();

    expect(bus.getContext().transportRegistry.names()).not.toContain('my-telemetry');
  });

  it('exports local requests through the message observer path', async () => {
    const bus = createBusInstance();
    const inner = createTransport();
    const namespace = createBusNamespace('demo', {
      load: {
        request: observability.schema(
          z.object({
            id: z.string(),
            secret: observability.hidden(z.string()),
          }),
          { traceAll: true },
        ),
        response: z.object({ ok: z.boolean() }),
      },
    });
    bus.registerNamespace(namespace);
    const cleanup = bus.on(namespace.subjects.load, (ctx) => ctx.setResult({ ok: true }));

    const attached = await attachUpstreamTelemetry(bus, 'machine-3', { transport: inner.transport });
    await bus.request(namespace.subjects.load, { id: 'one', secret: 'raw-secret' }, { messageId: 'request-1' });
    await vi.waitFor(() => expect(inner.sent).toHaveLength(1));

    const [message] = inner.sent;
    if (message?.type !== 'event') {
      throw new Error('Expected upstream telemetry export to emit a subject-telemetry fact event');
    }
    expect(message).toMatchObject({
      type: 'event',
      namespace: 'subject-telemetry',
      subject: 'fact',
    });
    const fact = SubjectTelemetryFactSchema.parse(message.payload);
    expect(fact).toMatchObject({
      factId: 'request-1:outbound',
      machineId: 'machine-3',
      namespace: 'demo',
      subject: 'load',
      messageType: 'request',
      direction: 'outbound',
      messageId: 'request-1',
      attributes: { id: 'one' },
    });
    expect(fact.attributes).not.toHaveProperty('secret');
    expect(JSON.stringify(message)).not.toContain('raw-secret');

    await attached.shutdown();
    cleanup();
  });

  it('does not export messages re-entering from another transport', async () => {
    const bus = createBusInstance();
    const inner = createTransport();
    const namespace = createBusNamespace('demo-inbound', {
      changed: z.object({ id: z.string() }),
    });
    bus.registerNamespace(namespace);

    const attached = await attachUpstreamTelemetry(bus, 'machine-inbound', { transport: inner.transport });
    await bus.emit(namespace.subjects.changed, { id: 'remote' }, receivedFromTransport('remote-peer'));

    expect(inner.sent).toHaveLength(0);

    await attached.shutdown();
  });

  it('does not export calls with explicit local-only transport routing', async () => {
    const bus = createBusInstance();
    const inner = createTransport();
    const namespace = createBusNamespace('demo-explicit-local', {
      changed: observability.schema(z.object({ id: z.string() }), { traceAll: true }),
      load: {
        request: observability.schema(z.object({ id: z.string() }), { traceAll: true }),
        response: z.object({ ok: z.boolean() }),
      },
      announce: {
        request: observability.schema(z.object({ id: z.string() }), { traceAll: true }),
        response: z.object({ ack: z.boolean() }),
      },
    });
    bus.registerNamespace(namespace);
    const cleanupRequest = bus.on(namespace.subjects.load, (ctx) => ctx.setResult({ ok: true }));
    const cleanupBroadcast = bus.on(namespace.subjects.announce, (ctx) => ctx.setResult({ ack: true }));

    const attached = await attachUpstreamTelemetry(bus, 'machine-explicit-local', { transport: inner.transport });
    await bus.emit(namespace.subjects.changed, { id: 'event' }, { transports: [] });
    await bus.request(namespace.subjects.load, { id: 'request' }, { transports: [] });
    await bus.broadcast(namespace.subjects.announce, { id: 'broadcast' }, { transports: [] });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(inner.sent).toHaveLength(0);

    await attached.shutdown();
    cleanupRequest();
    cleanupBroadcast();
  });

  it('does not export local-only or collector-only subjects upstream', async () => {
    const bus = createBusInstance();
    const inner = createTransport();
    const namespace = createBusNamespace('demo-private', {
      localOnly: localSubject(z.object({ value: z.string() })),
      collectorOnly: collectorOnlySubject(z.object({ value: z.string() })),
    });
    bus.registerNamespace(namespace);

    const attached = await attachUpstreamTelemetry(bus, 'machine-private', { transport: inner.transport });
    await bus.emit(namespace.subjects.localOnly, { value: 'local' });
    await bus.emit(namespace.subjects.collectorOnly, { value: 'collector' });

    expect(inner.sent).toHaveLength(0);

    await attached.shutdown();
  });

  it('propagates connect() failures without bus registration', async () => {
    const bus = createBusInstance();
    const inner = createTransport();
    vi.mocked(inner.transport.connect).mockRejectedValueOnce(new Error('connection refused'));

    await expect(attachUpstreamTelemetry(bus, 'machine-4', { transport: inner.transport })).rejects.toThrow(
      'connection refused',
    );

    expect(bus.getContext().transportRegistry.names()).not.toContain('upstream-telemetry');
  });

  it('disconnects the projected transport when observer registration throws after connect succeeds', async () => {
    const bus = createBusInstance();
    const inner = createTransport();
    vi.spyOn(bus, 'observeMessages').mockImplementationOnce(() => {
      throw new Error('observer registration failed');
    });

    await expect(attachUpstreamTelemetry(bus, 'machine-5', { transport: inner.transport })).rejects.toThrow(
      'observer registration failed',
    );

    expect(inner.transport.connect).toHaveBeenCalledTimes(1);
    expect(inner.transport.disconnect).toHaveBeenCalledTimes(1);
  });
});
