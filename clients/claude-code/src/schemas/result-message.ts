import { z } from 'zod';
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

export const SDKResultSuccessMessageSchema = SDKResultBaseMessageSchema.extend({
  subtype: z.literal('success'),
  result: z.string(),
});

export const SDKResultErrorMessageSchema = SDKResultBaseMessageSchema.extend({
  subtype: z.enum(['error_max_turns', 'error_during_execution']),
});

export const SDKResultMessageSchema = z.discriminatedUnion('subtype', [
  SDKResultSuccessMessageSchema,
  SDKResultErrorMessageSchema,
]);

export type SDKResultMessage = z.infer<typeof SDKResultMessageSchema>;
