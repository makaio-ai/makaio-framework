/**
 * Postgres twin schema for the messages table.
 *
 * Congruent twin of `schema.ts` — identical SQL names, column types mapped to
 * Postgres equivalents via the shared column bundles. Row types are exclusively
 * owned by the canonical `schema.ts`; this file exports table objects only.
 */
import { pgTable, text, index, customType, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { epochMs } from '@makaio/storage-drizzle/columns/postgres';
import { sessions } from '../storage/schema.postgres.js';
import { turns } from '../turns/schema.postgres.js';

/**
 * Postgres custom column type wrapping the native `tsvector` type.
 *
 * `tsvector` is a sorted list of lexemes (normalized tokens) that Postgres
 * uses as the internal representation for full-text search. It has no
 * equivalent in SQLite; the canonical `schema.ts` deliberately omits this
 * column. drizzle-orm does not ship a first-class `tsvector` builder, so this
 * `customType` bridges the gap while keeping generated SQL identical to a
 * hand-written `tsvector` DDL column.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** Postgres twin of the `messages` table. */
export const messages = pgTable(
  'messages',
  {
    /** Unique message identifier (UUID). */
    messageId: text('message_id').primaryKey(),

    /**
     * Foreign key to the parent turn.
     * NULL for native imports (no turn tracking needed).
     * Cascade deletes when turn is removed.
     */
    turnId: text('turn_id').references(() => turns.turnId, { onDelete: 'cascade' }),

    /**
     * Foreign key to the parent session.
     * Denormalized for efficient session queries.
     * Cascade deletes when session is removed.
     */
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),

    /**
     * Message role.
     * - 'user' | 'assistant'
     */
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),

    /** Plain text content for full-text search. */
    contentText: text('content_text').notNull(),

    /**
     * Structured content blocks as JSON array.
     * Hand-stringified JSON — stored as plain text, never jsonb.
     * Default matches the canonical schema's string default.
     */
    blocks: text('blocks').notNull().default('[]'),

    /** Agent ID that generated this message. */
    agentId: text('agent_id'),

    /** Provider's session ID for context continuity. */
    adapterSessionId: text('adapter_session_id'),

    /** Adapter's stable message identifier. Used for fork detection. */
    adapterMessageId: text('adapter_message_id'),

    /** Message timestamp (Unix ms). */
    timestamp: epochMs('timestamp').notNull(),

    /**
     * If this is an edited message, references the original.
     * Self-FK: must use AnyPgColumn to avoid circular type inference.
     * No onDelete — parity net compares onDelete; adding one would be drift.
     */
    editOf: text('edit_of').references((): AnyPgColumn => messages.messageId),

    /**
     * Origin of the message.
     * - 'voice' | 'text' | 'compact'
     */
    origin: text('origin', { enum: ['voice', 'text', 'compact'] }),

    /**
     * Postgres-only stored generated full-text-search vector.
     *
     * Automatically maintained by Postgres whenever `content_text` changes.
     * Uses the `english` regconfig, which mirrors the SQLite FTS5 porter
     * stemming configuration used by the canonical SQLite schema. The
     * canonical SQLite schema deliberately does not declare this column —
     * SQLite FTS is handled by a separate virtual table.
     */
    contentTsv: tsvector('content_tsv').generatedAlwaysAs(sql`to_tsvector('english', coalesce(content_text, ''))`),
  },
  (table) => [
    /** Index for session-ordered queries (primary conversation history access). */
    index('idx_messages_session').on(table.sessionId, table.timestamp),

    /** Index for turn-ordered queries. */
    index('idx_messages_turn').on(table.turnId, table.timestamp),

    /** Index for agent-scoped queries in multi-agent sessions. */
    index('idx_messages_agent').on(table.agentId, table.timestamp),

    /** Index for adapter message ID queries (fork detection). */
    index('idx_messages_adapter_message_id').on(table.adapterMessageId),

    /**
     * GIN index on the stored tsvector column for efficient full-text search.
     *
     * GIN (Generalized Inverted Index) is the standard Postgres index type
     * for `tsvector` columns — it maps each lexeme to the rows that contain
     * it, providing O(log n + k) lookup where k is the number of matching
     * rows.
     */
    index('idx_messages_content_tsv').using('gin', table.contentTsv),
  ],
);
