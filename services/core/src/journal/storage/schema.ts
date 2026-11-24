import { sql } from 'drizzle-orm';
import { check, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  check as pgCheck,
  index as pgIndex,
  primaryKey as pgPrimaryKey,
  uniqueIndex as pgUniqueIndex,
} from 'drizzle-orm/pg-core';
import type { JsonValue, Origin, ReaderEntryState } from '@makaio/contracts';
import { defineDualTable } from '@makaio/storage-drizzle';

/**
 * Journal entries table.
 *
 * Holds every recorded event as one immutable row: fixed generic columns with
 * the subject's payload carried as structured data in a single JSON column,
 * never a table per subject. `position` is assigned from a single shared
 * counter in the same transaction that inserts the row, so position order and
 * commit order always agree — a reader walking positions in ascending order
 * never observes a later position before an earlier one has already
 * committed. The primary key is `entryId`, not `position`: an integer column
 * declared `PRIMARY KEY` on SQLite becomes a rowid alias that SQLite fills in
 * on its own (`AUTOINCREMENT`-like behaviour) if left unset, which would let
 * SQLite assign a position itself — exactly what the single shared counter
 * must own on both dialects. `position`'s own uniqueness is instead carried by
 * `journal_entries_position_uq`. `entryId` is otherwise unique in the same
 * sense position is — a stable identifier callers can address a row by
 * without relying on position. `(extension, key)` is unique so an extension's
 * own deduplication key can never record the same logical event twice. The
 * `(subject, position)` index serves lookups scoped to one subject without
 * scanning the whole journal.
 */
export const journalEntriesDual = defineDualTable(
  'journal_entries',
  (c) => ({
    /** Identifier of the entry; primary key so no integer rowid alias can assign a position on its own. */
    entryId: c.text('entry_id').primaryKey(),
    /** Ordinal of the entry over the whole journal, assigned from the position counter; never autoincrement or identity. Unique via `journal_entries_position_uq`. */
    position: c.int8('position').notNull(),
    /** Extension that recorded the entry and owns the subject's namespace. */
    extension: c.text('extension').notNull(),
    /** Name of the event the entry records. */
    subject: c.text('subject').notNull(),
    /** Payload, checked against the subject's schema when it was recorded. */
    payload: c.jsonCol<JsonValue>('payload').notNull(),
    /** Version of the subject's schema at the time of recording. */
    schemaVersion: c.text('schema_version').notNull(),
    /** Key against duplicates, unique per extension via the composite index below. */
    key: c.text('key').notNull(),
    /** Key that fixes the order among entries sharing it, when the recorder gave one. */
    orderKey: c.text('order_key'),
    /** Where the entry came from: recording call context, extension, and inbound edge when accepted through one. */
    origin: c.jsonCol<Origin>('origin').notNull(),
    /** When the entry was recorded, in process clock epoch milliseconds. */
    recordedAt: c.epochMs('recorded_at').notNull(),
  }),
  {
    sqlite: (t) => [
      uniqueIndex('journal_entries_position_uq').on(t.position),
      uniqueIndex('journal_entries_extension_key_uq').on(t.extension, t.key),
      index('journal_entries_subject_position_idx').on(t.subject, t.position),
    ],
    postgres: (t) => [
      pgUniqueIndex('journal_entries_position_uq').on(t.position),
      pgUniqueIndex('journal_entries_extension_key_uq').on(t.extension, t.key),
      pgIndex('journal_entries_subject_position_idx').on(t.subject, t.position),
    ],
  },
);

/** SQLite face of the `journal_entries` table (canonical schema). */
export const journalEntries = journalEntriesDual.sqlite;

/** Selected row of the `journal_entries` table. */
export type JournalEntryRow = typeof journalEntries.$inferSelect;
/** Row to insert into the `journal_entries` table. */
export type InsertJournalEntryRow = typeof journalEntries.$inferInsert;

/**
 * Journal position counter table.
 *
 * Carries the single counter row from which every entry's position is
 * assigned, in the same transaction that writes the entry: an upsert of row
 * `'journal'` that adds the number of new entries and returns the new value,
 * so the first assignment creates the row and no seed is needed. The row
 * stays locked until that transaction ends, so one shared counter, rather
 * than a per-dialect identity or sequence column, lets position order carry
 * commit order on both dialects. `id` is text, not an integer `PRIMARY KEY`
 * (which SQLite would fill in as a rowid alias on its own): the named check
 * pins it to the one row the store upserts, `id = 'journal'`.
 */
export const journalPositionCounterDual = defineDualTable(
  'journal_position_counter',
  (c) => ({
    /** Singleton row identifier; always `'journal'`. */
    id: c.text('id').primaryKey(),
    /** Highest position already assigned. */
    value: c.int8('value').notNull().default(0),
  }),
  {
    sqlite: (t) => [check('journal_position_counter_singleton_ck', sql`${t.id} = 'journal'`)],
    postgres: (t) => [pgCheck('journal_position_counter_singleton_ck', sql`${t.id} = 'journal'`)],
  },
);

/** SQLite face of the `journal_position_counter` table (canonical schema). */
export const journalPositionCounter = journalPositionCounterDual.sqlite;

/** Selected row of the `journal_position_counter` table. */
export type JournalPositionCounterRow = typeof journalPositionCounter.$inferSelect;
/** Row to insert into the `journal_position_counter` table. */
export type InsertJournalPositionCounterRow = typeof journalPositionCounter.$inferInsert;

/**
 * Journal reader cursors table.
 *
 * Carries one frontier position per reader: the highest journal position for
 * which that reader has already created its own per-entry reading states.
 * `position = 0` means the reader has taken in nothing yet; positions
 * otherwise start at `1`. The frontier only ever moves forward, and only
 * after every entry up to and including it that matches the reader's subjects
 * has a reading state, so a reader
 * resuming after a restart or failover always sees the same forward-only
 * prefix of the journal it would have seen without interruption.
 */
export const journalReaderCursorsDual = defineDualTable('journal_reader_cursors', (c) => ({
  /** Name of the reader this cursor belongs to. */
  reader: c.text('reader').primaryKey(),
  /** Highest journal position already taken into this reader's reading states. */
  position: c.int8('position').notNull(),
}));

/** SQLite face of the `journal_reader_cursors` table (canonical schema). */
export const journalReaderCursors = journalReaderCursorsDual.sqlite;

/** Selected row of the `journal_reader_cursors` table. */
export type JournalReaderCursorRow = typeof journalReaderCursors.$inferSelect;
/** Row to insert into the `journal_reader_cursors` table. */
export type InsertJournalReaderCursorRow = typeof journalReaderCursors.$inferInsert;

/**
 * Journal reader states table.
 *
 * Carries one reading state per reader per entry: whether the entry is still
 * open, was done, or ended as failed, together with the retry count, the
 * last reason, an optional not-before time, and the claim fields a reading
 * run uses to take exclusive, time-bounded ownership of the row before
 * handling it. A claim is taken and every transition away from `'open'` is
 * made by a conditional database update keyed on the current claim, so no two
 * valid claims exist for one reading state and only the holder of the valid
 * claim completes it; an attempt whose claim expired may still be running, but
 * it can no longer complete the entry. `journal_reader_states_claim_idx` serves
 * selecting claimable rows for one reader in position order;
 * `journal_reader_states_order_idx` serves checking whether an
 * earlier-positioned row sharing the same order key is still open before a
 * later one may be claimed.
 */
export const journalReaderStatesDual = defineDualTable(
  'journal_reader_states',
  (c) => ({
    /** Name of the reader this reading state belongs to. */
    reader: c.text('reader').notNull(),
    /** Identifier of the entry this reading state is for. */
    entryId: c.text('entry_id').notNull(),
    /** Position of the entry, carried alongside `entryId` for ordered claim and listing queries. */
    position: c.int8('position').notNull(),
    /** Order key of the entry, carried alongside `entryId` for same-order-key sequencing. */
    orderKey: c.text('order_key'),
    /** Whether the entry is still to be read, was processed, or ended as failed. */
    state: c
      .textEnum('state', { enum: ['open', 'done', 'failed'] as const })
      .notNull()
      .$type<ReaderEntryState['state']>(),
    /** How often handling of the entry was retried. */
    retries: c.int4('retries').notNull().default(0),
    /** Why the entry is not done, when the last attempt gave a reason. */
    reason: c.text('reason'),
    /** Epoch milliseconds before which the entry is not handed out again. */
    notBefore: c.epochMs('not_before'),
    /** Opaque token of the reading run currently holding this entry, while a claim is live. */
    claimToken: c.text('claim_token'),
    /** Epoch milliseconds at which the current claim stops being valid. */
    claimExpiresAt: c.epochMs('claim_expires_at'),
  }),
  {
    sqlite: (t) => [
      primaryKey({ name: 'journal_reader_states_pk', columns: [t.reader, t.entryId] }),
      check('journal_reader_states_state_ck', sql`${t.state} IN ('open', 'done', 'failed')`),
      index('journal_reader_states_claim_idx').on(t.reader, t.state, t.position),
      index('journal_reader_states_order_idx').on(t.reader, t.orderKey, t.position),
    ],
    postgres: (t) => [
      pgPrimaryKey({ name: 'journal_reader_states_pk', columns: [t.reader, t.entryId] }),
      pgCheck('journal_reader_states_state_ck', sql`${t.state} IN ('open', 'done', 'failed')`),
      pgIndex('journal_reader_states_claim_idx').on(t.reader, t.state, t.position),
      pgIndex('journal_reader_states_order_idx').on(t.reader, t.orderKey, t.position),
    ],
  },
);

/** SQLite face of the `journal_reader_states` table (canonical schema). */
export const journalReaderStates = journalReaderStatesDual.sqlite;

/** Selected row of the `journal_reader_states` table. */
export type JournalReaderStateRow = typeof journalReaderStates.$inferSelect;
/** Row to insert into the `journal_reader_states` table. */
export type InsertJournalReaderStateRow = typeof journalReaderStates.$inferInsert;

/**
 * Journal edge cursors table.
 *
 * Carries one delivery cursor per partition of one inbound edge, so a
 * connector resuming delivery after a restart continues from where it left
 * off instead of replaying or skipping events of that partition.
 */
export const journalEdgeCursorsDual = defineDualTable(
  'journal_edge_cursors',
  (c) => ({
    /** Name of the inbound edge this cursor belongs to. */
    edge: c.text('edge').notNull(),
    /** Partition of the edge this cursor tracks. */
    partition: c.text('partition').notNull(),
    /** Opaque cursor value of the edge's own delivery protocol. */
    value: c.text('value'),
  }),
  {
    sqlite: (t) => [primaryKey({ name: 'journal_edge_cursors_pk', columns: [t.edge, t.partition] })],
    postgres: (t) => [pgPrimaryKey({ name: 'journal_edge_cursors_pk', columns: [t.edge, t.partition] })],
  },
);

/** SQLite face of the `journal_edge_cursors` table (canonical schema). */
export const journalEdgeCursors = journalEdgeCursorsDual.sqlite;

/** Selected row of the `journal_edge_cursors` table. */
export type JournalEdgeCursorRow = typeof journalEdgeCursors.$inferSelect;
/** Row to insert into the `journal_edge_cursors` table. */
export type InsertJournalEdgeCursorRow = typeof journalEdgeCursors.$inferInsert;
