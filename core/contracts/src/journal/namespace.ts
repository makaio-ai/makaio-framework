import { createBusNamespace, localSubject, type SchemaRecord } from '@makaio/core';
import {
  JournalEntriesPageSchema,
  JournalEntriesRequestSchema,
  JournalReprocessRequestSchema,
  JournalReprocessResponseSchema,
  ReaderStatesPageSchema,
  ReaderStatesRequestSchema,
} from './schemas.js';
import {
  JournalResolveWriteRequestSchema,
  JournalResolveWriteResponseSchema,
  JournalWritesPageSchema,
  JournalWritesRequestSchema,
} from './write-schemas.js';

/**
 * Bus schemas of the journal.
 *
 * - `entries` reads recorded entries, read-only. It is local to the host process because entries carry the full
 *   parties of their origin, including claims. Only entries the asking context may subscribe to are returned.
 * - `reader-states` reads the reading states of one reader in pages.
 * - `reprocess` sets a failed reading state back to open.
 * - `writes` reads records of the write log in pages, read-only. It is local to the host process because a record
 *   carries the call context of its write, including claims.
 * - `resolve-write` settles an unresolved or expired intent by the intent ID returned by `writes`.
 *   It is local to the host process for the same reason.
 */
export const JournalSchemas = {
  entries: localSubject({ request: JournalEntriesRequestSchema, response: JournalEntriesPageSchema }),
  'reader-states': { request: ReaderStatesRequestSchema, response: ReaderStatesPageSchema },
  reprocess: { request: JournalReprocessRequestSchema, response: JournalReprocessResponseSchema },
  writes: localSubject({ request: JournalWritesRequestSchema, response: JournalWritesPageSchema }),
  'resolve-write': localSubject({
    request: JournalResolveWriteRequestSchema,
    response: JournalResolveWriteResponseSchema,
  }),
} satisfies SchemaRecord;

/** Journal bus namespace, domain `makaio:journal`. */
export const JournalNamespace = createBusNamespace('makaio:journal', JournalSchemas);

/** Typed subjects of the journal, for `bus.request()` and `bus.on()`. */
export const JournalSubjects = JournalNamespace.subjects;
