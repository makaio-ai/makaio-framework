/**
 * Postgres twin schema for the session events table.
 *
 * Congruent twin of `schema.ts` — identical SQL names, column types mapped to
 * Postgres equivalents via the shared column bundles. Row types are exclusively
 * owned by the canonical `schema.ts`; this file exports table objects only.
 */
import { pgTable, text, index } from 'drizzle-orm/pg-core';
import { epochMs, autoPk } from '@makaio/storage-drizzle/columns/postgres';
import { messages } from '../messages/schema.postgres.js';
import { sessions } from '../storage/schema.postgres.js';

/** Postgres twin of the `session_events` table. */
export const sessionEvents = pgTable(
  'session_events',
  {
    /**
     * Auto-increment ID for stable cursor-based pagination.
     * Opaque to consumers — use eventId for external references.
     */
    id: autoPk('id'),

    /**
     * Makaio session ID (FK to sessions table).
     * All events for a session are deleted when session is purged.
     */
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),

    /**
     * Unique event identifier (UUID).
     * Used for deduplication and external references.
     */
    eventId: text('event_id').notNull().unique(),

    /**
     * Event timestamp (Unix ms).
     * Used for ordering and time-based queries.
     */
    timestamp: epochMs('timestamp').notNull(),

    /**
     * Event type discriminator (free-form string, not an enum).
     * Examples: 'message', 'agent.added', 'turn.started', 'turn.completed'.
     */
    type: text('type').notNull(),

    /**
     * Agent ID (nullable).
     * Populated for agent.added events.
     */
    agentId: text('agent_id'),

    /**
     * Adapter ID (nullable).
     * Populated for agent.added events.
     */
    adapterId: text('adapter_id'),

    /**
     * Originating message ID for correlation.
     * NOT a FK to messages table — purely for correlation/grouping.
     */
    originatingMessageId: text('originating_message_id'),

    /**
     * Reference to messages table.
     * Populated for type='message' events.
     * FK enables cascade delete when message is removed.
     */
    messageId: text('message_id').references(() => messages.messageId, {
      onDelete: 'cascade',
    }),

    /** Turn ID for grouping events within a single turn. */
    turnId: text('turn_id'),

    /**
     * Extracted text content for search/embeddings.
     * NULL for structural events (tool.use, complete).
     */
    contentText: text('content_text'),

    /**
     * Full event payload as JSON string.
     * Hand-stringified JSON — stored as plain text, never jsonb.
     */
    payload: text('payload').notNull(),
  },
  (table) => [
    index('idx_events_session_ts').on(table.sessionId, table.timestamp),
    index('idx_events_session_type').on(table.sessionId, table.type),
    index('idx_events_turn').on(table.turnId),
    index('idx_events_originating_message').on(table.originatingMessageId),
  ],
);
