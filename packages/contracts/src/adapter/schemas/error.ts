import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';
import { ErrorCategorySchema } from '../../shared/index.js';

/**
 * Error during execution.
 *
 * Subject: `adapter.error`
 * Type: Event (fire-and-forget)
 * Emitted during: promptText() execution on failure
 */
export const ErrorSchema = BaseAdapterEventSchema.extend({
  error: z.string(),
  sessionId: z.string().optional(),
  /** Optional error category for structured error handling and fallback logic */
  errorCategory: ErrorCategorySchema.optional(),
});

export type AdapterError = z.infer<typeof ErrorSchema>;
