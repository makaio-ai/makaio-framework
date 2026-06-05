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
      Object.assign(declarativeAttributes, rule.action.attributes);
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
