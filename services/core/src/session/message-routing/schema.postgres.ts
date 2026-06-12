/**
 * Postgres twin schema for the message routing table.
 *
 * Congruent twin of `schema.ts` — identical SQL names, column types mapped to
 * Postgres equivalents via the shared column bundles. Row types are exclusively
 * owned by the canonical `schema.ts`; this file exports table objects only.
 */
import { pgTable, text, index, primaryKey } from 'drizzle-orm/pg-core';
import { epochMs } from '@makaio/storage-drizzle/columns/postgres';
import { messages } from '../messages/schema.postgres.js';

/** Postgres twin of the `message_routing` table. */
export const messageRouting = pgTable(
  'message_routing',
  {
    /**
     * Foreign key to the message being routed.
     * Cascade deletes when message is removed.
     */
    messageId: text('message_id')
      .notNull()
      .references(() => messages.messageId, { onDelete: 'cascade' }),

    /** Target agent ID. */
    agentId: text('agent_id').notNull(),

    /**
     * Routing status.
     * - 'sent' | 'acknowledged' | 'completed'
     */
    status: text('status', { enum: ['sent', 'acknowledged', 'completed'] }).notNull(),

    /** Status change timestamp (Unix ms). */
    timestamp: epochMs('timestamp').notNull(),

    /** Error message if routing failed. */
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
