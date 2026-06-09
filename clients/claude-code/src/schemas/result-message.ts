import { z } from 'zod';
import { JsonValueSchema } from '@makaio/contracts';
import { BaseSdkMessageSchema } from './base.js';
import { ModelUsageSchema, NonNullableUsageSchema, PermissionDenialSchema } from './result-types.js';

const SDKResultBaseMessageSchema = BaseSdkMessageSchema.extend({
  type: z.literal('result'),
  duration_ms: z.number(),
  duration_api_ms: z.number(),
  is_error: z.boolean(),
  num_turns: z.number(),
  total_cost_usd: z.number(),
  usage: NonNullableUsageSchema,
  modelUsage: z.record(z.string(), ModelUsageSchema),
  permission_denials: z.array(PermissionDenialSchema),
});

/**
 * Successful Claude Code result message.
 *
 * `structured_output` is present when JSON-schema output mode is active. It is
 * modeled as any JSON value because user schemas can validly produce objects,
 * arrays, primitives, or null.
 */
export const SDKResultSuccessMessageSchema = SDKResultBaseMessageSchema.extend({
  subtype: z.literal('success'),
  result: z.string(),
  structured_output: JsonValueSchema.optional(),
});

/**
 * Failed Claude Code result message.
 *
 * Error subtypes mirror the SDK terminal failure modes, including structured
 * output retry exhaustion. `errors` carries SDK-provided detail strings while
 * `stop_reason` preserves the upstream stop classification when present.
 */
export const SDKResultErrorMessageSchema = SDKResultBaseMessageSchema.extend({
  subtype: z.enum([
    'error_during_execution',
    'error_max_turns',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
  ]),
  errors: z.array(z.string()),
  stop_reason: z.string().nullable(),
});

export const SDKResultMessageSchema = z.discriminatedUnion('subtype', [
  SDKResultSuccessMessageSchema,
  SDKResultErrorMessageSchema,
]);

export type SDKResultMessage = z.infer<typeof SDKResultMessageSchema>;
