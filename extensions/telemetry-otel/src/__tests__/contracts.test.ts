import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseExtensionDescriptor } from '@makaio/contracts';
import { TelemetryOtelConfigSchema } from '../config.js';
import { SpanDraftSchema, SpanEnricherRuleSchema, TelemetryOtelSubjects } from '../contracts/index.js';

describe('telemetry-otel contracts', () => {
  it('exposes extension subjects', () => {
    expect(TelemetryOtelSubjects.registerEnricherRule.subject).toBe('registerEnricherRule');
    expect(TelemetryOtelSubjects.unregisterEnricherRule.subject).toBe('unregisterEnricherRule');
    expect(TelemetryOtelSubjects.enrichSpan.subject).toBe('enrichSpan');
  });

  it('points descriptor discovery at the index server entrypoint', () => {
    const descriptor = parseExtensionDescriptor(
      JSON.parse(readFileSync(new URL('../../descriptor.json', import.meta.url), 'utf-8')),
    );

    expect(descriptor.name).toBe('telemetry-otel');
    expect(descriptor.entrypoints?.server).toBe('index');
    expect(descriptor.execution).toBe('embedded');
  });

  it('parses config defaults', () => {
    expect(TelemetryOtelConfigSchema.parse({})).toMatchObject({
      enabled: true,
      serviceName: 'makaio',
      maxOpenExecutions: 1000,
      orphanTimeoutMs: 30000,
    });
    expect(TelemetryOtelConfigSchema.parse({}).otlpEndpoint).toBeUndefined();
  });

  it('parses a span draft with scalar attributes', () => {
    const draft = SpanDraftSchema.parse({
      spanId: 'span-1',
      executionId: 'wfx-1',
      name: 'Workflow wfx-1',
      kind: 'internal',
      status: 'ok',
      startedAt: 1000,
      endedAt: 1500,
      attributes: {
        'makaio.execution.id': 'wfx-1',
        'llm.tokens.input': 12,
      },
      links: [],
      events: [],
    });

    expect(draft.attributes['makaio.execution.id']).toBe('wfx-1');
  });

  it('parses rule actions using the real rules engine shape', () => {
    const rule = SpanEnricherRuleSchema.parse({
      id: 'factory-workflow',
      name: 'Factory workflow labels',
      enabled: true,
      priority: 100,
      condition: { field: 'namespace', operator: { $startsWith: 'workflow' } },
      action: {
        attributes: {
          'factory.pipeline': 'ai-first-engineering',
        },
      },
    });

    expect(rule.action.attributes['factory.pipeline']).toBe('ai-first-engineering');
  });
});
