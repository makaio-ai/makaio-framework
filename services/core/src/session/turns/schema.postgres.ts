/**
 * Postgres twin schema for the turns table.
 *
 * Congruent twin of `schema.ts` — identical SQL names, column types mapped to
 * Postgres equivalents via the shared column bundles. Row types are exclusively
 * owned by the canonical `schema.ts`; this file exports table objects only.
 */
import { pgTable, text, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { epochMs } from '@makaio/storage-drizzle/columns/postgres';
import { sessions } from '../storage/schema.postgres.js';

/** Postgres twin of the `turns` table. */
export const turns = pgTable(
  'turns',
  {
    /** Unique turn identifier (UUID). */
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
     * Plain integer counter — stays integer on both dialects.
     */
    turnNumber: integer('turn_number').notNull(),

    /** Turn start timestamp (Unix ms). */
    startedAt: epochMs('started_at').notNull(),

    /** Turn completion timestamp (Unix ms). NULL while in progress. */
    completedAt: epochMs('completed_at'),

    /**
     * Turn status.
     * - 'active' | 'completed' | 'error'
     */
    status: text('status', { enum: ['active', 'completed', 'error'] }).notNull(),

    /** Error message if status is 'error'. */
    error: text('error'),

    /**
     * Aggregated usage/cost for this turn.
     * Populated on turn completion. Hand-stringified JSON — stored as plain text.
     */
    usage: text('usage'),
  },
  (table) => [
    /** Index for session-ordered queries. */
    index('idx_turns_session').on(table.sessionId, table.startedAt),

    /**
     * Enforce unique (sessionId, turnNumber) pairs.
     * Backs the atomic INSERT subquery in registerCreateHandler.
     */
    uniqueIndex('uniq_turns_session_number').on(table.sessionId, table.turnNumber),
  ],
);
