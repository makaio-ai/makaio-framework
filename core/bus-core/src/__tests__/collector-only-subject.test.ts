import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { SubjectTelemetryNamespace, SubjectTelemetrySubjects, type SubjectTelemetryFact } from '@makaio/contracts';
import { collectorOnlySubject, createBusInstance, type BusMessage, type BusTransportRegistry } from '../index.js';
import { createBidirectionalTransportPair } from './helpers/transport-fixtures.js';

function makeFact(overrides: Partial<SubjectTelemetryFact> = {}): SubjectTelemetryFact {
  return {
    factId: 'fact-1',
    observedAt: 1000,
    namespace: 'session',
    subject: 'list',
    messageType: 'request',
    direction: 'outbound',
    messageId: 'msg-1',
    attributes: {},
    ...overrides,
  };
}

describe('collectorOnlySubject()', () => {
  it('marks event schemas as collector-only', () => {
    const schema = z.object({ id: z.string() });
    const collectorSchema = collectorOnlySubject(schema);

    expect(collectorSchema.__collectorOnly).toBe(true);
    expect(collectorSchema.schema).toBe(schema);
  });

  it('delivers inbound telemetry facts locally without relaying to peer transports', async () => {
    const collectorBus = createBusInstance();
    const peerBus = createBusInstance();
    const sourceToCollector = createBidirectionalTransportPair({ label: 'collector-source' });
    const collectorToPeer = createBidirectionalTransportPair({ label: 'collector-peer' });
    collectorBus.registerNamespace(SubjectTelemetryNamespace);
    peerBus.registerNamespace(SubjectTelemetryNamespace);

    collectorBus
      .getContext()
      .transportRegistry.registerTransport('from-source' as keyof BusTransportRegistry, sourceToCollector.sideB);
    collectorBus
      .getContext()
      .transportRegistry.registerTransport('to-peer' as keyof BusTransportRegistry, collectorToPeer.sideA);
    peerBus
      .getContext()
      .transportRegistry.registerTransport('from-collector' as keyof BusTransportRegistry, collectorToPeer.sideB);

    const received: SubjectTelemetryFact[] = [];
    const peerReceived: SubjectTelemetryFact[] = [];
    collectorBus.on(SubjectTelemetrySubjects.fact, ({ payload }) => {
      received.push(payload);
    });
    peerBus.on(SubjectTelemetrySubjects.fact, ({ payload }) => {
      peerReceived.push(payload);
    });
    const fact = makeFact();

    await sourceToCollector.sideA.send({
      type: 'event',
      namespace: 'subject-telemetry',
      subject: 'fact',
      payload: fact,
      messageId: 'telemetry-inbound-1',
    });

    await vi.waitFor(() => expect(received).toEqual([fact]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(peerReceived).toHaveLength(0);
  });

  it('keeps local emits on collector-only subjects off transports', async () => {
    const bus = createBusInstance();
    const peerBus = createBusInstance();
    const sentMessages: BusMessage[] = [];
    const pair = createBidirectionalTransportPair({
      label: 'collector-local',
      spy: (message) => {
        sentMessages.push(message);
      },
    });
    const { subjects } = bus.registerNamespace(
      createBusNamespace('collectorOnlyTest', {
        event: collectorOnlySubject(z.object({ value: z.string() })),
      }),
    );
    peerBus.registerNamespace(
      createBusNamespace('collectorOnlyTest', {
        event: collectorOnlySubject(z.object({ value: z.string() })),
      }),
    );
    bus.getContext().transportRegistry.registerTransport('local-out' as keyof BusTransportRegistry, pair.sideA);
    peerBus.getContext().transportRegistry.registerTransport('local-in' as keyof BusTransportRegistry, pair.sideB);
    const peerReceived: Array<{ value: string }> = [];
    peerBus.on(subjects.event, ({ payload }) => {
      peerReceived.push(payload);
    });

    await bus.emit(subjects.event, { value: 'local' });

    expect(sentMessages).toHaveLength(0);
    expect(peerReceived).toHaveLength(0);
  });
});
