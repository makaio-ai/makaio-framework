import type { HostDatabase } from '@makaio/contracts';
import {
  JournalReprocessRequestSchema,
  type JournalEntriesPage,
  type JournalEntriesRequest,
  type JournalEntry,
  type JournalReprocessRequest,
  type JournalReprocessResponse,
  type ReaderName,
  type ReaderStatesPage,
  type ReaderStatesRequest,
  type SubjectPattern,
} from '@makaio/contracts/journal';
import {
  getTransactionQueryContext,
  markTransactionWakeTopic,
  resolveSchema,
  type TransactionQueryContext,
} from '@makaio/storage-drizzle';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { JOURNAL_ENTRIES_WAKE_TOPIC } from './append-entries.js';
import {
  claimEntry,
  lockReader,
  nextClaimDue,
  settleClaim,
  type ReaderAttemptOutcome,
  type ReaderClaim,
} from './reader-claims.js';
import {
  queryEntries,
  queryReaderStates,
  readJournalHead,
  READER_BATCH_SIZE,
  selectSubjects,
} from './reader-queries.js';
import { journalStorageSchema } from './schema.variants.js';

export type { ReaderAttemptOutcome, ReaderClaim } from './reader-claims.js';

/**
 * Admit matching rows up to a committed high-water mark while preserving forward-only progress.
 * @param q - Query context with the reader cursor write lock.
 * @param reader - Name of the registered reader.
 * @param from - The current cursor position.
 * @param through - The highest position this sweep can admit.
 * @param patterns - Current validated subject patterns.
 * @returns The new cursor position; equal to the high-water mark when the sweep is complete.
 */
async function admitBatch(
  q: TransactionQueryContext,
  reader: ReaderName,
  from: number,
  through: number,
  patterns: readonly SubjectPattern[],
): Promise<number> {
  const {
    journalEntries: entries,
    journalReaderCursors: cursors,
    journalReaderStates: states,
  } = resolveSchema(q, journalStorageSchema);
  const rows = await q
    .select({ entryId: entries.entryId, position: entries.position, orderKey: entries.orderKey })
    .from(entries)
    .where(and(gt(entries.position, from), lte(entries.position, through), selectSubjects(entries.subject, patterns)))
    .orderBy(asc(entries.position))
    .limit(READER_BATCH_SIZE);

  if (rows.length > 0) {
    await q.insert(states).values(rows.map((row) => ({ reader, ...row, state: 'open' as const })));
  }
  const position = rows.length === READER_BATCH_SIZE ? (rows.at(-1)?.position ?? through) : through;
  await q.update(cursors).set({ position }).where(eq(cursors.reader, reader));
  return position;
}

/** Durable journal reader storage, backed by the same host database as journal writes. */
export class JournalReaderStore {
  /**
   * Create a store on the database shared by journal writers and reader effects.
   * @param host - Host database for all operations.
   */
  public constructor(private readonly host: HostDatabase) {}

  /**
   * Capture the current committed head without changing any reader's frontier.
   * @returns The highest committed journal position.
   */
  public head(): Promise<number> {
    return readJournalHead(this.host);
  }

  /**
   * Fix the start position on first activation. Subsequent activations keep the same frontier.
   * @param reader - Name of the registered reader.
   * @param startAt - Whether to include entries that already exist.
   * @param atPosition - An optional head captured while staging a reader with a `now` start.
   * @returns A promise that resolves when the initial frontier is stored.
   */
  public initialize(reader: ReaderName, startAt: 'now' | 'beginning', atPosition?: number): Promise<void> {
    return this.host.transaction(async (tx) => {
      const q = getTransactionQueryContext(tx);
      const { journalReaderCursors: cursors, journalPositionCounter: counter } = resolveSchema(q, journalStorageSchema);
      const head = q.select({ value: counter.value }).from(counter).where(eq(counter.id, 'journal'));
      const position = startAt === 'now' ? (atPosition ?? sql`coalesce((${head}), 0)`) : 0;
      await q.insert(cursors).values({ reader, position }).onConflictDoNothing({ target: cursors.reader });
    });
  }

  /**
   * Materialize the reader's states and advance its frontier atomically per batch.
   * A pattern change affects subsequent admissions and selections without rewinding the durable frontier.
   * @param reader - Name of the registered reader.
   * @param patterns - Current validated subject patterns.
   * @param isCurrent - Whether to start another batch once any in-flight batch has committed.
   */
  public async admit(
    reader: ReaderName,
    patterns: readonly SubjectPattern[],
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const head = await this.head();
    let position = 0;
    while (position < head && isCurrent()) {
      position = await this.host.transaction(async (tx) => {
        const q = getTransactionQueryContext(tx);
        const from = await lockReader(q, reader);
        if (from === undefined || from >= head) return head;
        return admitBatch(q, reader, from, head, patterns);
      });
    }
  }

  /**
   * Acquire a single due entry.
   * @param reader - Name of the registered reader.
   * @param leaseMs - Maximum duration of the claim in milliseconds.
   * @param patterns - Current eligible subjects.
   * @returns The claim, if one was available.
   */
  public claim(
    reader: ReaderName,
    leaseMs: number,
    patterns?: readonly SubjectPattern[],
  ): Promise<ReaderClaim | undefined> {
    return claimEntry(this.host, reader, leaseMs, patterns);
  }

  /**
   * Book a valid outcome and its optional effect, or roll back both.
   * @param claim - The ownership to check and complete.
   * @param outcome - The handler's result or the host's refusal.
   * @param isCurrent - Whether the registering generation is still active.
   * @returns A promise that resolves after settlement or when the claim is stale.
   */
  public settle(claim: ReaderClaim, outcome: ReaderAttemptOutcome, isCurrent: () => boolean): Promise<void> {
    return settleClaim(this.host, claim, outcome, isCurrent);
  }

  /**
   * Report the earliest due time, excluding blocked streams.
   * @param reader - Name of the registered reader.
   * @param patterns - Current eligible subjects.
   * @returns The earliest due time as epoch milliseconds, if work remains.
   */
  public nextDue(reader: ReaderName, patterns?: readonly SubjectPattern[]): Promise<number | undefined> {
    return nextClaimDue(this.host, reader, patterns);
  }

  /**
   * Query durable states for a reader in journal order.
   * @param input - Exact entry or paged query.
   * @returns The matching states.
   */
  public getReaderStates(input: ReaderStatesRequest): Promise<ReaderStatesPage> {
    return queryReaderStates(this.host, input);
  }

  /**
   * Reopen a failed entry for normal processing.
   * @param input - Reader and entry identifying the failed state.
   * @returns The outcome of this request.
   */
  public reprocess(input: JournalReprocessRequest): Promise<JournalReprocessResponse> {
    const { reader, entryId } = JournalReprocessRequestSchema.parse(input);
    return this.host.transaction(async (tx) => {
      const q = getTransactionQueryContext(tx);
      if ((await lockReader(q, reader)) === undefined) return { success: false, code: 'not-found' };
      const { journalReaderStates: states } = resolveSchema(q, journalStorageSchema);
      const key = and(eq(states.reader, reader), eq(states.entryId, entryId));
      const [updated] = await q
        .update(states)
        .set({ state: 'open', reason: null, notBefore: null })
        .where(and(key, eq(states.state, 'failed')))
        .returning({ entryId: states.entryId });
      if (updated === undefined) {
        const [existing] = await q.select({ entryId: states.entryId }).from(states).where(key);
        return { success: false, code: existing === undefined ? 'not-found' : 'not-failed' };
      }
      markTransactionWakeTopic(tx, JOURNAL_ENTRIES_WAKE_TOPIC);
      return { success: true, status: 'requeued' };
    });
  }

  /**
   * Query journal rows for a caller without retaining a transaction during authorization.
   * @param input - Exact entry or paged query.
   * @param mayRead - Authorization callback for each candidate.
   * @returns Only entries the caller can read.
   */
  public readEntries(
    input: JournalEntriesRequest,
    mayRead: (entry: JournalEntry) => Promise<boolean>,
  ): Promise<JournalEntriesPage> {
    return queryEntries(this.host, input, mayRead);
  }
}
