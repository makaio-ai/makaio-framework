/**
 * Content-free usage snapshots for interactive client sessions.
 *
 * These snapshots describe session-local model usage observed by a client
 * runtime. They are intentionally separate from `client.usage.*`, whose
 * contract represents account quota windows rather than consumed tokens or
 * monetary cost.
 * @packageDocumentation
 */

import { observability } from '@makaio/core';
import { z } from 'zod';
import { EpochMillisecondsSchema, NonEmptyStringSchema } from './primitives.js';

/** Provenance of a monetary amount reported in a client session snapshot. */
export const ClientSessionUsageCostProvenanceSchema = z.enum(['provider-reported', 'client-reported', 'estimated']);

/** Provenance of a monetary amount reported in a client session snapshot. */
export type ClientSessionUsageCostProvenance = z.infer<typeof ClientSessionUsageCostProvenanceSchema>;

const NonNegativeMeasurementSchema = z.number().finite().nonnegative();
const PercentageSchema = z.number().finite().min(0).max(100);

/**
 * Snapshot of usage measurements for one interactive client session.
 *
 * Field names encode gauge/counter semantics explicitly:
 * - `latestRequest*` is the most recent API-call usage.
 * - `currentContext*` is the current context-window gauge.
 * - `total*` is cumulative for the native client session.
 *
 * The contract contains no prompts, responses, transcripts, tool arguments,
 * filesystem paths, or open metadata bags.
 */
export const ClientSessionUsageSnapshotSchema = z
  .object({
    /** Stable client ID, for example `claude-code`. */
    clientId: observability.attribute(NonEmptyStringSchema, 'makaio.client.id'),
    /** Canonical account ID when the emitting runtime resolved one. */
    clientAccountId: observability.attribute(NonEmptyStringSchema, 'makaio.client.account_id').optional(),
    /** Framework session ID when already resolved. */
    sessionId: observability.attribute(NonEmptyStringSchema, 'makaio.session.id').optional(),
    /** Native session ID assigned by the client. */
    adapterSessionId: observability.attribute(NonEmptyStringSchema, 'makaio.adapter.session_id').optional(),
    /** Capture source, for example `statusline`. */
    source: observability.attribute(NonEmptyStringSchema, 'makaio.client.usage.source'),
    /** Epoch milliseconds when the snapshot was observed. */
    observedAt: observability.attribute(EpochMillisecondsSchema, 'event.observed_at'),
    /** Native client version when supplied by the client. */
    clientVersion: observability.attribute(NonEmptyStringSchema, 'makaio.client.version').optional(),
    /** Provider model identifier. */
    modelId: observability.attribute(NonEmptyStringSchema, 'llm.model').optional(),
    /** Provider model display name. */
    modelDisplayName: observability.attribute(NonEmptyStringSchema, 'llm.model.display_name').optional(),
    /** Provider model family. */
    modelFamily: observability.attribute(NonEmptyStringSchema, 'llm.model.family').optional(),
    /** Input tokens used by the most recent API request. */
    latestRequestInputTokens: observability
      .attribute(NonNegativeMeasurementSchema, 'llm.tokens.latest_request.input')
      .optional(),
    /** Output tokens used by the most recent API request. */
    latestRequestOutputTokens: observability
      .attribute(NonNegativeMeasurementSchema, 'llm.tokens.latest_request.output')
      .optional(),
    /** Cache-read input tokens used by the most recent API request. */
    latestRequestCacheReadTokens: observability
      .attribute(NonNegativeMeasurementSchema, 'llm.tokens.latest_request.cache_read')
      .optional(),
    /** Cache-write input tokens used by the most recent API request. */
    latestRequestCacheWriteTokens: observability
      .attribute(NonNegativeMeasurementSchema, 'llm.tokens.latest_request.cache_write')
      .optional(),
    /** Input-token gauge for the current context window. */
    currentContextInputTokens: observability
      .attribute(NonNegativeMeasurementSchema, 'llm.context.tokens.input')
      .optional(),
    /** Output-token gauge for the current context window. */
    currentContextOutputTokens: observability
      .attribute(NonNegativeMeasurementSchema, 'llm.context.tokens.output')
      .optional(),
    /** Maximum size of the current context window. */
    contextWindowSizeTokens: observability
      .attribute(NonNegativeMeasurementSchema, 'llm.context.window_size')
      .optional(),
    /** Used percentage of the current context window. */
    contextUsedPercentage: observability.attribute(PercentageSchema, 'llm.context.used_percentage').optional(),
    /** Remaining percentage of the current context window. */
    contextRemainingPercentage: observability
      .attribute(PercentageSchema, 'llm.context.remaining_percentage')
      .optional(),
    /** Whether the client reports that the large-context threshold was exceeded. */
    contextThresholdExceeded: observability.attribute(z.boolean(), 'llm.context.threshold_exceeded').optional(),
    /** Cumulative monetary cost for the native client session. */
    totalCost: observability.attribute(NonNegativeMeasurementSchema, 'llm.cost.total').optional(),
    /** Currency of `totalCost`. */
    costCurrency: observability.attribute(NonEmptyStringSchema, 'llm.cost.currency').optional(),
    /** Provenance of `totalCost`. */
    costProvenance: observability.attribute(ClientSessionUsageCostProvenanceSchema, 'llm.cost.provenance').optional(),
    /** Cumulative wall-clock duration for the native client session. */
    totalDurationMs: observability.attribute(NonNegativeMeasurementSchema, 'makaio.session.duration_ms').optional(),
    /** Cumulative provider API duration for the native client session. */
    totalApiDurationMs: observability.attribute(NonNegativeMeasurementSchema, 'llm.duration.total_api_ms').optional(),
    /** Cumulative lines added during the native client session. */
    totalLinesAdded: observability.attribute(NonNegativeMeasurementSchema, 'code.lines_added').optional(),
    /** Cumulative lines removed during the native client session. */
    totalLinesRemoved: observability.attribute(NonNegativeMeasurementSchema, 'code.lines_removed').optional(),
    /** Cumulative edit count during the native client session. */
    totalEdits: observability.attribute(NonNegativeMeasurementSchema, 'code.edits').optional(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const monetaryFields = ['totalCost', 'costCurrency', 'costProvenance'] as const;
    const presentCount = monetaryFields.filter((field) => snapshot[field] !== undefined).length;
    if (presentCount === 0 || presentCount === monetaryFields.length) return;

    for (const field of monetaryFields) {
      if (snapshot[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'totalCost, costCurrency, and costProvenance must be supplied together',
        });
      }
    }
  });

/** Snapshot of usage measurements for one interactive client session. */
export type ClientSessionUsageSnapshot = z.infer<typeof ClientSessionUsageSnapshotSchema>;
