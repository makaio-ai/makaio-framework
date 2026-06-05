/**
 * Bus namespace definition for the telemetry-otel extension.
 *
 * All three subjects follow the standard extension namespace pattern:
 * - `registerEnricherRule` — fire-and-forget event registering a new rule.
 * - `unregisterEnricherRule` — fire-and-forget event removing a rule by id.
 * - `enrichSpan` — request-response RPC called before each span is exported.
 * @packageDocumentation
 */

import { createExtensionNamespace } from '@makaio/bus-core';
import type { SchemaRecord } from '@makaio/core';
import { z } from 'zod';
import { EnrichSpanResponseSchema, SpanDraftSchema, SpanEnricherRuleSchema } from './schemas.js';

/**
 * Inline schema record powering the telemetry-otel bus namespace.
 *
 * Exported so downstream packages can reference the raw schema shapes without
 * importing the full namespace object.
 */
export const TelemetryOtelSchemas = {
  /** Register a span enricher rule. */
  registerEnricherRule: SpanEnricherRuleSchema,
  /** Unregister a previously registered enricher rule by id. */
  unregisterEnricherRule: z.object({ ruleId: z.string().min(1) }).strict(),
  /** Request enrichment for a fully-resolved span draft. */
  enrichSpan: {
    request: SpanDraftSchema,
    response: EnrichSpanResponseSchema,
  },
} satisfies SchemaRecord;

/**
 * Bus namespace definition for the `telemetry-otel` extension.
 *
 * Registered by `ExtensionCoordinator` during activation. Consumers that only
 * need the subject references should import {@link TelemetryOtelSubjects}
 * directly.
 */
export const TelemetryOtelNamespace = createExtensionNamespace('telemetry-otel', {
  schemas: TelemetryOtelSchemas,
});

/**
 * Type-safe subject accessors for the `telemetry-otel` extension namespace.
 * @example
 * ```ts
 * await bus.emit(TelemetryOtelSubjects.registerEnricherRule, rule);
 * ```
 */
export const TelemetryOtelSubjects = TelemetryOtelNamespace.subjects;
