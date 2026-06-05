/**
 * TypeScript types for the telemetry-otel extension public contract.
 *
 * Consumed by extension consumers that build span enrichers or integrate the
 * OTel exporter into their own services. For runtime validation shapes, see
 * `./schemas.ts`.
 * @packageDocumentation
 */

import type { JsonObject, Rule } from '@makaio/rules';
import type { SubjectTelemetryAttributeValue } from '@makaio/contracts';

/** OTel span kind narrowed to the subset produced by this extension. */
export type SpanDraftKind = 'internal' | 'client';

/** Terminal status set on a span before export. */
export type SpanDraftStatus = 'ok' | 'error' | 'unset';

/**
 * Serializable reference linking a span to a causally related span in another
 * trace.
 */
export interface SpanLinkDraft {
  /** Trace identifier of the linked span. */
  readonly traceId: string;
  /** Optional span identifier within the linked trace. */
  readonly spanId?: string;
  /** Scalar attributes annotating the relationship. */
  readonly attributes: Record<string, SubjectTelemetryAttributeValue>;
}

/**
 * Serializable timed event recorded during a span's lifetime.
 */
export interface SpanEventDraft {
  /** Human-readable event name. */
  readonly name: string;
  /** Wall-clock timestamp in Unix milliseconds. */
  readonly time: number;
  /** Scalar attributes attached to the event. */
  readonly attributes: Record<string, SubjectTelemetryAttributeValue>;
}

/**
 * Serializable, fully-resolved span data ready for OTel export.
 *
 * Produced by the telemetry service from aggregated subject-telemetry facts and
 * emitted on the bus for enrichment before being handed to the SDK exporter.
 */
export interface SpanDraft {
  /** Stable unique identifier for this span. */
  readonly spanId: string;
  /** Parent span identifier when this span is a child. */
  readonly parentSpanId?: string;
  /** Makaio execution identifier this span covers. */
  readonly executionId: string;
  /** Optional workflow frame identifier. */
  readonly frameId?: string;
  /** Optional session identifier. */
  readonly sessionId?: string;
  /** Bus namespace that originated the execution. */
  readonly namespace?: string;
  /** Bus subject that originated the execution. */
  readonly subject?: string;
  /** Human-readable span name shown in trace UIs. */
  readonly name: string;
  /** OTel span kind. */
  readonly kind: SpanDraftKind;
  /** Terminal status written before export. */
  readonly status: SpanDraftStatus;
  /** Span start time as Unix milliseconds. */
  readonly startedAt: number;
  /** Span end time as Unix milliseconds. */
  readonly endedAt: number;
  /** Scalar OTel attributes attached to the span. */
  readonly attributes: Record<string, SubjectTelemetryAttributeValue>;
  /** Causal links to spans in other traces. */
  readonly links: readonly SpanLinkDraft[];
  /** Timed events recorded during the span's lifetime. */
  readonly events: readonly SpanEventDraft[];
}

/**
 * Action payload for a span enricher rule.
 *
 * Additional OTel attributes merged into the span before export. The
 * {@link attributes} map holds serializable OTel attribute values restricted
 * to primitives and homogeneous arrays (enforced at runtime by the companion
 * Zod schema). The type extends {@link JsonObject} so it satisfies the
 * `Rule<TAction extends JsonObjectShape>` constraint.
 */
export interface SpanEnricherAction extends JsonObject {
  /**
   * OTel scalar attributes to merge into the target span.
   *
   * Runtime validation via {@link SpanEnricherActionSchema} enforces that
   * values are primitives or homogeneous primitive arrays.
   */
  readonly attributes: Record<string, SubjectTelemetryAttributeValue>;
}

/**
 * A single enricher rule evaluated against a {@link SpanDraft}.
 *
 * Uses the shared rules-engine contract so rules are fully serializable and
 * can be stored, edited, or imported without code changes.
 */
export type SpanEnricherRule = Rule<SpanEnricherAction>;

/**
 * Response returned by the `enrichSpan` bus request.
 *
 * Aggregates additional attributes contributed by all matching enricher rules.
 */
export interface EnrichSpanResponse {
  /** Scalar attributes to merge into the span before export. */
  readonly additionalAttributes: Record<string, SubjectTelemetryAttributeValue>;
}
