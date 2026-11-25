import type { ExternalObjectRef, WriteRequest, WriteState } from '@makaio/contracts/journal';
import type { CallContextRecord } from '@makaio/core';
import { defineDualTable } from '@makaio/storage-drizzle';
import { index as pgIndex, uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import { index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Durable inputs to recovery. The credential locator carries no resolved secret. */
export type StoredWriteIntent = Omit<WriteRequest, 'key' | 'writer'> & {
  /** Extension that owns the participant. */
  readonly owner: string;
  /** Extension responsible for the external system. */
  readonly writerOwner: string;
  /** Time when this intent was committed. */
  readonly startedAt: number;
  /** Original target that bound this key, before later writes were converted to updates. */
  readonly keyTarget: WriteRequest['target'];
  /** Target requested for this attempt before it was translated to a writer operation. */
  readonly requestTarget?: WriteRequest['target'];
};

/** The current write record for each writer and key, with an independent lease for recovery. */
export const journalWritesDual = defineDualTable(
  'journal_writes',
  (c) => ({
    writeRecordId: c.text('write_record_id').primaryKey(),
    writer: c.text('writer').notNull(),
    key: c.text('key').notNull(),
    createdAt: c.epochMs('created_at').notNull(),
    state: c.text('state').$type<WriteState>().notNull(),
    version: c.text('version').notNull(),
    leaseUntil: c.epochMs('lease_until').notNull(),
    intentId: c.text('intent_id').notNull(),
    intent: c.jsonCol<StoredWriteIntent>('intent').notNull(),
    ctx: c.jsonCol<CallContextRecord>('ctx').notNull(),
    object: c.jsonCol<ExternalObjectRef>('object'),
    appliedObject: c.jsonCol<ExternalObjectRef>('applied_object'),
    objectKey: c.text('object_key'),
    parent: c.jsonCol<ExternalObjectRef>('parent'),
    parentKey: c.text('parent_key'),
    checksum: c.text('checksum'),
    appliedOrder: c.float8('applied_order'),
  }),
  {
    sqlite: (t) => [
      uniqueIndex('journal_writes_writer_key_uq').on(t.writer, t.key),
      index('journal_writes_object_page_idx').on(t.objectKey, t.createdAt, t.writeRecordId),
      index('journal_writes_parent_page_idx').on(t.parentKey, t.createdAt, t.writeRecordId),
    ],
    postgres: (t) => [
      pgUniqueIndex('journal_writes_writer_key_uq').on(t.writer, t.key),
      pgIndex('journal_writes_object_page_idx').on(t.objectKey, t.createdAt, t.writeRecordId),
      pgIndex('journal_writes_parent_page_idx').on(t.parentKey, t.createdAt, t.writeRecordId),
    ],
  },
);

/** Canonical SQLite table. */
export const journalWrites = journalWritesDual.sqlite;

/** Persisted write record. */
export type JournalWriteRow = typeof journalWrites.$inferSelect;
