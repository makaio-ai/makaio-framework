import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { epochMs } from '@makaio/storage-drizzle/columns/sqlite';
import { sessions } from '../storage/schema.js';

/**
 * Turns table schema.
 *
 * A turn represents a user message and all agent responses to it.
 * Extracted from events to provide explicit turn boundaries.
 *
 * Design rationale:
 * - First-class entity for turn lifecycle tracking
 * - Links to session via FK for cascade delete
 * - Status tracks completion state for UI progress indication
 */
export const turns = sqliteTable(
  'turns',
  {
    /**
     * Unique turn identifier (UUID).
     */
    turnId: text('turn_id').primaryKey(),

    /**
     * Foreign key to the parent session.
     * Cascade deletes when session is removed.
     */
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),

    /**
     * Monotonic per-session ordinal (1-based).
     * Assigned atomically at creation to preserve insertion order.
     */
    turnNumber: integer('turn_number').notNull(),

    /**
     * Turn start timestamp (Unix ms).
     * When the user message was received.
     */
    startedAt: epochMs('started_at').notNull(),

    /**
     * Turn completion timestamp (Unix ms).
     * When all agents have responded. NULL while in progress.
     */
    completedAt: epochMs('completed_at'),

    /**
     * Turn status.
     * - 'active': Turn in progress, agents responding
     * - 'completed': All agents have responded
     * - 'error': Turn failed with error
     */
    status: text('status', { enum: ['active', 'completed', 'error'] }).notNull(),

    /**
     * Error message if status is 'error'.
     * NULL for successful turns.
     */
    error: text('error'),

    /**
     * Aggregated usage/cost for this turn.
     * Populated on turn completion. Stored as JSON string.
     * @see TurnUsageSchema in libs/contracts for structure definition
     */
    usage: text('usage'),
  },
  (table) => [
    /**
     * Index for session-ordered queries.
     * Used for loading turn history in order.
     */
    index('idx_turns_session').on(table.sessionId, table.startedAt),

    /**
     * Enforce unique (sessionId, turnNumber) pairs.
     * Backs the atomic INSERT subquery in registerCreateHandler — prevents
     * duplicate turn numbers when concurrent inserts race on MAX().
     */
    uniqueIndex('uniq_turns_session_number').on(table.sessionId, table.turnNumber),
  ],
);

/**
 * Type for inserting a new turn.
 */
export type InsertTurn = typeof turns.$inferInsert;

/**
 * Type for a selected turn row.
 */
export type SelectTurn = typeof turns.$inferSelect;
