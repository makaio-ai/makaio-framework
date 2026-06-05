import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { TelemetryOtelSubjects, type SpanDraft } from '../contracts/index.js';
import { SpanEnricherPipeline } from '../enrichers/pipeline.js';
import { SpanEnricherRuleRegistry } from '../enrichers/registry.js';

const baseDraft: SpanDraft = {
  spanId: 'frame:wfx-1:frame-1',
  executionId: 'wfx-1',
  frameId: 'frame-1',
  namespace: 'workflow',
  subject: 'frame.started',
  name: 'Frame analyze',
  kind: 'internal',
  status: 'ok',
  startedAt: 1000,
  endedAt: 1500,
  attributes: { 'makaio.execution.id': 'wfx-1' },
  links: [],
  events: [],
};

describe('SpanEnricherPipeline', () => {
  it('merges matching declarative rule attributes', async () => {
    const registry = new SpanEnricherRuleRegistry();
    registry.register({
      id: 'factory-workflow',
      name: 'Factory workflow labels',
      enabled: true,
      priority: 100,
      condition: { field: 'namespace', operator: { $startsWith: 'workflow' } },
      action: { attributes: { 'factory.pipeline': 'ai-first-engineering' } },
    });

    const pipeline = new SpanEnricherPipeline({ bus: MakaioBus, registry });

    await expect(pipeline.enrich(baseDraft)).resolves.toMatchObject({
      attributes: {
        'makaio.execution.id': 'wfx-1',
        'factory.pipeline': 'ai-first-engineering',
      },
    });
  });

  it('skips optional bus enrichment when no handler exists', async () => {
    const pipeline = new SpanEnricherPipeline({
      bus: MakaioBus,
      registry: new SpanEnricherRuleRegistry(),
    });

    await expect(pipeline.enrich(baseDraft)).resolves.toEqual(baseDraft);
  });

  it('higher-priority rules win on conflicting attribute keys', async () => {
    const registry = new SpanEnricherRuleRegistry();
    registry.register({
      id: 'low-priority',
      name: 'Low priority',
      enabled: true,
      priority: 10,
      condition: { field: 'namespace', operator: { $startsWith: 'workflow' } },
      action: { attributes: { 'shared.key': 'low-wins' } },
    });
    registry.register({
      id: 'high-priority',
      name: 'High priority',
      enabled: true,
      priority: 100,
      condition: { field: 'namespace', operator: { $startsWith: 'workflow' } },
      action: { attributes: { 'shared.key': 'high-wins' } },
    });

    const pipeline = new SpanEnricherPipeline({ bus: MakaioBus, registry });
    const enriched = await pipeline.enrich(baseDraft);
    expect(enriched.attributes['shared.key']).toBe('high-wins');
  });

  it('merges optional bus enrichment response', async () => {
    const cleanup = MakaioBus.on(TelemetryOtelSubjects.enrichSpan, (ctx) => {
      ctx.setResult({ additionalAttributes: { 'github.repo': 'makaio-ai/makaio' } });
    });
    try {
      const pipeline = new SpanEnricherPipeline({
        bus: MakaioBus,
        registry: new SpanEnricherRuleRegistry(),
      });

      await expect(pipeline.enrich(baseDraft)).resolves.toMatchObject({
        attributes: {
          'github.repo': 'makaio-ai/makaio',
        },
      });
    } finally {
      cleanup();
    }
  });
});
