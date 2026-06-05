/**
 * Zod schemas for the telemetry-otel extension public contract.
 *
 * All schemas use `.strict()` to reject unrecognised fields at runtime and
 * align with the repo-wide strictness policy. Import types from `./types.ts`
 * when only type-level access is required.
 * @packageDocumentation
 */

import { z } from 'zod';
import { RuleSchema } from '@makaio/rules';
import { SubjectTelemetryAttributeValueSchema } from '@makaio/contracts';

/** Schema for the OTel span kind values produced by this extension. */
export const SpanDraftKindSchema = z.enum(['internal', 'client']);

/** Schema for the terminal status set on a span before export. */
export const SpanDraftStatusSchema = z.enum(['ok', 'error', 'unset']);

/**
 * Schema for a causal link to a span in another trace.
 */
export const SpanLinkDraftSchema = z
  .object({
    traceId: z.string().min(1),
    spanId: z.string().min(1).optional(),
    attributes: z.record(z.string(), SubjectTelemetryAttributeValueSchema),
  })
  .strict();

/**
 * Schema for a timed event recorded during a span's lifetime.
 */
export const SpanEventDraftSchema = z
  .object({
    name: z.string().min(1),
    time: z.number().int().nonnegative(),
    attributes: z.record(z.string(), SubjectTelemetryAttributeValueSchema),
  })
  .strict();

/**
 * Schema for a fully-resolved span draft ready for enrichment and OTel export.
 */
export const SpanDraftSchema = z
  .object({
    spanId: z.string().min(1),
    parentSpanId: z.string().min(1).optional(),
    executionId: z.string().min(1),
    frameId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    subject: z.string().min(1).optional(),
    name: z.string().min(1),
    kind: SpanDraftKindSchema,
    status: SpanDraftStatusSchema,
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
    attributes: z.record(z.string(), SubjectTelemetryAttributeValueSchema),
    links: z.array(SpanLinkDraftSchema),
    events: z.array(SpanEventDraftSchema),
  })
  .strict();

/**
 * Schema for the action payload of a span enricher rule.
 *
 * Attributes in this record are merged into the span before OTel export.
 */
export const SpanEnricherActionSchema = z
  .object({
    attributes: z.record(z.string(), SubjectTelemetryAttributeValueSchema),
  })
  .strict();

/**
 * Schema for a span enricher rule evaluated against a {@link SpanDraftSchema}.
 *
 * Built with {@link RuleSchema} so the full condition and priority contract is
 * inherited from the shared rules engine.
 */
export const SpanEnricherRuleSchema = RuleSchema(SpanEnricherActionSchema);

/**
 * Schema for the response returned by the `enrichSpan` bus request.
 */
export const EnrichSpanResponseSchema = z
  .object({
    additionalAttributes: z.record(z.string(), SubjectTelemetryAttributeValueSchema),
  })
  .strict();
