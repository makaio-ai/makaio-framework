import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { epochMs } from '@makaio/storage-drizzle/columns/sqlite';
import { sessionsDual } from '../storage/schema.js';
import { turnsDual } from '../turns/schema.js';

/**
 * Messages table schema.
 *
 * The single source of truth for conversation content as consumed by Makaio
 * (UI history, search, transforms, routing).
 *
 * Design principles:
 * - Messages are first-class entities, not embedded in events
 * - Single source of truth for conversation content
 * - Blocks stored as JSON for flexible structure
 * - contentText extracted for FTS5 search
 * - session_events tracks lifecycle (turns, branches) but not content
 */
export const messages = sqliteTable(
  'messages',
  {
    /**
     * Unique message identifier (UUID).
     */
    messageId: text('message_id').primaryKey(),

    /**
     * Foreign key to the parent turn.
     * NULL for native imports (no turn tracking needed).
     * Cascade deletes when turn is removed.
     */
    turnId: text('turn_id').references(() => turnsDual.sqlite.turnId, { onDelete: 'cascade' }),

    /**
     * Foreign key to the parent session.
     * Denormalized for efficient session queries.
     * Cascade deletes when session is removed.
     */
    sessionId: text('session_id')
      .notNull()
      .references(() => sessionsDual.sqlite.sessionId, { onDelete: 'cascade' }),

    /**
     * Message role.
     * - 'user': User-authored message
     * - 'assistant': AI-generated response
     */
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),

    /**
     * Plain text content for FTS5 search.
     * Extracted from blocks for indexing.
     */
    contentText: text('content_text').notNull(),

    /**
     * Structured content blocks as JSON array.
     * Preserves full response fidelity: text, reasoning, tool_call, tool_output.
     */
    blocks: text('blocks').notNull().default('[]'),

    /**
     * Agent ID that generated this message.
     * NULL for user messages, required for assistant messages.
     */
    agentId: text('agent_id'),

    /**
     * Provider's session ID for context continuity.
     * Links to external API session for turn-taking.
     */
    adapterSessionId: text('adapter_session_id'),

    /**
     * Adapter's stable message identifier.
     * For Claude Code, this is the uuid field that's preserved across forks.
     * Used for fork detection: same adapterMessageId in different sessions = shared ancestry.
     */
    adapterMessageId: text('adapter_message_id'),

    /**
     * Message timestamp (Unix ms).
     */
    timestamp: epochMs('timestamp').notNull(),

    /**
     * If this is an edited message, references the original.
     * NULL for original messages.
     */
    editOf: text('edit_of').references((): ReturnType<typeof text> => messages.messageId),

    /**
     * Origin of the message (e.g. 'voice', 'text').
     * NULL for messages predating this field.
     */
    origin: text('origin', { enum: ['voice', 'text', 'compact'] }),
  },
  (table) => [
    /**
     * Index for session-ordered queries.
     * Primary access pattern for loading conversation history.
     */
    index('idx_messages_session').on(table.sessionId, table.timestamp),

    /**
     * Index for turn-ordered queries.
     * Used for loading messages within a specific turn.
     */
    index('idx_messages_turn').on(table.turnId, table.timestamp),

    /**
     * Index for agent-scoped queries.
     * Used for filtering messages by agent in multi-agent sessions.
     */
    index('idx_messages_agent').on(table.agentId, table.timestamp),

    /**
     * Index for adapter message ID queries.
     * Used for fork detection across sessions.
     */
    index('idx_messages_adapter_message_id').on(table.adapterMessageId),
  ],
);

/**
 * Type for inserting a new message.
 */
export type InsertMessage = typeof messages.$inferInsert;

/**
 * Type for a selected message row.
 */
export type SelectMessage = typeof messages.$inferSelect;
