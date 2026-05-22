import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { messages } from '../messages/schema.js';
import { sessions } from '../storage/schema.js';

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
 */
export const sessionEvents = sqliteTable(
  'session_events',
  {
    /**
     * Auto-increment ID for stable cursor-based pagination.
     * Opaque to consumers — use eventId for external references.
     */
    id: integer('id').primaryKey({ autoIncrement: true }),

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
    timestamp: integer('timestamp').notNull(),

    /**
     * Event type discriminator.
     *
     * - 'message': Reference to messages table (conversation content)
     * - 'agent.added': Agent joined session
     * - 'turn.started': Turn began
     * - 'turn.completed': Turn finished
     * - 'user_message.sent/acknowledged/completed': User message lifecycle
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
     * References the user message that triggered this event.
     * NOT a FK to messages table - purely for correlation/grouping.
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

    /**
     * Turn ID for grouping.
     * Groups all events within a single turn (user message → agent responses).
     */
    turnId: text('turn_id'),

    /**
     * Extracted text content for search/embeddings.
     * Populated for text-bearing events (messages, reasoning).
     * NULL for structural events (tool.use, complete).
     */
    contentText: text('content_text'),

    /**
     * Full event payload as JSON string.
     * Contains complete data for exact API reconstruction.
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

/**
 * Type for inserting a new session event.
 */
export type InsertSessionEvent = typeof sessionEvents.$inferInsert;

/**
 * Type for a selected session event row.
 */
export type SelectSessionEvent = typeof sessionEvents.$inferSelect;
