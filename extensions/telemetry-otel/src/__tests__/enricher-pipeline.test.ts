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

  it('resolves whole-value templates while preserving native attribute types', async () => {
    const registry = new SpanEnricherRuleRegistry();
    registry.register({
      id: 'gen-ai-usage',
      name: 'GenAI usage',
      enabled: true,
      priority: 100,
      condition: { field: 'spanId', operator: { $startsWith: 'llm:' } },
      action: {
        attributes: {
          'gen_ai.provider.name': '{{ attributes["llm.provider"] }}',
          'gen_ai.request.model': '{{ attributes["llm.model"] }}',
          'gen_ai.usage.input_tokens': '{{ attributes["llm.tokens.input"] }}',
          'gen_ai.usage.output_tokens': '{{ attributes["llm.tokens.output"] }}',
        },
      },
    });

    const pipeline = new SpanEnricherPipeline({ bus: MakaioBus, registry });
    const enriched = await pipeline.enrich({
      ...baseDraft,
      spanId: 'llm:wfx-1:sess-1:0',
      sessionId: 'sess-1',
      namespace: 'agent',
      subject: 'usage',
      attributes: {
        'llm.provider': 'openai',
        'llm.model': 'gpt-5.4',
        'llm.tokens.input': 12,
        'llm.tokens.output': 8,
      },
    });

    expect(enriched.attributes['gen_ai.provider.name']).toBe('openai');
    expect(enriched.attributes['gen_ai.request.model']).toBe('gpt-5.4');
    expect(enriched.attributes['gen_ai.usage.input_tokens']).toBe(12);
    expect(enriched.attributes['gen_ai.usage.output_tokens']).toBe(8);
  });

  it('omits whole-value templates that resolve to undefined', async () => {
    const registry = new SpanEnricherRuleRegistry();
    registry.register({
      id: 'optional-cost',
      name: 'Optional cost',
      enabled: true,
      priority: 100,
      condition: { field: 'spanId', operator: { $startsWith: 'llm:' } },
      action: {
        attributes: {
          'gen_ai.usage.cost': '{{ attributes["llm.cost.estimated"] }}',
        },
      },
    });

    const pipeline = new SpanEnricherPipeline({ bus: MakaioBus, registry });
    const enriched = await pipeline.enrich({
      ...baseDraft,
      spanId: 'llm:wfx-1:sess-1:0',
      attributes: {},
    });

    expect(enriched.attributes).not.toHaveProperty('gen_ai.usage.cost');
  });

  it('drops object-valued template results before OTel export', async () => {
    const registry = new SpanEnricherRuleRegistry();
    registry.register({
      id: 'object-value',
      name: 'Object value',
      enabled: true,
      priority: 100,
      condition: { field: 'namespace', operator: { $startsWith: 'workflow' } },
      action: {
        attributes: {
          'invalid.object': '{{ attributes }}',
        },
      },
    });

    const pipeline = new SpanEnricherPipeline({ bus: MakaioBus, registry });
    const enriched = await pipeline.enrich(baseDraft);

    expect(enriched.attributes).not.toHaveProperty('invalid.object');
  });

  it('drops mixed arrays and preserves homogeneous arrays after template resolution', async () => {
    const registry = new SpanEnricherRuleRegistry();
    registry.register({
      id: 'array-values',
      name: 'Array values',
      enabled: true,
      priority: 100,
      condition: { field: 'spanId', operator: { $startsWith: 'llm:' } },
      action: {
        attributes: {
          'valid.labels': '{{ attributes["llm.labels"] }}',
          'invalid.mixed': '{{ [attributes["llm.model"], attributes["llm.tokens.input"]] }}',
        },
      },
    });

    const pipeline = new SpanEnricherPipeline({ bus: MakaioBus, registry });
    const enriched = await pipeline.enrich({
      ...baseDraft,
      spanId: 'llm:wfx-1:sess-1:0',
      attributes: {
        'llm.labels': ['openai', 'chat'],
        'llm.model': 'gpt-5.4',
        'llm.tokens.input': 12,
      },
    });

    expect(enriched.attributes['valid.labels']).toEqual(['openai', 'chat']);
    expect(enriched.attributes).not.toHaveProperty('invalid.mixed');
  });

  it('lets optional bus enrichment win over declarative attributes', async () => {
    const registry = new SpanEnricherRuleRegistry();
    registry.register({
      id: 'declarative-shared',
      name: 'Declarative shared value',
      enabled: true,
      priority: 100,
      condition: { field: 'namespace', operator: { $startsWith: 'workflow' } },
      action: { attributes: { 'shared.key': 'declarative' } },
    });

    const cleanup = MakaioBus.on(TelemetryOtelSubjects.enrichSpan, (ctx) => {
      ctx.setResult({ additionalAttributes: { 'shared.key': 'bus' } });
    });
    try {
      const pipeline = new SpanEnricherPipeline({ bus: MakaioBus, registry });
      const enriched = await pipeline.enrich(baseDraft);

      expect(enriched.attributes['shared.key']).toBe('bus');
    } finally {
      cleanup();
    }
  });
});
