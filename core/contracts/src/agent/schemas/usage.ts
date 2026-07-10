import { z } from 'zod';
import { observability } from '@makaio/core';
import { BaseAgentEventSchema } from './base-event.js';

/** Provenance of an optional monetary amount on `agent.usage`. */
export const UsageCostProvenanceSchema = z.enum(['provider-reported', 'client-reported', 'estimated']);

/** Provenance of an optional monetary amount on `agent.usage`. */
export type UsageCostProvenance = z.infer<typeof UsageCostProvenanceSchema>;

/**
 * Truthful measurement granularity of one `agent.usage` event.
 *
 * - `provider-call` — one concrete provider API request. The finest
 *   granularity; events can be summed freely.
 * - `turn-aggregate` — one completed assistant message or prompt turn. May
 *   cover several internal model calls the upstream SDK does not expose
 *   individually.
 * - `query-aggregate` — the terminal result of one query, potentially
 *   covering multiple model turns (agentic tool loops).
 * - `latest-request-gauge` — a lossy observed statusline gauge for the
 *   latest request; deduplicated, never a running total.
 */
export const UsageGranularitySchema = z.enum([
  'provider-call',
  'turn-aggregate',
  'query-aggregate',
  'latest-request-gauge',
]);

/** Truthful measurement granularity of one `agent.usage` event. */
export type UsageGranularity = z.infer<typeof UsageGranularitySchema>;

/**
 * Additive token usage metrics.
 *
 * Subject: `agent.usage`
 * Type: Event (fire-and-forget)
 * Emitted when: Usage metrics are available from an AI provider or client
 *
 * Each event is an additive usage measurement whose coverage is declared by
 * the mandatory `granularity` field: depending on the upstream signal, the
 * numbers may cover one provider API call, a completed turn, a terminal
 * query result, or a lossy latest-request gauge. See
 * `docs/architecture/adapters/usage-and-provenance.md` for the per-adapter
 * measurement matrix. For adapter-level cumulative totals, see
 * `adapter.session.usage`.
 */
export const UsageSchema = BaseAgentEventSchema.extend({
  /**
   * Truthful measurement granularity of this event. Orthogonal to
   * `llmCallId`: granularity declares what the numbers cover, while
   * `llmCallId` declares whether the concrete provider request is nameable.
   */
  granularity: observability.attribute(UsageGranularitySchema, 'llm.usage.granularity'),
  /** Runtime-generated identifier for one concrete provider API request. */
  llmCallId: observability.attribute(z.string(), 'makaio.llm_call.id').optional(),
  /** Workflow execution that caused the provider request, when known. */
  executionId: observability.attribute(z.string(), 'makaio.execution.id').optional(),
  /** Workflow frame/station that caused the provider request, when known. */
  frameId: observability.attribute(z.string(), 'makaio.frame.id').optional(),
  provider: observability.attribute(z.string(), 'llm.provider'),
  model: observability.attribute(z.string(), 'llm.model'),
  inputTokens: observability.attribute(z.number(), 'llm.tokens.input'),
  inputCachedTokens: observability.attribute(z.number(), 'llm.tokens.cached_input'),
  cacheWriteTokens: observability.attribute(z.number(), 'llm.tokens.cache_write').optional(),
  outputTokens: observability.attribute(z.number(), 'llm.tokens.output'),
  reasoningTokens: observability.attribute(z.number(), 'llm.tokens.reasoning'),
  totalTokens: observability.attribute(z.number(), 'llm.tokens.total'),
  costUnits: observability.attribute(z.number(), 'llm.cost.units'),
  costUnitType: observability.attribute(z.enum(['requests', 'tokens']), 'llm.cost.unit_type'),
  cost: observability.attribute(z.number(), 'llm.cost.amount').optional(),
  currency: observability.attribute(z.string(), 'llm.cost.currency').optional(),
  costProvenance: observability.attribute(UsageCostProvenanceSchema, 'llm.cost.provenance').optional(),
  audioInputTokens: observability.attribute(z.number(), 'llm.tokens.audio_input').optional(),
  audioOutputTokens: observability.attribute(z.number(), 'llm.tokens.audio_output').optional(),
  /** Billing tier (e.g., 'standard', 'PROVISIONED_THROUGHPUT') */
  serviceTier: observability.attribute(z.string(), 'llm.service_tier').optional(),
  /** API call latency in milliseconds */
  duration: observability.attribute(z.number(), 'llm.duration_ms').optional(),
  /** Model context window size in tokens */
  contextWindow: observability.attribute(z.number(), 'llm.context.window_size').optional(),
  quota: z
    .object({
      type: z.string(),
      limit: z.number(),
      used: z.number(),
      overage: z.number(),
      resetDate: z.string().optional(),
    })
    .optional(),
});

export type Usage = z.infer<typeof UsageSchema>;
