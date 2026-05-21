import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';

/**
 * Account-wide quota and billing metrics.
 *
 * Subject: `adapter.quota`
 * Type: Event (fire-and-forget)
 * Emitted when: Quota information is available from the provider (e.g., GitHub Copilot)
 *
 * This tracks account-wide usage limits across all sessions in the billing period.
 * Only applicable to providers with quota systems (currently GitHub Copilot).
 */
export const QuotaSchema = BaseAdapterEventSchema.extend({
  provider: z.string(),
  quotaType: z.string(),
  limit: z.number(),
  used: z.number(),
  overage: z.number(),
  resetDate: z.string(),
});

export type Quota = z.infer<typeof QuotaSchema>;
