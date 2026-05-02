import { z } from 'zod';

/**
 * Schema for thread.started event
 * Emitted when a new thread is successfully started.
 *
 * Note: agentId is required for bus filtering to work correctly.
 * The filteredBus.on() filters events by agentId.
 */
export const ThreadStartedSchema = z.object({
  agentId: z.string(),
  threadId: z.string(),
  timestamp: z.number(),
});

/**
 * Schema for thread.completed event
 * Emitted when a thread is archived or completed.
 *
 * Note: agentId is required for bus filtering to work correctly.
 */
export const ThreadCompletedSchema = z.object({
  agentId: z.string(),
  threadId: z.string(),
  timestamp: z.number(),
});

// Export inferred types
export type ThreadStarted = z.infer<typeof ThreadStartedSchema>;
export type ThreadCompleted = z.infer<typeof ThreadCompletedSchema>;
