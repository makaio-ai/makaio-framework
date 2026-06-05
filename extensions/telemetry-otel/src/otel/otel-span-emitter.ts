/**
 * OTel SDK span emitter.
 *
 * Adapts fully-resolved {@link SpanDraft} objects to real OTel SDK spans,
 * preserving parent-child hierarchy, attributes, links, events, and terminal
 * status. Spans are emitted synchronously in array order so that parent spans
 * are always started before their children.
 * @packageDocumentation
 */

import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type SpanAttributes,
  type Tracer,
} from '@opentelemetry/api';
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { SubjectTelemetryAttributeValue } from '@makaio/contracts';
import type { SpanDraft, SpanLinkDraft } from '../contracts/index.js';
import type { ISpanEmitter } from './types.js';

/** Options for constructing an {@link OtelSpanEmitter}. */
export interface OtelSpanEmitterOptions {
  /** OTel tracer used to create spans. */
  readonly tracer: Tracer;
  /**
   * Provider that owns the {@link BatchSpanProcessor}.
   *
   * When provided, {@link OtelSpanEmitter.shutdown} will call
   * `provider.shutdown()` to flush the processor queue before the process
   * exits. Omit in tests where no real processor is running.
   */
  readonly provider?: BasicTracerProvider;
}

/**
 * Converts a {@link SubjectTelemetryAttributeValue} to an OTel-safe attribute
 * value, dropping standalone `null` values that OTel does not accept.
 * @param value - Attribute value from the span draft
 * @returns An OTel-compatible attribute value, or `undefined` when the value
 *   cannot be represented.
 */
function toOtelAttributeValue(value: SubjectTelemetryAttributeValue): SpanAttributes[string] {
  if (value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    // Homogeneous null arrays have no OTel representation — drop them.
    // Empty arrays are valid OTel attributes and pass through as-is.
    if (value[0] === null) {
      return undefined;
    }
    // Widen to the union accepted by OTel (Array<null | undefined | string>, etc.).
    return value as SpanAttributes[string];
  }
  return value;
}

/**
 * Converts a {@link SpanDraft}'s `attributes` map to an OTel
 * {@link SpanAttributes} record, omitting any values that cannot be
 * represented in OTel.
 * @param attributes - Raw attributes from the span draft
 * @returns OTel-compatible attributes record
 */
function toOtelAttributes(attributes: Record<string, SubjectTelemetryAttributeValue>): SpanAttributes {
  const result: SpanAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const otelValue = toOtelAttributeValue(value);
    if (otelValue !== undefined) {
      result[key] = otelValue;
    }
  }
  return result;
}

/**
 * Minimal span context shape required to construct an OTel link from a
 * {@link SpanLinkDraft}, containing only the fields the SDK actually reads.
 */
interface OtelLinkContext {
  /** Trace identifier of the linked span. */
  readonly traceId: string;
  /** Span identifier within the linked trace. */
  readonly spanId: string;
  /** OTel trace flags (1 = sampled). */
  readonly traceFlags: number;
}

/**
 * Resolved OTel link shape produced by {@link toOtelLink}.
 *
 * Structurally compatible with the `Link` interface from `@opentelemetry/api`
 * without importing it, keeping the dependency surface minimal.
 */
interface OtelLink {
  /** Span context of the linked span. */
  readonly context: OtelLinkContext;
  /** Scalar attributes annotating the relationship. */
  readonly attributes: SpanAttributes;
}

/**
 * Maps a {@link SpanLinkDraft} to an OTel span link ready for
 * {@link SpanOptions.links}.
 * @param link - Serializable link from the span draft
 * @returns OTel link with a minimal valid {@link SpanContext}
 */
function toOtelLink(link: SpanLinkDraft): OtelLink {
  return {
    context: {
      traceId: link.traceId,
      spanId: link.spanId ?? '0000000000000000',
      traceFlags: 1,
    },
    attributes: toOtelAttributes(link.attributes),
  };
}

/**
 * Translates {@link SpanDraftKind} to an OTel {@link SpanKind}.
 * @param kind - Span kind from the span draft
 * @returns Corresponding OTel span kind constant
 */
function toOtelSpanKind(kind: SpanDraft['kind']): SpanKind {
  return kind === 'client' ? SpanKind.CLIENT : SpanKind.INTERNAL;
}

/**
 * OTel SDK implementation of {@link ISpanEmitter}.
 *
 * Translates each {@link SpanDraft} to a real OTel span using the provided
 * tracer. Parent-child relationships are reconstructed from
 * {@link SpanDraft.parentSpanId} references, which must refer to a span that
 * appears earlier in the same batch.
 */
export class OtelSpanEmitter implements ISpanEmitter {
  private readonly tracer: Tracer;
  private readonly provider: BasicTracerProvider | undefined;

  /**
   * @param options - Emitter construction options
   */
  public constructor(options: OtelSpanEmitterOptions) {
    this.tracer = options.tracer;
    this.provider = options.provider;
  }

  /**
   * Export a batch of span drafts as completed OTel spans.
   *
   * Spans are processed in array order. Each span's parent context is resolved
   * from the already-emitted spans in this batch. Spans with an unresolvable
   * `parentSpanId` (e.g. referencing a span outside the batch) are emitted as
   * root spans.
   * @param drafts - Fully-resolved span drafts to export in order
   * @returns A promise that resolves when all drafts have been emitted
   */
  public async emit(drafts: readonly SpanDraft[]): Promise<void> {
    const emitted = new Map<string, Span>();

    for (const draft of drafts) {
      const parent = draft.parentSpanId === undefined ? undefined : emitted.get(draft.parentSpanId);
      const ctx = parent === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, parent);

      const span = this.tracer.startSpan(
        draft.name,
        {
          kind: toOtelSpanKind(draft.kind),
          startTime: draft.startedAt,
          attributes: toOtelAttributes(draft.attributes),
          links: draft.links.map(toOtelLink),
        },
        ctx,
      );

      for (const event of draft.events) {
        span.addEvent(event.name, toOtelAttributes(event.attributes), event.time);
      }

      if (draft.status === 'error') {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else if (draft.status === 'ok') {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end(draft.endedAt);
      emitted.set(draft.spanId, span);
    }
  }

  /**
   * Flush the {@link BatchSpanProcessor} queue and shut down the provider.
   *
   * No-op when no provider was supplied at construction time.
   * @returns A promise that resolves when the provider has shut down.
   */
  public async shutdown(): Promise<void> {
    await this.provider?.shutdown();
  }
}
