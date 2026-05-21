import { z } from 'zod';

/**
 * Base adapter event fields.
 * All adapter events extend this to ensure consistent adapter identification.
 */
export const BaseAdapterEventSchema = z.object({
  /** Adapter instance identifier (required) */
  adapterId: z.string(),

  /** Adapter type name (e.g., 'claude-code', 'copilot') (required) */
  adapterName: z.string(),
});

export type BaseAdapterEvent = z.infer<typeof BaseAdapterEventSchema>;
