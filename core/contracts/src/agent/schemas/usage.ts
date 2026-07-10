import { z } from 'zod';
import { observability } from '@makaio/core';
import { BaseAgentEventSchema } from './base-event.js';

/** Provenance of an optional monetary amount on `agent.usage`. */
export const UsageCostProvenanceSchema = z.enum(['provider-reported', 'client-reported', 'estimated']);

/** Provenance of an optional monetary amount on `agent.usage`. */
export type UsageCostProvenance = z.infer<typeof UsageCostProvenanceSchema>;

/**
 * Per-call token usage metrics.
 *
 * Subject: `agent.usage`
 * Type: Event (fire-and-forget)
 * Emitted when: Usage metrics are available from an AI provider API call
 *
 * This event contains delta metrics for a single API call.
 * For adapter-level cumulative totals, see `adapter.session.usage`.
 */
export const UsageSchema = BaseAgentEventSchema.extend({
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
