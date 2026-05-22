import { z } from 'zod';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import { MessageRoutingSchema } from '@makaio/contracts';
import { messageRouting } from './schema.js';

/**
 * Message routing storage namespace.
 *
 * Tracks delivery status of messages to agents in multi-agent sessions.
 * Enables querying completion status for turn coordination.
 */
export const MessageRoutingNamespace = createStorageNamespaceDefinition('messageRouting', {
  schemas: {
    /**
     * Record routing status for a message to an agent.
     *
     * Subject: `storage:messageRouting.record`
     * Type: Request (RPC)
     */
    record: {
      request: MessageRoutingSchema,
      response: z.object({ success: z.boolean() }),
    },

    /**
     * Get routing status for a message.
     *
     * Subject: `storage:messageRouting.getByMessage`
     * Type: Request (RPC)
     */
    getByMessage: {
      request: z.object({ messageId: z.string() }),
      response: z.object({
        routing: z.array(MessageRoutingSchema),
      }),
    },

    /**
     * Get all completed routings for a message.
     * Used to check if all target agents have responded.
     *
     * Subject: `storage:messageRouting.getCompleted`
     * Type: Request (RPC)
     */
    getCompleted: {
      request: z.object({ messageId: z.string() }),
      response: z.object({
        agentIds: z.array(z.string()),
      }),
    },

    /**
     * Check if all target agents have completed for a message.
     *
     * Subject: `storage:messageRouting.isComplete`
     * Type: Request (RPC)
     */
    isComplete: {
      request: z.object({
        messageId: z.string(),
        targetAgentIds: z.array(z.string()),
      }),
      response: z.object({
        complete: z.boolean(),
        pending: z.array(z.string()),
      }),
    },
  },
  extensions: {
    drizzle: {
      messageRouting,
    },
  },
});

/**
 * Typed subjects for message routing storage operations.
 */
export const MessageRoutingSubjects = MessageRoutingNamespace.subjects;
