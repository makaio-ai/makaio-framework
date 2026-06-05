import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusNamespace, observability } from '@makaio/core';
import type { BusMessage, BusTransport } from '../types/transports.js';
import { createBusInstance } from '../bus.js';
import { createProjectedTelemetryTransport, createSubjectTelemetryProjectorRegistry } from '../observability/index.js';

function createInnerTransport(): { transport: BusTransport; sent: BusMessage[] } {
  const sent: BusMessage[] = [];
  return {
    sent,
    transport: {
      name: 'inner',
      send: vi.fn(async (message: BusMessage) => {
        sent.push(message);
        return true;
      }) as BusTransport['send'],
      onReceive: vi.fn(() => () => undefined),
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      isReady: () => true,
    },
  };
}

describe('createProjectedTelemetryTransport', () => {
  it('sends only subject-telemetry.fact events to the inner transport', async () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('session', {
      list: {
        request: observability.schema(
          z.object({
            status: z.string(),
            offset: observability.hidden(z.number()),
          }),
          { traceAll: true },
        ),
        response: z.object({ ok: z.boolean() }),
      },
    });
    bus.registerNamespace(namespace);

    const inner = createInnerTransport();
    const transport = createProjectedTelemetryTransport({
      name: 'upstream-telemetry',
      inner: inner.transport,
      namespaceRegistry: bus.getContext().namespaceRegistry,
      machineId: 'machine-1',
    });

    await expect(
      transport.send({
        type: 'request',
        namespace: 'session',
        subject: 'list',
        payload: { status: 'active', offset: 10 },
        messageId: 'msg-1',
        correlationId: 'corr-1',
      }),
    ).rejects.toThrow('Projected telemetry transport cannot satisfy request responses');

    expect(inner.sent).toHaveLength(1);
    expect(inner.sent[0]).toMatchObject({
      type: 'event',
      namespace: 'subject-telemetry',
      subject: 'fact',
      payload: {
        namespace: 'session',
        subject: 'list',
        attributes: { status: 'active' },
      },
    });
  });

  it('drops inbound application messages from upstream', async () => {
    const inner = createInnerTransport();
    let received = false;
    const transport = createProjectedTelemetryTransport({
      name: 'upstream-telemetry',
      inner: inner.transport,
      namespaceRegistry: createBusInstance().getContext().namespaceRegistry,
    });

    transport.onReceive(async () => {
      received = true;
    });

    const inboundHandler = vi.mocked(inner.transport.onReceive).mock.calls[0]?.[0];
    await inboundHandler?.({
      type: 'event',
      namespace: 'remote',
      subject: 'raw',
      payload: { unsafe: true },
      messageId: 'remote-1',
    });

    expect(received).toBe(false);
  });

  it('returns an empty array for broadcast messages so broadcast.ts can safely iterate', async () => {
    const inner = createInnerTransport();
    const transport = createProjectedTelemetryTransport({
      name: 'upstream-telemetry',
      inner: inner.transport,
      namespaceRegistry: createBusInstance().getContext().namespaceRegistry,
    });

    const result = await transport.send({
      type: 'broadcast',
      namespace: 'session',
      subject: 'list',
      payload: {},
      correlationId: 'corr-1',
      messageId: 'msg-1',
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('silently drops non-projectable messages without forwarding to inner', async () => {
    const inner = createInnerTransport();
    const transport = createProjectedTelemetryTransport({
      name: 'upstream-telemetry',
      inner: inner.transport,
      namespaceRegistry: createBusInstance().getContext().namespaceRegistry,
    });

    const result = await transport.send({
      type: 'response',
      correlationId: 'corr-1',
      result: { ok: true },
    });

    expect(result).toBe(true);
    expect(inner.sent).toHaveLength(0);
  });

  it('does not advertise local subscriptions to the telemetry collector', async () => {
    const inner = createInnerTransport();
    const transport = createProjectedTelemetryTransport({
      name: 'upstream-telemetry',
      inner: inner.transport,
      namespaceRegistry: createBusInstance().getContext().namespaceRegistry,
    });

    await transport.subscribe('session.list', undefined, [0]);
    await transport.unsubscribe('session.list');

    expect(inner.transport.subscribe).not.toHaveBeenCalled();
    expect(inner.transport.unsubscribe).not.toHaveBeenCalled();
  });

  it('uses sidecar projector from projectorRegistry when provided', async () => {
    const bus = createBusInstance();
    const projectorRegistry = createSubjectTelemetryProjectorRegistry();
    projectorRegistry.register({
      namespace: 'session',
      subject: 'list',
      project: () => ({ sidecarAttr: 'injected' }),
    });

    const inner = createInnerTransport();
    const transport = createProjectedTelemetryTransport({
      name: 'upstream-telemetry',
      inner: inner.transport,
      namespaceRegistry: bus.getContext().namespaceRegistry,
      projectorRegistry,
    });

    await transport.send({
      type: 'event',
      namespace: 'session',
      subject: 'list',
      payload: { status: 'active' },
      messageId: 'msg-1',
    });

    expect(inner.sent).toHaveLength(1);
    expect(inner.sent[0]).toMatchObject({
      type: 'event',
      namespace: 'subject-telemetry',
      subject: 'fact',
      payload: {
        namespace: 'session',
        subject: 'list',
        attributes: { sidecarAttr: 'injected' },
      },
    });
  });
});
