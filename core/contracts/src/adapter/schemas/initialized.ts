import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';

/**
 * Adapter initialization completed.
 *
 * Subject: `adapter.initialized`
 * Type: Event (fire-and-forget)
 * Emitted when: Adapter finishes initialization and is ready to handle requests.
 *
 * This event signals that all adapter handlers are registered and the adapter
 * is ready to process incoming messages. Useful for coordinating startup timing
 * and preventing race conditions when transports accept connections before
 * adapters are ready.
 * @example
 * ```typescript
 * bus.on(AdapterSubjects.initialized, (context) => {
 *   console.debug(`Adapter ${context.payload.adapterName} ready with capabilities:`, context.payload.capabilities);
 * });
 * ```
 */
export const InitializedSchema = BaseAdapterEventSchema.extend({
  /** Canonical runtime machine identity hosting this adapter instance. */
  machineId: z.string(),
  /** Exact ownership-authority incarnation hosting this live adapter instance. */
  ownerInstanceId: z.string(),
  /** Adapter capabilities (e.g., ['streaming', 'tools', 'vision']). */
  capabilities: z.array(z.string()),
  /** Native tools built into the adapter (e.g., ['shell_command', 'apply_patch']). */
  nativeTools: z.array(z.string()).optional(),
});

export type Initialized = z.infer<typeof InitializedSchema>;
