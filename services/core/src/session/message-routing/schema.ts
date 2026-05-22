import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { messages } from '../messages/schema.js';

/**
 * Message routing table schema.
 *
 * Tracks delivery status of messages to agents in multi-agent sessions.
 * Each row represents a message-agent pair with status progression.
 *
 * Status progression: sent -\> acknowledged -\> completed
 *
 * Design rationale:
 * - Composite primary key allows multiple status entries per message-agent pair
 * - Enables tracking of delivery lifecycle for each target agent
 * - Supports querying "which agents have completed for this message?"
 */
export const messageRouting = sqliteTable(
  'message_routing',
  {
    /**
     * Foreign key to the message being routed.
     * Cascade deletes when message is removed.
     */
    messageId: text('message_id')
      .notNull()
      .references(() => messages.messageId, { onDelete: 'cascade' }),

    /**
     * Target agent ID.
     */
    agentId: text('agent_id').notNull(),

    /**
     * Routing status.
     * - 'sent': Message dispatched to agent's queue
     * - 'acknowledged': Agent received and started processing
     * - 'completed': Agent finished responding
     */
    status: text('status', { enum: ['sent', 'acknowledged', 'completed'] }).notNull(),

    /**
     * Status change timestamp (Unix ms).
     */
    timestamp: integer('timestamp').notNull(),

    /**
     * Error message if routing failed.
     * NULL for successful routing.
     */
    error: text('error'),
  },
  (table) => [
    /**
     * Composite primary key for message-agent-status.
     * Allows tracking multiple status transitions per message-agent pair.
     */
    primaryKey({ columns: [table.messageId, table.agentId, table.status] }),

    /**
     * Index for agent-scoped queries.
     * Used for "what messages are pending for this agent?"
     */
    index('idx_routing_agent').on(table.agentId, table.timestamp),
  ],
);

/**
 * Type for inserting a new routing entry.
 */
export type InsertMessageRouting = typeof messageRouting.$inferInsert;

/**
 * Type for a selected routing entry row.
 */
export type SelectMessageRouting = typeof messageRouting.$inferSelect;
