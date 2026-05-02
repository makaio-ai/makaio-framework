import { z } from 'zod';
import type { TimeoutConfig } from '@makaio/utils';

/**
 * Zod schema for timeout configuration validation.
 *
 * Each field represents a distinct phase in the adapter lifecycle
 * with different performance characteristics and failure modes.
 * All values are in milliseconds.
 *
 * Type is defined in `\@makaio/utils`, this schema provides runtime validation.
 */
export const TimeoutConfigSchema: z.ZodType<TimeoutConfig> = z.object({
  initialization: z
    .number()
    .optional()
    .describe('Time allowed for adapter/session initialization (cold starts, auth). Defaults to 30000ms.'),

  acknowledgement: z
    .number()
    .optional()
    .describe('Time allowed for acknowledgement that a message was received. Defaults to 30000ms.'),

  completion: z
    .number()
    .optional()
    .describe('Time allowed for completion of complex reasoning operations. Defaults to 60000ms.'),

  toolApproval: z
    .number()
    .optional()
    .describe('Time allowed for tool approval responses (user is waiting). Defaults to 5000ms.'),

  eventWait: z.number().optional().describe('Default time for once() calls waiting for events. Defaults to 10000ms.'),
});
