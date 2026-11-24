/**
 * Postgres faces for the journal tables.
 *
 * Each table is defined once via `defineDualTable` in `schema.ts`; this file
 * exposes the Postgres face of every journal table under its canonical name
 * so the Postgres migration chain and the dialect-variant aggregate keep
 * resolving them.
 */
import {
  journalEdgeCursorsDual,
  journalEntriesDual,
  journalPositionCounterDual,
  journalReaderCursorsDual,
  journalReaderStatesDual,
} from './schema.js';

/** Postgres face of the `journal_entries` table. */
export const journalEntries = journalEntriesDual.postgres;

/** Postgres face of the `journal_position_counter` table. */
export const journalPositionCounter = journalPositionCounterDual.postgres;

/** Postgres face of the `journal_reader_cursors` table. */
export const journalReaderCursors = journalReaderCursorsDual.postgres;

/** Postgres face of the `journal_reader_states` table. */
export const journalReaderStates = journalReaderStatesDual.postgres;

/** Postgres face of the `journal_edge_cursors` table. */
export const journalEdgeCursors = journalEdgeCursorsDual.postgres;
