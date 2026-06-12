import { index, primaryKey } from 'drizzle-orm/sqlite-core';
import { index as pgIndex, primaryKey as pgPrimaryKey } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';
import { messageIdColumnPair } from '../messages/schema.variants.js';

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
 *
 * The `messages` table stays a hand-written twin (it carries a Postgres-only
 * `content_tsv` generated column), so the FK target comes from the twin's
 * `messageIdColumnPair` thunk rather than a `columnPair` on a dual table.
 */
export const messageRoutingDual = defineDualTable(
  'message_routing',
  (c) => ({
    /**
     * Foreign key to the message being routed.
     * Cascade deletes when message is removed.
     */
    messageId: c.text('message_id').notNull().references(messageIdColumnPair, {
      onDelete: 'cascade',
    }),

    /**
     * Target agent ID.
     */
    agentId: c.text('agent_id').notNull(),

    /**
     * Routing status.
     * - 'sent': Message dispatched to agent's queue
     * - 'acknowledged': Agent received and started processing
     * - 'completed': Agent finished responding
     */
    status: c.textEnum('status', { enum: ['sent', 'acknowledged', 'completed'] as const }).notNull(),

    /**
     * Status change timestamp (Unix ms).
     */
    timestamp: c.epochMs('timestamp').notNull(),

    /**
     * Error message if routing failed.
     * NULL for successful routing.
     */
    error: c.text('error'),
  }),
  {
    sqlite: (t) => [
      /**
       * Composite primary key for message-agent-status.
       * Allows tracking multiple status transitions per message-agent pair.
       */
      primaryKey({ columns: [t.messageId, t.agentId, t.status] }),

      /**
       * Index for agent-scoped queries.
       * Used for "what messages are pending for this agent?"
       */
      index('idx_routing_agent').on(t.agentId, t.timestamp),
    ],
    postgres: (t) => [
      pgPrimaryKey({ columns: [t.messageId, t.agentId, t.status] }),
      pgIndex('idx_routing_agent').on(t.agentId, t.timestamp),
    ],
  },
);

/** SQLite face of the `message_routing` table (canonical schema). */
export const messageRouting = messageRoutingDual.sqlite;

/**
 * Type for inserting a new routing entry.
 */
export type InsertMessageRouting = typeof messageRouting.$inferInsert;

/**
 * Type for a selected routing entry row.
 */
export type SelectMessageRouting = typeof messageRouting.$inferSelect;
