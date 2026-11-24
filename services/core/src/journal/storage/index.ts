/**
 * Journal storage - fixed tables of the makaio core journal.
 *
 * Provides the canonical table definitions and dialect-resolved schema for
 * the journal's append-only entries, position counter, reader cursors,
 * reader states, and edge cursors. Store functions resolve the dialect face
 * at runtime via `resolveSchema(db, journalStorageSchema)`.
 */

export {
  journalEntriesDual,
  journalReaderStatesDual,
  journalEntries,
  journalPositionCounter,
  journalReaderCursors,
  journalReaderStates,
  journalEdgeCursors,
  type JournalEntryRow,
  type InsertJournalEntryRow,
  type JournalPositionCounterRow,
  type InsertJournalPositionCounterRow,
  type JournalReaderCursorRow,
  type InsertJournalReaderCursorRow,
  type JournalReaderStateRow,
  type InsertJournalReaderStateRow,
  type JournalEdgeCursorRow,
  type InsertJournalEdgeCursorRow,
} from './schema.js';
export { journalStorageSchema } from './schema.variants.js';
