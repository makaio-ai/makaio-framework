import { randomUUID } from 'node:crypto';
import type { HostDatabase } from '@makaio/contracts';
import {
  JournalReprocessRequestSchema,
  type JournalEntriesPage,
  type JournalEntriesRequest,
  type JournalEntry,
  type JournalReprocessRequest,
  type JournalReprocessResponse,
  type ReaderContribution,
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
import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { JournalActivationError } from '../journal-contribution-processor.js';
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

/** Cursor and rollback authority obtained by one activation. */
export type ReaderCursorReservation = Readonly<{
  reader: ReaderName;
  owner: string;
  position: number;
  change?: { readonly token: string; readonly kind: 'created' | 'adopted' };
}>;

/**
 * Reserve one exact cursor without replacing progress or a recorded owner.
 * @param q - Context of the enclosing batch reservation.
 * @param owner - Requesting extension.
 * @param reader - Exact reader name.
 * @param position - Initial position for a new reader.
 * @param activationId - Identifier for provisional writes that this activation may roll back.
 * @returns The stored position and any exclusive rollback authority.
 */
async function reserveCursor(
  q: TransactionQueryContext,
  owner: string,
  reader: ReaderName,
  position: number,
  activationId?: string,
): Promise<ReaderCursorReservation> {
  const { journalReaderCursors: cursors } = resolveSchema(q, journalStorageSchema);
  const created = activationId ?? null;
  const adopted = activationId === undefined ? null : `adopted:${activationId}`;
  // A same-owner registration shares the cursor and revokes exclusive rollback authority.
  const [row] = await q
    .insert(cursors)
    .values({ reader, position, owner, reservationToken: created })
    .onConflictDoUpdate({
      target: cursors.reader,
      set: {
        owner,
        reservationToken: sql`case when ${cursors.owner} is null then ${adopted} else null end`,
      },
      setWhere: or(isNull(cursors.owner), eq(cursors.owner, owner)),
    })
    .returning({ position: cursors.position, token: cursors.reservationToken });
  if (!row) {
    throw new JournalActivationError('reader-owner-conflict', owner, reader, 'The stored cursor has a different owner');
  }
  const change =
    row.token === null
      ? undefined
      : {
          token: row.token,
          kind: row.token === created ? ('created' as const) : ('adopted' as const),
        };
  return { reader, owner, position: row.position, change };
}

/**
 * Admit matching rows up to a committed high-water mark while preserving forward-only progress.
 * @param q - Query context with the reader cursor write lock.
 * @param reader - Name of the registered reader.
 * @param from - The current cursor position.
 * @param through - The highest position this sweep can admit.
 * @param patterns - Current validated subject patterns.
 * @param canSelect - Whether the reader may start writing this batch.
 * @returns The scan position, or the high-water mark when the sweep should stop.
 */
async function admitBatch(
  q: TransactionQueryContext,
  reader: ReaderName,
  from: number,
  through: number,
  patterns: readonly SubjectPattern[],
  canSelect: () => boolean,
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

  if (!canSelect()) return through;
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
   * Reserve a set of cursors atomically, adopting unowned cursors by exact name.
   * @param owner - Extension claiming the readers.
   * @param readers - Names and initial positions declared by the extension.
   * @returns Cursor positions and exclusive reservations for activation rollback.
   */
  public async initialize(
    owner: string,
    readers: readonly Pick<ReaderContribution, 'reader' | 'startAt'>[],
  ): Promise<readonly ReaderCursorReservation[]> {
    const declarations = readers
      .map(({ reader, startAt }) => ({ reader, startAt }))
      .sort((a, b) => (a.reader < b.reader ? -1 : Number(a.reader > b.reader)));
    const head = declarations.some(({ startAt }) => startAt !== 'beginning') ? await this.head() : 0;
    const activationId = randomUUID();
    return this.host.transaction(async (tx) => {
      const q = getTransactionQueryContext(tx);
      const reservations: ReaderCursorReservation[] = [];
      for (const { reader, startAt } of declarations) {
        reservations.push(await reserveCursor(q, owner, reader, startAt === 'beginning' ? 0 : head, activationId));
      }
      return reservations;
    });
  }

  /**
   * Undo newly created or adopted cursors from a failed activation.
   * @param reservations - Changes returned from that activation's reservation.
   */
  public async rollbackReservation(reservations: readonly ReaderCursorReservation[]): Promise<void> {
    if (reservations.length === 0) return;
    await this.host.transaction(async (tx) => {
      const q = getTransactionQueryContext(tx);
      const { journalReaderCursors: cursors } = resolveSchema(q, journalStorageSchema);
      for (const { reader, owner, position, change } of reservations) {
        if (!change) continue;
        const key = and(
          eq(cursors.reader, reader),
          eq(cursors.owner, owner),
          eq(cursors.position, position),
          eq(cursors.reservationToken, change.token),
        );
        if (change.kind === 'created') await q.delete(cursors).where(key);
        else await q.update(cursors).set({ owner: null, reservationToken: null }).where(key);
      }
    });
  }

  /**
   * Reestablish an active reader's ownership without skipping entries if its cursor disappeared.
   * @param cursor - Ownership and position observed when this run reserved the cursor.
   */
  public async restoreCursor({ reader, owner, position }: ReaderCursorReservation): Promise<void> {
    await this.host.transaction(async (tx) => {
      await reserveCursor(getTransactionQueryContext(tx), owner, reader, position);
    });
  }

  /**
   * Materialize the reader's states and advance its frontier atomically per batch.
   * A pattern change affects subsequent admissions and selections without rewinding the durable frontier.
   * @param reader - Name of the registered reader.
   * @param patterns - Current validated subject patterns.
   * @param canSelect - Whether the reader may admit more work.
   * @param owner - Expected owner when called by an active reader.
   */
  public async admit(
    reader: ReaderName,
    patterns: readonly SubjectPattern[],
    canSelect: () => boolean = () => true,
    owner?: string,
  ): Promise<void> {
    const head = await this.head();
    let position = 0;
    while (position < head) {
      position = await this.host.transaction(async (tx) => {
        const q = getTransactionQueryContext(tx);
        const from = await lockReader(q, reader, owner);
        if (from === undefined || from >= head) return head;
        return admitBatch(q, reader, from, head, patterns, canSelect);
      });
    }
  }

  /**
   * Acquire a single due entry.
   * @param reader - Name of the registered reader.
   * @param leaseMs - Maximum duration of the claim in milliseconds.
   * @param patterns - Current eligible subjects.
   * @param canSelect - Whether the reader may acquire new work.
   * @param owner - Expected owner when called by an active reader.
   * @returns The claim, if one was available.
   */
  public claim(
    reader: ReaderName,
    leaseMs: number,
    patterns?: readonly SubjectPattern[],
    canSelect?: () => boolean,
    owner?: string,
  ): Promise<ReaderClaim | undefined> {
    return claimEntry(this.host, reader, leaseMs, patterns, canSelect, owner);
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
