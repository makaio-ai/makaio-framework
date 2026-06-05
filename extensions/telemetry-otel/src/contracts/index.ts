/**
 * Public contract surface for the telemetry-otel extension.
 *
 * Re-exports all types, schemas, namespace definitions, subjects, and public
 * registration helpers that downstream packages need when integrating with the
 * OTel exporter extension.
 * @packageDocumentation
 */

export type {
  EnrichSpanResponse,
  SpanDraft,
  SpanDraftKind,
  SpanDraftStatus,
  SpanEnricherAction,
  SpanEnricherRule,
  SpanEventDraft,
  SpanLinkDraft,
} from './types.js';
export {
  EnrichSpanResponseSchema,
  SpanDraftKindSchema,
  SpanDraftSchema,
  SpanDraftStatusSchema,
  SpanEnricherActionSchema,
  SpanEnricherRuleSchema,
  SpanEventDraftSchema,
  SpanLinkDraftSchema,
} from './schemas.js';
export { TelemetryOtelNamespace, TelemetryOtelSchemas, TelemetryOtelSubjects } from './namespace.js';
export { registerSpanEnricherRule } from './register.js';
