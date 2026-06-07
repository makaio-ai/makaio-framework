/**
 * Langfuse and GenAI span enricher rules.
 *
 * Declarative rules that map Makaio internal `llm.*` span attributes to
 * OpenTelemetry GenAI semantic conventions (`gen_ai.*`) and Langfuse-specific
 * attributes (`langfuse.*`). Registered via {@link SpanEnricherRuleRegistry}
 * at extension activation time.
 * @packageDocumentation
 */

import type { SpanEnricherRule } from '@makaio/extension-telemetry-otel/contracts';

/** Priority for all telemetry-langfuse enricher rules. */
const LANGFUSE_RULE_PRIORITY = 200;

/**
 * Build all declarative enricher rules contributed by the telemetry-langfuse
 * extension.
 *
 * Rules are evaluated by the {@link SpanEnricherPipeline} against each
 * {@link SpanDraft} before export. Attribute values may contain `{{ }}`
 * template expressions resolved against the span draft context.
 * @returns Ordered list of span enricher rules for this extension.
 */
export function createLangfuseEnricherRules(): readonly SpanEnricherRule[] {
  return [
    {
      id: 'telemetry-langfuse.gen-ai-llm',
      name: 'Langfuse GenAI LLM mapping',
      enabled: true,
      priority: LANGFUSE_RULE_PRIORITY,
      condition: { field: 'spanId', operator: { $startsWith: 'llm:' } },
      action: {
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': '{{ attributes["llm.provider"] }}',
          'gen_ai.request.model': '{{ attributes["llm.model"] }}',
          'gen_ai.response.model': '{{ attributes["llm.model"] }}',
          'gen_ai.usage.input_tokens': '{{ attributes["llm.tokens.input"] }}',
          'gen_ai.usage.output_tokens': '{{ attributes["llm.tokens.output"] }}',
          'gen_ai.usage.total_tokens': '{{ attributes["llm.tokens.total"] }}',
          'makaio.llm.cost.estimated': '{{ attributes["llm.cost.estimated"] }}',
          'makaio.llm.cost.currency': '{{ attributes["llm.cost.currency"] }}',
          'makaio.llm.duration_ms': '{{ attributes["llm.duration_ms"] }}',
          'makaio.telemetry.span_id': '{{ spanId }}',
          'makaio.execution.id': '{{ executionId }}',
        },
      },
    },
    {
      id: 'telemetry-langfuse.session',
      name: 'Langfuse session correlation',
      enabled: true,
      priority: LANGFUSE_RULE_PRIORITY,
      condition: { field: 'sessionId', operator: { $exists: true } },
      action: {
        attributes: {
          'langfuse.session.id': '{{ sessionId }}',
          'makaio.session.id': '{{ sessionId }}',
        },
      },
    },
    {
      id: 'telemetry-langfuse.trace-root',
      name: 'Langfuse trace root labels',
      enabled: true,
      priority: LANGFUSE_RULE_PRIORITY,
      condition: { field: 'spanId', operator: { $startsWith: 'execution:' } },
      action: {
        attributes: {
          'langfuse.trace.name': '{{ name }}',
          'makaio.telemetry.span_id': '{{ spanId }}',
          'makaio.execution.id': '{{ executionId }}',
        },
      },
    },
    {
      id: 'telemetry-langfuse.tool',
      name: 'Langfuse tool call labels',
      enabled: true,
      priority: LANGFUSE_RULE_PRIORITY,
      condition: { field: 'spanId', operator: { $startsWith: 'tool:' } },
      action: {
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'makaio.telemetry.span_id': '{{ spanId }}',
          'makaio.execution.id': '{{ executionId }}',
        },
      },
    },
  ];
}
