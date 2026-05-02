import { z } from 'zod';

/**
 * Schema for item.started event
 * Emitted when an item begins execution
 */
export const ItemStartedSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  itemType: z.string(),
  timestamp: z.number(),
});

/**
 * Schema for item.completed event
 * Emitted when an item completes
 */
export const ItemCompletedSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  itemType: z.string(),
  timestamp: z.number(),
});

// Export inferred types
export type ItemStarted = z.infer<typeof ItemStartedSchema>;
export type ItemCompleted = z.infer<typeof ItemCompletedSchema>;
