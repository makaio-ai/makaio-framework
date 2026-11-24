import { randomUUID } from 'node:crypto';
import {
  JournalError,
  type AcceptEntryInput,
  type EdgeName,
  type HostTransaction,
  type Origin,
  type RecordEntryInput,
  type SubjectName,
} from '@makaio/contracts';
import type { ExtensionName } from '@makaio/core';
import {
  getTransactionQueryContext,
  markTransactionRollbackOnly,
  markTransactionWakeTopic,
  resolveSchema,
  type TransactionQueryContext,
} from '@makaio/storage-drizzle';
import { and, eq, sql } from 'drizzle-orm';
import type { ZodType } from 'zod';
import type { JournalEntryRow } from './schema.js';
import { journalStorageSchema } from './schema.variants.js';

/** Wake topic for transactions that committed new journal entries. */
export const JOURNAL_ENTRIES_WAKE_TOPIC = 'journal.entries';

/** Active declaration of one canonical subject. */
export interface AppendSubjectDeclaration {
  readonly recorded: boolean;
  readonly owner: ExtensionName;
  readonly schemaVersion: string;
  readonly payloadSchema: ZodType;
}

/** Lookup of active declarations for the current append. */
export interface AppendSubjectResolver {
  /**
   * Resolve a canonical subject name.
   * @param subject - Subject named in the entry.
   * @returns The active declaration, if any.
   */
  resolve(subject: SubjectName): AppendSubjectDeclaration | undefined;
}

/** One entry with provenance prepared by the calling journal capability. */
export type AppendEntry = (RecordEntryInput | AcceptEntryInput) & {
  readonly origin: Pick<Origin, 'caller' | 'principal' | 'attestedBy'>;
};

/** Entries and authority supplied by the record or accept capability. */
export interface AppendEntriesInput {
  /** Host transaction that owns the supplied query context. */
  readonly tx: HostTransaction;
  /** Extension recording the entries. */
  readonly extension: ExtensionName;
  /** Lookup of the batch's active subject declarations. */
  readonly subjects: AppendSubjectResolver;
  /** Entries in recording order. */
  readonly entries: readonly AppendEntry[];
  /** Edge bound to the accept capability, if applicable. */
  readonly edge?: EdgeName;
}

/** Outcome and durable row for one entry, in input order. */
export interface AppendEntryOutcome {
  readonly status: 'recorded' | 'known';
  readonly row: JournalEntryRow;
}

/**
 * Check subject eligibility even when the requested key already exists.
 * @param input - Recording extension and declaration lookup.
 * @param subject - Canonical subject to check.
 * @returns The eligible subject's declaration.
 */
function requireRecordedSubject(input: AppendEntriesInput, subject: SubjectName): AppendSubjectDeclaration {
  const declaration = input.subjects.resolve(subject);
  if (declaration === undefined) {
    throw new JournalError('subject-unknown', `Journal subject "${subject}" is unknown.`);
  }
  if (!declaration.recorded) {
    throw new JournalError('subject-not-recorded', `Journal subject "${subject}" is not recorded.`);
  }
  if (declaration.owner !== input.extension) {
    throw new JournalError('name-not-owned', `Journal subject "${subject}" is not owned by "${input.extension}".`);
  }
  return declaration;
}

/**
 * Find the stored entry for the key and enforce that it names the requested subject.
 * @param q - Query context of the caller's transaction.
 * @param table - Dialect-specific journal entry table.
 * @param extension - Recording extension whose keys to search.
 * @param entry - Requested entry.
 * @returns The known outcome or undefined for a new key.
 */
async function findReplay(
  q: TransactionQueryContext,
  table: typeof journalStorageSchema.sqlite.journalEntries,
  extension: ExtensionName,
  entry: AppendEntry,
): Promise<AppendEntryOutcome | undefined> {
  const [row] = await q
    .select()
    .from(table)
    .where(and(eq(table.extension, extension), eq(table.key, entry.key)));
  if (row === undefined) return undefined;
  if (row.subject !== entry.subject) {
    throw new JournalError(
      'key-subject-mismatch',
      `Extension "${extension}" requested journal subject "${entry.subject}" but existing entry "${row.entryId}" has subject "${row.subject}".`,
    );
  }
  return { status: 'known', row };
}

/**
 * Append a single entry or return its immutable replay.
 * @param q - Query context of the caller's transaction.
 * @param input - Recording authority and provenance for the batch.
 * @param entry - Entry to append.
 * @returns The stored row and its outcome.
 */
async function appendEntry(
  q: TransactionQueryContext,
  input: AppendEntriesInput,
  entry: AppendEntry,
): Promise<AppendEntryOutcome> {
  const { journalEntries: table, journalPositionCounter: counter } = resolveSchema(q, journalStorageSchema);
  const declaration = requireRecordedSubject(input, entry.subject);
  const replay = await findReplay(q, table, input.extension, entry);
  if (replay !== undefined) return replay;

  // Serialize writers through commit. A contender that missed the initial
  // lookup rechecks after acquiring the counter lock, before validating.
  const [locked] = await q
    .insert(counter)
    .values({ id: 'journal', value: 0 })
    .onConflictDoUpdate({ target: counter.id, set: { value: sql`${counter.value}` } })
    .returning({ value: counter.value });
  if (locked === undefined) throw new Error('Journal position counter did not return a value.');
  const concurrentReplay = await findReplay(q, table, input.extension, entry);
  if (concurrentReplay !== undefined) return concurrentReplay;

  if (!(await declaration.payloadSchema.safeParseAsync(entry.payload)).success) {
    throw new JournalError('payload-invalid', `Payload for journal subject "${entry.subject}" failed validation.`);
  }

  const edge = input.edge ?? ('edge' in entry ? entry.edge : undefined);
  const witnessed = 'witnessed' in entry ? entry.witnessed : undefined;
  const [row] = await q
    .insert(table)
    .values({
      entryId: randomUUID(),
      position: locked.value + 1,
      extension: input.extension,
      subject: entry.subject,
      // Drizzle binds JS null as SQL NULL before the column encoder runs.
      payload: entry.payload === null ? sql`'null'` : entry.payload,
      schemaVersion: declaration.schemaVersion,
      key: entry.key,
      orderKey: entry.orderKey,
      origin: {
        ...entry.origin,
        extension: input.extension,
        ...(edge === undefined ? {} : { edge }),
        ...(witnessed === undefined ? {} : { witnessed }),
      },
      recordedAt: Date.now(),
    })
    .onConflictDoNothing({ target: [table.extension, table.key] })
    .returning();
  if (row === undefined) {
    const conflict = await findReplay(q, table, input.extension, entry);
    if (conflict !== undefined) return conflict;
    throw new Error('Conflicting journal entry could not be read.');
  }

  await q.update(counter).set({ value: row.position }).where(eq(counter.id, 'journal'));
  return { status: 'recorded', row };
}

/**
 * Record or accept entries within an open host transaction.
 *
 * Acquire domain locks before the first append, and await appends in order
 * within a transaction. The journal counter lock is held until commit.
 * @param q - Query context authorized by the caller's host database.
 * @param input - The same host transaction and the prepared batch.
 * @returns One outcome with its stored row per input entry.
 */
export async function appendEntries(
  q: TransactionQueryContext,
  input: AppendEntriesInput,
): Promise<AppendEntryOutcome[]> {
  const authorized = getTransactionQueryContext(input.tx);
  try {
    if (authorized !== q) {
      throw new Error('Journal append requires the query context of its host transaction.');
    }
    const outcomes: AppendEntryOutcome[] = [];
    for (const entry of input.entries) {
      outcomes.push(await appendEntry(q, input, entry));
    }
    if (outcomes.some(({ status }) => status === 'recorded')) {
      markTransactionWakeTopic(input.tx, JOURNAL_ENTRIES_WAKE_TOPIC);
    }
    return outcomes;
  } catch (error) {
    markTransactionRollbackOnly(
      input.tx,
      error instanceof Error ? error : new Error('Journal append failed.', { cause: error }),
    );
    throw error;
  }
}
