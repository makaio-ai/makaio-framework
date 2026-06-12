import { index } from 'drizzle-orm/sqlite-core';
import { index as pgIndex } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';
import { messageIdColumnPair } from '../messages/schema.variants.js';
import { sessionsDual } from '../storage/schema.js';

/**
 * Session events table schema.
 *
 * Stores immutable, append-only session events for unified history reconstruction.
 * Events are persisted by SessionLogger via storage service.
 *
 * **Event Types:**
 * - Message references (type='message' with messageId FK to messages table)
 * - Agent lifecycle (agent.added)
 * - Turn lifecycle (turn.started, turn.completed)
 * - User message events (user_message.sent/acknowledged/completed)
 *
 * Design rationale:
 * - First-class columns for queryable fields (IDs, timestamp, type)
 * - `contentText` extracted for FTS5/embeddings (future)
 * - `payload` stores full JSON for exact API reconstruction
 *
 * SEAM: The `sessionId` FK enables cascade delete when sessions are purged.
 * Future embeddings table can reference `eventId` for vector search.
 *
 * The `messages` table stays a hand-written twin (it carries a Postgres-only
 * `content_tsv` generated column), so the `messageId` FK target comes from the
 * twin's `messageIdColumnPair` thunk rather than a `columnPair` on a dual table.
 */
export const sessionEventsDual = defineDualTable(
  'session_events',
  (c) => ({
    /**
     * Auto-increment ID for stable cursor-based pagination.
     * Opaque to consumers — use eventId for external references.
     */
    id: c.autoPk('id'),

    /**
     * Makaio session ID (FK to sessions table).
     * All events for a session are deleted when session is purged.
     */
    sessionId: c
      .text('session_id')
      .notNull()
      .references(() => sessionsDual.columnPair('sessionId'), { onDelete: 'cascade' }),

    /**
     * Unique event identifier (UUID).
     * Used for deduplication and external references.
     */
    eventId: c.text('event_id').notNull().unique(),

    /**
     * Event timestamp (Unix ms).
     * Used for ordering and time-based queries.
     */
    timestamp: c.epochMs('timestamp').notNull(),

    /**
     * Event type discriminator.
     *
     * - 'message': Reference to messages table (conversation content)
     * - 'agent.added': Agent joined session
     * - 'turn.started': Turn began
     * - 'turn.completed': Turn finished
     * - 'user_message.sent/acknowledged/completed': User message lifecycle
     */
    type: c.text('type').notNull(),

    /**
     * Agent ID (nullable).
     * Populated for agent.added events.
     */
    agentId: c.text('agent_id'),

    /**
     * Adapter ID (nullable).
     * Populated for agent.added events.
     */
    adapterId: c.text('adapter_id'),

    /**
     * Originating message ID for correlation.
     * References the user message that triggered this event.
     * NOT a FK to messages table - purely for correlation/grouping.
     */
    originatingMessageId: c.text('originating_message_id'),

    /**
     * Reference to messages table.
     * Populated for type='message' events.
     * FK enables cascade delete when message is removed.
     */
    messageId: c.text('message_id').references(messageIdColumnPair, {
      onDelete: 'cascade',
    }),

    /**
     * Turn ID for grouping.
     * Groups all events within a single turn (user message → agent responses).
     */
    turnId: c.text('turn_id'),

    /**
     * Extracted text content for search/embeddings.
     * Populated for text-bearing events (messages, reasoning).
     * NULL for structural events (tool.use, complete).
     */
    contentText: c.text('content_text'),

    /**
     * Full event payload as JSON string.
     * Contains complete data for exact API reconstruction.
     */
    payload: c.text('payload').notNull(),
  }),
  {
    sqlite: (t) => [
      index('idx_events_session_ts').on(t.sessionId, t.timestamp),
      index('idx_events_session_type').on(t.sessionId, t.type),
      index('idx_events_turn').on(t.turnId),
      index('idx_events_originating_message').on(t.originatingMessageId),
    ],
    postgres: (t) => [
      pgIndex('idx_events_session_ts').on(t.sessionId, t.timestamp),
      pgIndex('idx_events_session_type').on(t.sessionId, t.type),
      pgIndex('idx_events_turn').on(t.turnId),
      pgIndex('idx_events_originating_message').on(t.originatingMessageId),
    ],
  },
);

/** SQLite face of the `session_events` table (canonical schema). */
export const sessionEvents = sessionEventsDual.sqlite;

/**
 * Type for inserting a new session event.
 *
 * Derived from the SQLite face: SQLite keeps the auto-increment `id` optional,
 * while the Postgres `GENERATED ALWAYS AS IDENTITY` face omits it. The insert
 * path never supplies `id`, so the SQLite face is the canonical insert shape.
 */
export type InsertSessionEvent = typeof sessionEvents.$inferInsert;

/**
 * Type for a selected session event row.
 */
export type SelectSessionEvent = typeof sessionEvents.$inferSelect;
