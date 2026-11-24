import { randomUUID } from 'node:crypto';
import type { HostDatabase, HostTransaction } from '@makaio/contracts';
import type { JournalEntry, ReaderName, ReaderOutcome, SubjectPattern } from '@makaio/contracts/journal';
import {
  getTransactionQueryContext,
  markTransactionWakeTopic,
  resolveSchema,
  type TransactionQueryContext,
} from '@makaio/storage-drizzle';
import {
  aliasedTable,
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { JOURNAL_ENTRIES_WAKE_TOPIC } from './append-entries.js';
import { READER_DEADLINE_REASON, ReaderCommitDeadlineExceeded, runReaderCommit } from './reader-commit.js';
import { selectSubjects, toJournalEntry } from './reader-queries.js';
import type { JournalReaderStateRow } from './schema.js';
import { journalStorageSchema } from './schema.variants.js';

/** Fenced ownership of one entry, valid until its deadline. */
export interface ReaderClaim {
  readonly reader: ReaderName;
  readonly entry: JournalEntry;
  readonly token: string;
  readonly retries: number;
  readonly expiresAt: number;
}

/** The declared reader outcomes and the host's own authorization refusal. */
export type ReaderAttemptOutcome = ReaderOutcome | { readonly state: 'denied' };

/** Delay before retrying an initial reader failure. */
export const READER_INITIAL_RETRY_DELAY_MS = 1_000;

const MAX_RETRY_DELAY_MS = 300_000;
const RETRY_DELAYS_MS = Array.from({ length: 9 }, (_, retries) => READER_INITIAL_RETRY_DELAY_MS * 2 ** retries);

/** Roll back effects when the contribution or the durable claim is no longer current. */
class LostReaderClaim extends Error {}

/** Roll back before recording an explicit permanent commit failure. */
class FailedReaderCommit extends Error {}

/**
 * Read wall-clock epoch milliseconds in the database statement.
 * @param q - Active dialect's query context.
 * @returns A clock usable in expiry conditions, including after lock waits.
 */
function databaseNow(q: TransactionQueryContext): SQL<number> {
  return q.dialect === 'postgres'
    ? sql<number>`floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint`
    : sql<number>`cast(round((julianday('now') - 2440587.5) * 86400000) AS integer)`;
}

/**
 * Serialize selection, admission and reprocessing for one reader, taking the write lock first on SQLite.
 * @param q - Query context of the current transaction.
 * @param reader - Name of the registered reader.
 * @returns The durable reader frontier, if initialized.
 */
export async function lockReader(q: TransactionQueryContext, reader: ReaderName): Promise<number | undefined> {
  const { journalReaderCursors: cursors } = resolveSchema(q, journalStorageSchema);
  const [row] = await q
    .update(cursors)
    .set({ position: sql`${cursors.position}` })
    .where(eq(cursors.reader, reader))
    .returning({ position: cursors.position });
  return row?.position;
}

/**
 * Match only open entries with no earlier open entry in the selected key stream.
 * @param q - Query context of the current transaction.
 * @param reader - Reader whose state is selected.
 * @param patterns - The current set of eligible subjects.
 * @returns A predicate over the reader-state and journal-entry tables.
 */
function streamHead(
  q: TransactionQueryContext,
  reader: ReaderName,
  patterns?: readonly SubjectPattern[],
): SQL | undefined {
  const { journalReaderStates: states, journalEntries: entries } = resolveSchema(q, journalStorageSchema);
  const before = aliasedTable(states, 'preceding_state');
  const precedingEntry = aliasedTable(entries, 'preceding_entry');
  const pending = q
    .select({ entryId: before.entryId })
    .from(before)
    .innerJoin(precedingEntry, eq(precedingEntry.entryId, before.entryId))
    .where(
      and(
        eq(before.reader, states.reader),
        eq(before.orderKey, states.orderKey),
        lt(before.position, states.position),
        eq(before.state, 'open'),
        selectSubjects(precedingEntry.subject, patterns),
      ),
    );

  return and(
    eq(states.reader, reader),
    eq(states.state, 'open'),
    selectSubjects(entries.subject, patterns),
    or(isNull(states.orderKey), notExists(pending)),
  );
}

/**
 * Select other claims for the current key, including a successor still handling when a failed row is requeued.
 * @param q - Query context of the current transaction.
 * @param states - Outer reading-state table.
 * @returns Predicate for other held claims and the corresponding alias.
 */
function heldKey(q: TransactionQueryContext, states: typeof journalStorageSchema.sqlite.journalReaderStates) {
  const held = aliasedTable(resolveSchema(q, journalStorageSchema).journalReaderStates, 'held_state');
  const condition = and(
    eq(held.reader, states.reader),
    eq(held.orderKey, states.orderKey),
    ne(held.position, states.position),
    eq(held.state, 'open'),
    isNotNull(held.claimExpiresAt),
  );
  return { held, condition };
}

/**
 * Turn expired claims into retries without using the old handler's result.
 * @param q - Query context of the selection or timeout recovery transaction.
 * @param reader - Reader whose leases can expire.
 * @param timedOut - Claim whose commit reached its local deadline and rolled back.
 */
async function expireClaims(q: TransactionQueryContext, reader: ReaderName, timedOut?: ReaderClaim): Promise<void> {
  const { journalReaderStates: states } = resolveSchema(q, journalStorageSchema);
  const delays = RETRY_DELAYS_MS.map((delay, retry) => sql`WHEN ${retry} THEN ${delay}`);
  await q
    .update(states)
    .set({
      retries: sql`${states.retries} + 1`,
      reason: READER_DEADLINE_REASON,
      notBefore: sql`${states.claimExpiresAt} + CAST(CASE ${states.retries} ${sql.join(delays, sql` `)} ELSE ${MAX_RETRY_DELAY_MS} END AS integer)`,
      claimToken: null,
      claimExpiresAt: null,
    })
    .where(
      and(
        eq(states.reader, reader),
        eq(states.state, 'open'),
        timedOut === undefined ? lte(states.claimExpiresAt, databaseNow(q)) : claimTokenMatches(states, timedOut),
      ),
    );
}

/**
 * Take the first currently due, unblocked entry for a reader.
 * @param host - Host database.
 * @param reader - Registered reader.
 * @param leaseMs - Duration of the claim.
 * @param patterns - Current eligible subjects.
 * @returns The entry and its claim, if one was available.
 */
export function claimEntry(
  host: HostDatabase,
  reader: ReaderName,
  leaseMs: number,
  patterns?: readonly SubjectPattern[],
): Promise<ReaderClaim | undefined> {
  return host.transaction(async (tx) => {
    const q = getTransactionQueryContext(tx);
    if ((await lockReader(q, reader)) === undefined) return undefined;
    await expireClaims(q, reader);
    const { journalReaderStates: states, journalEntries: entries } = resolveSchema(q, journalStorageSchema);
    const { held, condition } = heldKey(q, states);
    const otherClaim = q.select({ position: held.position }).from(held).where(condition);
    const [row] = await q
      .select({ entry: entries, retries: states.retries })
      .from(states)
      .innerJoin(entries, eq(states.entryId, entries.entryId))
      .where(
        and(
          streamHead(q, reader, patterns),
          isNull(states.claimToken),
          notExists(otherClaim),
          or(isNull(states.notBefore), lte(states.notBefore, databaseNow(q))),
        ),
      )
      .orderBy(asc(states.position))
      .limit(1);
    if (row === undefined) return undefined;

    const token = randomUUID();
    const expiresAt = Date.now() + leaseMs;
    await q
      .update(states)
      .set({ claimToken: token, claimExpiresAt: sql`${databaseNow(q)} + ${leaseMs}` })
      .where(and(eq(states.reader, reader), eq(states.entryId, row.entry.entryId)));
    return { reader, entry: toJournalEntry(row.entry), retries: row.retries, token, expiresAt };
  });
}

/**
 * Find the next due time among unblocked entries, expressed in the caller's clock.
 * @param host - Host database.
 * @param reader - Registered reader.
 * @param patterns - Current eligible subjects.
 * @returns An epoch deadline, or undefined when no open entry is eligible.
 */
export function nextClaimDue(
  host: HostDatabase,
  reader: ReaderName,
  patterns?: readonly SubjectPattern[],
): Promise<number | undefined> {
  return host.transaction(async (tx) => {
    const q = getTransactionQueryContext(tx);
    const { journalReaderStates: states, journalEntries: entries } = resolveSchema(q, journalStorageSchema);
    const now = databaseNow(q);
    const { held, condition } = heldKey(q, states);
    const latestClaim = q
      .select({ until: sql`max(${held.claimExpiresAt})` })
      .from(held)
      .where(condition);
    const latest = q.dialect === 'postgres' ? sql`greatest` : sql`max`;
    const ownDue = sql`coalesce(${states.claimExpiresAt}, ${states.notBefore}, ${now})`;
    const due = sql`${latest}(${ownDue}, coalesce((${latestClaim}), ${now}))`;
    const [row] = await q
      .select({ due: sql`min(${due}) - ${now}`.mapWith(Number) })
      .from(states)
      .innerJoin(entries, eq(entries.entryId, states.entryId))
      .where(streamHead(q, reader, patterns));
    return row?.due == null ? undefined : Date.now() + Math.max(0, row.due);
  });
}

/** Columns a settlement may update. */
type Settlement = Pick<JournalReaderStateRow, 'state' | 'retries' | 'reason'> & {
  readonly notBefore: number | SQL | null;
};

/**
 * Convert a handler result into a persisted state.
 * @param q - Query context of the settlement transaction.
 * @param claim - Claim holding previous retry information.
 * @param outcome - Result of this reader attempt.
 * @returns The durable changes to apply.
 */
function settlement(q: TransactionQueryContext, claim: ReaderClaim, outcome: ReaderAttemptOutcome): Settlement {
  const { retries } = claim;
  if (outcome.state === 'denied') return { state: 'done', retries, reason: 'access-denied', notBefore: null };
  if (outcome.state === 'done') return { state: 'done', retries, reason: null, notBefore: null };
  if (outcome.state === 'failed') return { state: 'failed', retries, reason: outcome.reason, notBefore: null };

  const requested = Date.parse(outcome.notBefore ?? '');
  const delay = RETRY_DELAYS_MS[retries] ?? MAX_RETRY_DELAY_MS;
  const notBefore = Number.isFinite(requested) ? requested : sql`${databaseNow(q)} + ${delay}`;
  return { state: 'open', retries: retries + 1, reason: outcome.reason, notBefore };
}

/**
 * Match the token of one claimed entry.
 * @param states - Reader state table for the current dialect.
 * @param claim - Ownership to fence.
 * @returns A predicate identifying the entry and token.
 */
function claimTokenMatches(states: typeof journalStorageSchema.sqlite.journalReaderStates, claim: ReaderClaim) {
  return and(eq(states.entryId, claim.entry.entryId), eq(states.claimToken, claim.token));
}

/**
 * Take the row lock before effect code runs, checking expiry again after any lock wait.
 * @param q - Query context of the settlement transaction.
 * @param claim - Ownership to fence.
 * @returns The deadline for effect code in the local clock.
 * @throws LostReaderClaim when the lease is stale.
 */
async function lockClaim(q: TransactionQueryContext, claim: ReaderClaim): Promise<number> {
  const { journalReaderStates: states } = resolveSchema(q, journalStorageSchema);
  const [updated] = await q
    .update(states)
    .set({ claimToken: claim.token })
    .where(
      and(
        eq(states.reader, claim.reader),
        eq(states.state, 'open'),
        claimTokenMatches(states, claim),
        gt(states.claimExpiresAt, databaseNow(q)),
      ),
    )
    .returning({ expiresAt: states.claimExpiresAt, now: databaseNow(q).mapWith(Number) });
  if (updated === undefined || updated.expiresAt === null || updated.expiresAt <= updated.now) {
    throw new LostReaderClaim();
  }
  return Math.min(claim.expiresAt, Date.now() + (updated.expiresAt - updated.now));
}

/**
 * Advance a fenced claim while still holding the row lock.
 * @param q - Query context of the settlement transaction.
 * @param claim - Ownership to fence.
 * @param changes - New durable reader state.
 * @throws LostReaderClaim when the token no longer matches.
 */
async function applySettlement(q: TransactionQueryContext, claim: ReaderClaim, changes: Settlement): Promise<void> {
  const { journalReaderStates: states } = resolveSchema(q, journalStorageSchema);
  const [updated] = await q
    .update(states)
    .set({ ...changes, claimToken: null, claimExpiresAt: null })
    .where(and(eq(states.reader, claim.reader), eq(states.state, 'open'), claimTokenMatches(states, claim)))
    .returning({ entryId: states.entryId });
  if (updated === undefined) throw new LostReaderClaim();
}

/**
 * Perform the optional extension effect in the fenced settlement transaction.
 * @param q - Query context of the settlement transaction.
 * @param tx - Host transaction passed to the commit callback.
 * @param claim - Ownership to fence.
 * @param outcome - Result of the handler or the host's authorization check.
 * @param isCurrent - Whether the registering generation is still active.
 */
async function commitOutcome(
  q: TransactionQueryContext,
  tx: HostTransaction,
  claim: ReaderClaim,
  outcome: ReaderAttemptOutcome,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) throw new LostReaderClaim();
  const expiresAt = await lockClaim(q, claim);
  if (!isCurrent()) throw new LostReaderClaim();
  if (outcome.state === 'done' && outcome.commit) {
    const result = await runReaderCommit(outcome.commit, tx, expiresAt);
    if (result?.state === 'failed') throw new FailedReaderCommit(result.reason);
  }
  if (!isCurrent()) throw new LostReaderClaim();
  await applySettlement(q, claim, settlement(q, claim, outcome));
  if (!isCurrent()) throw new LostReaderClaim();
  markTransactionWakeTopic(tx, JOURNAL_ENTRIES_WAKE_TOPIC);
}

/**
 * Store a result with its effect or roll back together before recording retry or failure.
 * @param host - Host database.
 * @param claim - Ownership to fence.
 * @param outcome - Result of the handler or the host's authorization check.
 * @param isCurrent - Whether the registering generation is still active.
 */
export async function settleClaim(
  host: HostDatabase,
  claim: ReaderClaim,
  outcome: ReaderAttemptOutcome,
  isCurrent: () => boolean,
): Promise<void> {
  try {
    await host.transaction((tx) => commitOutcome(getTransactionQueryContext(tx), tx, claim, outcome, isCurrent));
  } catch (error) {
    if (error instanceof LostReaderClaim) return;
    if (error instanceof ReaderCommitDeadlineExceeded) {
      // The effect transaction has rolled back. Retire only its original token
      // so a concurrent selector can safely discover expiration first.
      await host.transaction(async (tx) => {
        await expireClaims(getTransactionQueryContext(tx), claim.reader, claim);
        markTransactionWakeTopic(tx, JOURNAL_ENTRIES_WAKE_TOPIC);
      });
      return;
    }
    if (outcome.state !== 'done' || !outcome.commit) throw error;
    const fallback: ReaderOutcome =
      error instanceof FailedReaderCommit
        ? { state: 'failed', reason: error.message }
        : { state: 'retry', reason: 'reader-commit-error' };
    await settleClaim(host, claim, fallback, isCurrent);
  }
}
