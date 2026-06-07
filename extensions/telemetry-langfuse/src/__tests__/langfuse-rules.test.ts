import { beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { SpanDraft } from '@makaio/extension-telemetry-otel/contracts';
import { SpanEnricherPipeline, SpanEnricherRuleRegistry } from '@makaio/extension-telemetry-otel/testing';
import { createLangfuseEnricherRules } from '../enrichers/langfuse-rules.js';

const llmDraft: SpanDraft = {
  spanId: 'llm:wfx-1:sess-1:0',
  parentSpanId: 'frame:wfx-1:frame-1',
  executionId: 'wfx-1',
  frameId: 'frame-1',
  sessionId: 'sess-1',
  namespace: 'agent',
  subject: 'usage',
  name: 'LLM call gpt-5.4',
  kind: 'client',
  status: 'ok',
  startedAt: 1000,
  endedAt: 1500,
  attributes: {
    'llm.provider': 'openai',
    'llm.model': 'gpt-5.4',
    'llm.tokens.input': 12,
    'llm.tokens.output': 8,
    'llm.tokens.total': 20,
    'llm.cost.estimated': 0.002,
    'llm.cost.currency': 'USD',
    'llm.duration_ms': 500,
  },
  links: [],
  events: [],
};

describe('Langfuse enricher rules', () => {
  let pipeline: SpanEnricherPipeline;

  beforeEach(() => {
    const registry = new SpanEnricherRuleRegistry();
    for (const rule of createLangfuseEnricherRules()) registry.register(rule);
    pipeline = new SpanEnricherPipeline({ bus: MakaioBus, registry });
  });

  it('maps Makaio LLM attributes to GenAI semantic convention attributes', async () => {
    const enriched = await pipeline.enrich(llmDraft);

    expect(enriched.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-5.4',
      'gen_ai.response.model': 'gpt-5.4',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 8,
      'gen_ai.usage.total_tokens': 20,
      'langfuse.session.id': 'sess-1',
      'makaio.session.id': 'sess-1',
      'makaio.telemetry.span_id': 'llm:wfx-1:sess-1:0',
    });
  });

  it('preserves native numeric types for token counts and cost', async () => {
    const enriched = await pipeline.enrich(llmDraft);

    expect(typeof enriched.attributes['gen_ai.usage.input_tokens']).toBe('number');
    expect(typeof enriched.attributes['gen_ai.usage.output_tokens']).toBe('number');
    expect(typeof enriched.attributes['gen_ai.usage.total_tokens']).toBe('number');
    expect(typeof enriched.attributes['makaio.llm.cost.estimated']).toBe('number');
  });

  it('omits optional cost attributes when they are absent from the source span', async () => {
    const enriched = await pipeline.enrich({
      ...llmDraft,
      attributes: {
        'llm.provider': 'anthropic',
        'llm.model': 'claude-opus-4',
        'llm.tokens.input': 5,
        'llm.tokens.output': 3,
        'llm.tokens.total': 8,
      },
    });

    expect(enriched.attributes).not.toHaveProperty('makaio.llm.cost.estimated');
    expect(enriched.attributes).not.toHaveProperty('makaio.llm.cost.currency');
    expect(enriched.attributes).not.toHaveProperty('makaio.llm.duration_ms');
  });

  it('does not stamp GenAI generation attributes on workflow frame spans', async () => {
    const enriched = await pipeline.enrich({
      ...llmDraft,
      spanId: 'frame:wfx-1:frame-1',
      sessionId: undefined,
      namespace: 'workflow',
      subject: 'frame',
      name: 'Frame analyze',
      attributes: { 'makaio.frame.id': 'frame-1' },
    });

    expect(enriched.attributes).not.toHaveProperty('gen_ai.operation.name');
    expect(enriched.attributes).not.toHaveProperty('langfuse.session.id');
  });

  it('stamps Langfuse trace name on execution root spans', async () => {
    const enriched = await pipeline.enrich({
      ...llmDraft,
      spanId: 'execution:wfx-1',
      sessionId: 'sess-1',
      namespace: 'workflow',
      subject: 'execution.started',
      name: 'Analyze PR',
      attributes: {},
    });

    expect(enriched.attributes['langfuse.trace.name']).toBe('Analyze PR');
    expect(enriched.attributes['makaio.telemetry.span_id']).toBe('execution:wfx-1');
    expect(enriched.attributes['makaio.execution.id']).toBe('wfx-1');
  });

  it('stamps tool spans with execute_tool operation name', async () => {
    const enriched = await pipeline.enrich({
      ...llmDraft,
      spanId: 'tool:wfx-1:sess-1:bash',
      sessionId: 'sess-1',
      namespace: 'agent',
      subject: 'tool.call',
      name: 'bash',
      attributes: {},
    });

    expect(enriched.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(enriched.attributes['makaio.telemetry.span_id']).toBe('tool:wfx-1:sess-1:bash');
    // makaio.session.id is stamped by the session rule, not the tool rule,
    // for any span that carries a sessionId.
    expect(enriched.attributes['makaio.session.id']).toBe('sess-1');
  });
});
