import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';

/**
 * Adapter or SDK log message.
 *
 * Subject: `adapter.log`
 * Type: Event (fire-and-forget)
 * Emitted when: Adapter or SDK emits log messages (authentication, connection status, etc.)
 * @example
 * ```typescript
 * bus.emit(AdapterSubjects.log, {
 *   message: 'Authenticated successfully',
 *   level: 'info',
 *   timestamp: Date.now(),
 *   adapterId: 'adapter-123',
 *   adapterName: 'claude-code'
 * });
 * ```
 */
export const LogSchema = BaseAdapterEventSchema.extend({
  message: z.string(),
  timestamp: z.number(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
});

export type Log = z.infer<typeof LogSchema>;
