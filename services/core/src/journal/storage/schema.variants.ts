import { defineDialectSchema } from '@makaio/storage-drizzle';
import {
  journalEntries,
  journalPositionCounter,
  journalReaderCursors,
  journalReaderStates,
  journalEdgeCursors,
} from './schema.js';
import {
  journalEntries as journalEntriesPg,
  journalPositionCounter as journalPositionCounterPg,
  journalReaderCursors as journalReaderCursorsPg,
  journalReaderStates as journalReaderStatesPg,
  journalEdgeCursors as journalEdgeCursorsPg,
} from './schema.postgres.js';

/** Dialect variants for the journal storage tables. */
export const journalStorageSchema = defineDialectSchema(
  { journalEntries, journalPositionCounter, journalReaderCursors, journalReaderStates, journalEdgeCursors },
  {
    journalEntries: journalEntriesPg,
    journalPositionCounter: journalPositionCounterPg,
    journalReaderCursors: journalReaderCursorsPg,
    journalReaderStates: journalReaderStatesPg,
    journalEdgeCursors: journalEdgeCursorsPg,
  },
);
