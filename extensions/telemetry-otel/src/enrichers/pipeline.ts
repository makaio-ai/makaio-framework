/**
 * Enrichment pipeline that combines declarative rule-based enrichment with
 * optional bus-driven enrichment for span data.
 *
 * The pipeline evaluates registered {@link SpanEnricherRule} instances and
 * merges their action attributes into the span. It then issues an optional
 * bus request so that runtime services can contribute additional attributes
 * without coupling to the registry.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { SubjectTelemetryAttributeValue } from '@makaio/contracts';
import { resolveTemplatesInObject } from '@makaio/expression';
import type { SpanDraft } from '../contracts/index.js';
import { TelemetryOtelSubjects } from '../contracts/index.js';
import type { SpanEnricherRuleRegistry } from './registry.js';

/**
 * Options for constructing a {@link SpanEnricherPipeline}.
 */
export interface SpanEnricherPipelineOptions {
  /** Bus instance used for optional bus-driven enrichment. */
  readonly bus: IMakaioBus;
  /** Registry of declarative enricher rules to apply before bus enrichment. */
  readonly registry: SpanEnricherRuleRegistry;
}

/**
 * Build the expression evaluation context from a span draft.
 *
 * All top-level draft fields and the full `attributes` map are exposed as
 * top-level keys so rule attribute templates can reference both, e.g.
 * `{{ attributes["llm.model"] }}` or `{{ namespace }}`.
 * @param draft - Span draft providing context for template evaluation.
 * @returns Plain object suitable for expression evaluation.
 */
function createEnricherContext(draft: SpanDraft): Record<string, unknown> {
  return {
    spanId: draft.spanId,
    parentSpanId: draft.parentSpanId,
    executionId: draft.executionId,
    frameId: draft.frameId,
    sessionId: draft.sessionId,
    namespace: draft.namespace,
    subject: draft.subject,
    name: draft.name,
    kind: draft.kind,
    status: draft.status,
    startedAt: draft.startedAt,
    endedAt: draft.endedAt,
    attributes: draft.attributes,
  };
}

/**
 * Determine whether a runtime value qualifies as a scalar OTel attribute.
 *
 * Numeric values must be finite because OTel backends cannot faithfully
 * represent `NaN` or `±Infinity`.
 * @param value - Value to test.
 * @returns `true` if `value` is a `string`, finite `number`, `boolean`, or `null`.
 */
function isScalarAttributeValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Type guard that confirms a resolved value is a valid OTel attribute scalar
 * or homogeneous array of scalars.
 *
 * Object-valued results from template evaluation are rejected here so they
 * cannot reach the OTel SDK, which only accepts primitive scalars and
 * homogeneous arrays of primitives. Arrays must be homogeneous: every element
 * must share the same type as the first element (treating `null` as its own
 * type).
 * @param value - Value to test.
 * @returns `true` when the value is safe to use as an OTel attribute.
 */
function isTelemetryAttributeValue(value: unknown): value is SubjectTelemetryAttributeValue {
  if (isScalarAttributeValue(value)) return true;
  if (!Array.isArray(value) || !value.every(isScalarAttributeValue)) return false;
  if (value.length <= 1) return true;
  const firstType = value[0] === null ? 'null' : typeof value[0];
  return value.every((item) => (item === null ? 'null' : typeof item) === firstType);
}

/**
 * Resolve template expressions in rule action attributes against the span
 * draft context.
 *
 * Entries whose whole-value template resolves to `undefined` are omitted.
 * Entries that resolve to an object or a mixed-type array are dropped because
 * they are not valid OTel attribute values.
 * @param attributes - Rule action attribute map, may contain `{{ }}` templates.
 * @param draft - Span draft used as expression evaluation context.
 * @returns New attribute map with all templates resolved to valid scalars.
 */
function resolveRuleAttributes(
  attributes: Record<string, SubjectTelemetryAttributeValue>,
  draft: SpanDraft,
): Record<string, SubjectTelemetryAttributeValue> {
  const resolved = resolveTemplatesInObject(attributes as Record<string, unknown>, createEnricherContext(draft), {
    omitUndefinedProperties: true,
  });
  const output: Record<string, SubjectTelemetryAttributeValue> = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (isTelemetryAttributeValue(value)) {
      output[key] = value;
    }
  }
  return output;
}

/**
 * Two-phase span enrichment pipeline.
 *
 * **Phase 1 — Declarative rules:** All matching rules from the
 * {@link SpanEnricherRuleRegistry} are evaluated against the draft, and their
 * `action.attributes` are merged in descending priority order.
 *
 * **Phase 2 — Optional bus enrichment:** A `requestOptional` call is issued on
 * {@link TelemetryOtelSubjects.enrichSpan}. When a handler is registered, its
 * `additionalAttributes` are merged after the declarative attributes. When no
 * handler is registered the phase is skipped silently. Any other error
 * propagates to the caller.
 *
 * The final merge order guarantees that bus-provided attributes win over
 * declarative ones, which in turn win over the span's original attributes.
 */
export class SpanEnricherPipeline {
  private readonly bus: IMakaioBus;
  private readonly registry: SpanEnricherRuleRegistry;

  /**
   * @param options - Pipeline construction options
   */
  public constructor(options: SpanEnricherPipelineOptions) {
    this.bus = options.bus;
    this.registry = options.registry;
  }

  /**
   * Enrich a span draft by applying declarative rules and an optional bus
   * handler in sequence.
   *
   * The returned draft is a new object — the original is never mutated.
   * @param draft - Fully-resolved span draft to enrich
   * @returns Enriched span draft with merged attributes
   */
  public async enrich(draft: SpanDraft): Promise<SpanDraft> {
    // Phase 1: collect attributes from all matching declarative rules.
    const matchingRules = this.registry.evaluate(draft);
    const declarativeAttributes: Record<string, SubjectTelemetryAttributeValue> = {};
    for (const rule of [...matchingRules].reverse()) {
      Object.assign(declarativeAttributes, resolveRuleAttributes(rule.action.attributes, draft));
    }

    // Phase 2: optional bus-driven enrichment.
    // Spread into a plain object and explicitly copy the nested readonly arrays
    // into mutable arrays so the value is compatible with the Zod-inferred
    // request payload type (which uses mutable arrays).
    const busResult = await this.bus.requestOptional(TelemetryOtelSubjects.enrichSpan, {
      ...draft,
      links: [...draft.links],
      events: [...draft.events],
    });
    const busAttributes = busResult.handled ? busResult.data.additionalAttributes : {};

    return {
      ...draft,
      attributes: {
        ...draft.attributes,
        ...declarativeAttributes,
        ...busAttributes,
      },
    };
  }
}
