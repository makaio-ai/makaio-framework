import { index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { index as pgIndex, uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';
import { sessionsDual } from '../storage/schema.js';

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
export const turnsDual = defineDualTable(
  'turns',
  (c) => ({
    /**
     * Unique turn identifier (UUID).
     */
    turnId: c.text('turn_id').primaryKey(),

    /**
     * Foreign key to the parent session.
     * Cascade deletes when session is removed.
     */
    sessionId: c
      .text('session_id')
      .notNull()
      .references(() => sessionsDual.columnPair('sessionId'), { onDelete: 'cascade' }),

    /**
     * Monotonic per-session ordinal (1-based).
     * Assigned atomically at creation to preserve insertion order.
     * Plain integer counter — stays integer on both dialects.
     */
    turnNumber: c.int4('turn_number').notNull(),

    /**
     * Turn start timestamp (Unix ms).
     * When the user message was received.
     */
    startedAt: c.epochMs('started_at').notNull(),

    /**
     * Turn completion timestamp (Unix ms).
     * When all agents have responded. NULL while in progress.
     */
    completedAt: c.epochMs('completed_at'),

    /**
     * Turn status.
     * - 'active': Turn in progress, agents responding
     * - 'completed': All agents have responded
     * - 'error': Turn failed with error
     */
    status: c.textEnum('status', { enum: ['active', 'completed', 'error'] as const }).notNull(),

    /**
     * Error message if status is 'error'.
     * NULL for successful turns.
     */
    error: c.text('error'),

    /**
     * Aggregated usage/cost for this turn.
     * Populated on turn completion. Stored as JSON string.
     * @see TurnUsageSchema in libs/contracts for structure definition
     */
    usage: c.text('usage'),
  }),
  {
    sqlite: (t) => [
      /**
       * Index for session-ordered queries.
       * Used for loading turn history in order.
       */
      index('idx_turns_session').on(t.sessionId, t.startedAt),

      /**
       * Enforce unique (sessionId, turnNumber) pairs.
       * Backs the atomic INSERT subquery in registerCreateHandler — prevents
       * duplicate turn numbers when concurrent inserts race on MAX().
       */
      uniqueIndex('uniq_turns_session_number').on(t.sessionId, t.turnNumber),
    ],
    postgres: (t) => [
      pgIndex('idx_turns_session').on(t.sessionId, t.startedAt),
      pgUniqueIndex('uniq_turns_session_number').on(t.sessionId, t.turnNumber),
    ],
  },
);

/** SQLite face of the `turns` table (canonical schema). */
export const turns = turnsDual.sqlite;

/**
 * Type for inserting a new turn.
 */
export type InsertTurn = typeof turns.$inferInsert;

/**
 * Type for a selected turn row.
 */
export type SelectTurn = typeof turns.$inferSelect;
