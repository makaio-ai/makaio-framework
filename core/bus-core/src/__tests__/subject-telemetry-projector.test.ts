import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusNamespace, observability } from '@makaio/core';
import { createBusInstance } from '../bus.js';
import { createSubjectTelemetryProjectorRegistry, projectSubjectTelemetryFacts } from '../observability/index.js';

describe('projectSubjectTelemetryFacts', () => {
  it('emits trace-only facts for unannotated schemas', () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('demo', {
      changed: z.object({ secret: z.string() }),
    });
    bus.registerNamespace(namespace);

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'demo',
        subject: 'changed',
        payload: { secret: 'raw' },
        messageId: 'msg-1',
      },
      direction: 'local',
      observedAt: 1000,
      namespaceRegistry: bus.getContext().namespaceRegistry,
    });

    expect(fact).toMatchObject({
      factId: 'msg-1:local',
      namespace: 'demo',
      subject: 'changed',
      messageType: 'event',
      direction: 'local',
      messageId: 'msg-1',
      attributes: {},
    });
  });

  it('projects traceAll scalar fields while honoring hidden field metadata', () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('session', {
      list: {
        request: observability.schema(
          z.object({
            status: z.enum(['active', 'closed', 'all']).optional(),
            limit: z.number().int().min(1).optional(),
            offset: observability.hidden(z.number().int().min(0).optional()),
          }),
          { traceAll: true },
        ),
        response: z.object({ sessions: z.array(z.object({ id: z.string() })) }),
      },
    });
    bus.registerNamespace(namespace);

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'request',
        namespace: 'session',
        subject: 'list',
        payload: { status: 'active', limit: 20, offset: 40 },
        messageId: 'msg-2',
        correlationId: 'corr-2',
      },
      direction: 'local',
      observedAt: 1001,
      namespaceRegistry: bus.getContext().namespaceRegistry,
    });

    expect(fact.attributes).toEqual({ status: 'active', limit: 20 });
  });

  it('drops non-finite numeric attributes from schema projection', () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('metrics', {
      sampled: observability.schema(
        z.object({
          valid: z.number(),
          notANumber: z.number(),
          positiveInfinity: z.number(),
          negativeInfinity: z.number(),
        }),
        { traceAll: true },
      ),
    });
    bus.registerNamespace(namespace);

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'metrics',
        subject: 'sampled',
        payload: {
          valid: 42,
          notANumber: Number.NaN,
          positiveInfinity: Number.POSITIVE_INFINITY,
          negativeInfinity: Number.NEGATIVE_INFINITY,
        },
        messageId: 'msg-finite-schema',
      },
      direction: 'local',
      observedAt: 1001,
      namespaceRegistry: bus.getContext().namespaceRegistry,
    });

    expect(fact.attributes).toEqual({ valid: 42 });
  });

  it('projects explicitly annotated attribute fields without traceAll', () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('session', {
      opened: z.object({
        sessionId: observability.attribute(z.string(), 'id'),
        prompt: z.string(),
      }),
    });
    bus.registerNamespace(namespace);

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'session',
        subject: 'opened',
        payload: { sessionId: 'sess-1', prompt: 'raw prompt' },
        messageId: 'msg-attr',
      },
      direction: 'local',
      observedAt: 1002,
      namespaceRegistry: bus.getContext().namespaceRegistry,
    });

    expect(fact.attributes).toEqual({ id: 'sess-1' });
  });

  it('projects explicit count fields without exposing collection contents', () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('queue', {
      flushed: z.object({
        ids: observability.count(z.array(z.string()), 'idCount'),
      }),
    });
    bus.registerNamespace(namespace);

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'queue',
        subject: 'flushed',
        payload: { ids: ['one', 'two', 'three'] },
        messageId: 'msg-count',
      },
      direction: 'local',
      observedAt: 1003,
      namespaceRegistry: bus.getContext().namespaceRegistry,
    });

    expect(fact.attributes).toEqual({ idCount: 3 });
  });

  it('lets a namespace-owned sidecar projector provide sanitized attributes', () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('workflow', {
      started: z.object({
        executionId: z.string(),
        payload: z.record(z.string(), z.unknown()),
      }),
    });
    bus.registerNamespace(namespace);

    const registry = createSubjectTelemetryProjectorRegistry();
    registry.register({
      namespace: 'workflow',
      subject: 'started',
      project: ({ payload }) => ({
        executionId:
          payload !== null && typeof payload === 'object' && 'executionId' in payload
            ? String(payload.executionId)
            : undefined,
      }),
    });

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'workflow',
        subject: 'started',
        payload: { executionId: 'exec-1', payload: { raw: 'not-visible' } },
        messageId: 'msg-4',
      },
      direction: 'local',
      observedAt: 1004,
      namespaceRegistry: bus.getContext().namespaceRegistry,
      projectorRegistry: registry,
    });

    expect(fact.attributes).toEqual({ executionId: 'exec-1' });
  });

  it('drops non-attribute sidecar projector values at runtime', () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('workflow', {
      completed: z.object({ executionId: z.string() }),
    });
    bus.registerNamespace(namespace);

    const registry = createSubjectTelemetryProjectorRegistry();
    registry.register({
      namespace: 'workflow',
      subject: 'completed',
      project: () => ({
        ok: true,
        unsafeObject: { raw: 'payload' } as never,
        unsafeNestedArray: [['raw']] as never,
      }),
    });

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'workflow',
        subject: 'completed',
        payload: { executionId: 'exec-2' },
        messageId: 'msg-5',
      },
      direction: 'local',
      observedAt: 1005,
      namespaceRegistry: bus.getContext().namespaceRegistry,
      projectorRegistry: registry,
    });

    expect(fact.attributes).toEqual({ ok: true });
  });

  it('drops non-finite numeric attributes from sidecar projection', () => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('workflow', {
      measured: z.object({ executionId: z.string() }),
    });
    bus.registerNamespace(namespace);

    const registry = createSubjectTelemetryProjectorRegistry();
    registry.register({
      namespace: 'workflow',
      subject: 'measured',
      project: () => ({
        ok: true,
        count: 3,
        notANumber: Number.NaN,
        positiveInfinity: Number.POSITIVE_INFINITY,
        negativeInfinity: Number.NEGATIVE_INFINITY,
        mixedArray: [1, Number.NaN] as never,
        mixedPrimitiveArray: [1, null] as never,
        finiteArray: [1, 2],
        nullArray: [null, null],
      }),
    });

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'workflow',
        subject: 'measured',
        payload: { executionId: 'exec-3' },
        messageId: 'msg-finite-sidecar',
      },
      direction: 'local',
      observedAt: 1006,
      namespaceRegistry: bus.getContext().namespaceRegistry,
      projectorRegistry: registry,
    });

    expect(fact.attributes).toEqual({ ok: true, count: 3, finiteArray: [1, 2], nullArray: [null, null] });
  });
});
