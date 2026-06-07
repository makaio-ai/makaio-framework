/**
 * Langfuse span export filters.
 * @packageDocumentation
 */

import type { Attributes } from '@opentelemetry/api';
import { isDefaultExportSpan, type ShouldExportSpan } from '@langfuse/otel';
import type { TelemetryLangfuseConfig } from './config.js';

/**
 * Returns `true` if any attribute key starts with the given prefix.
 * @param attributes - The span attributes to inspect.
 * @param prefix - The key prefix to search for.
 * @returns Whether any attribute key starts with `prefix`.
 */
function hasAttributePrefix(attributes: Attributes, prefix: string): boolean {
  return Object.keys(attributes).some((key) => key.startsWith(prefix));
}

/**
 * Returns `true` if the span belongs to the workflow ancestry that Langfuse
 * needs to render exported LLM/tool observations under their real parents.
 * @param attributes - The span attributes to inspect.
 * @returns Whether the span is a Makaio execution root or frame span.
 */
function isMakaioWorkflowAncestrySpan(attributes: Attributes): boolean {
  return attributes['makaio.execution.id'] !== undefined || attributes['makaio.frame.id'] !== undefined;
}

/**
 * Returns `true` if the span represents a tool invocation.
 *
 * The `gen_ai.operation.name === 'execute_tool'` branch is intentionally
 * omitted: any span that would match it also carries `gen_ai.*` attributes
 * and is already admitted by the `hasAttributePrefix(attributes, 'gen_ai.')`
 * check in the enclosing `llm-only` filter.
 * @param attributes - The span attributes to inspect.
 * @returns Whether the span is a tool span.
 */
function isMakaioToolSpan(attributes: Attributes): boolean {
  return attributes['tool.call_id'] !== undefined;
}

/**
 * Create the Langfuse `shouldExportSpan` predicate for a configured export scope.
 *
 * - `'full-trace'`: every span is exported without filtering.
 * - `'llm-only'` (default): only Langfuse-native spans, spans carrying `gen_ai.*`
 *   attributes, Makaio workflow ancestry spans (needed to preserve parent-child
 *   trace structure), and tool spans are exported.
 * @param exportScope - The configured export scope.
 * @returns A predicate that determines whether a span should be exported to Langfuse.
 */
export function createLangfuseShouldExportSpan(exportScope: TelemetryLangfuseConfig['exportScope']): ShouldExportSpan {
  if (exportScope === 'full-trace') {
    return () => true;
  }

  return ({ otelSpan }) => {
    const { attributes } = otelSpan;
    return (
      isDefaultExportSpan(otelSpan) ||
      hasAttributePrefix(attributes, 'gen_ai.') ||
      isMakaioWorkflowAncestrySpan(attributes) ||
      isMakaioToolSpan(attributes)
    );
  };
}
