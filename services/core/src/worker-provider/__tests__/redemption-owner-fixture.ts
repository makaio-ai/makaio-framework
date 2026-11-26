import { retireWorkerRunSessionOnCommit } from '../worker-run-sessions.js';
import { createHash, randomUUID } from 'node:crypto';
import { isMintedCallContext } from '@makaio/bus-core';
import type { HostDatabase, HostTransaction, JobRunId, JsonValue, Origin } from '@makaio/contracts';
import {
  JobRunEndingSchema,
  JobRunIdSchema,
  type JobRunCapability,
  type JobRunEnding,
  type JobRunErrorCode,
} from '@makaio/contracts/workflow';
import { isInProcessCaller, type PartyRef } from '@makaio/core';
import type { StorageDatabaseContext } from '@makaio/storage-conformance';
import {
  defineDialectSchema,
  defineDualTable,
  getTransactionQueryContext,
  markTransactionWakeTopic,
  resolveSchema,
  type RawSqlExecutor,
} from '@makaio/storage-drizzle';
import { deepFreeze } from '@makaio/utils';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appendEntries } from '../../journal/storage/append-entries.js';
import { journalStorageSchema } from '../../journal/storage/schema.variants.js';
import { digestWorkerBootstrapToken } from '../credential-digest.js';
import { hasOpenDeadline } from '../start-claim.js';
import type {
  CommittedWorkerOrder,
  StartOrder,
  StoredJobRunOutcome,
  StoredWorkerRedemption,
  WorkerOrderClose,
  AtomicRedemptionWorkerOrderSource,
  WorkerRedemptionCredentials,
} from '../start-order.js';

const timing = { maxRuntimeMs: 120_000, cancellationWindowMs: 10_000 };
// Isolate the test listener from other suites using the same PostgreSQL notification channel.
export const redemptionOwnerClosedTopic = `test-run-closed:${randomUUID()}`;

/** Test extension identity for terminal journal facts. */
export const redemptionJournalOwner = 'test.redemption-owner';
const endingSubject = `${redemptionJournalOwner}:ended`;

const endingFact = z.strictObject({ jobRunId: JobRunIdSchema, ending: JobRunEndingSchema });
type EndingFact = z.infer<typeof endingFact>;
type EndingOrigin = Pick<Origin, 'caller' | 'principal' | 'attestedBy'>;
type EndingWriter = (tx: HostTransaction, fact: EndingFact) => Promise<void>;

/**
 * Bind the test owner's declared subject to the real transaction-bound journal store.
 * @param origin - Provenance from the fixture's journal write context.
 * @returns Writer for the fixture's terminal fact.
 */
function bindEndingWriter({ caller, principal, attestedBy }: EndingOrigin): EndingWriter {
  const origin = { caller, principal, ...(attestedBy === undefined ? {} : { attestedBy }) };
  return async (tx, fact) => {
    const [outcome] = await appendEntries(getTransactionQueryContext(tx), {
      tx,
      extension: redemptionJournalOwner,
      subjects: {
        resolve: (subject) =>
          subject === endingSubject
            ? { recorded: true, owner: redemptionJournalOwner, schemaVersion: '1', payloadSchema: endingFact }
            : undefined,
      },
      entries: [{ subject: endingSubject, key: fact.jobRunId, orderKey: fact.jobRunId, payload: fact, origin }],
    });
    if (outcome?.status !== 'recorded') throw new Error('Expected a new terminal journal fact');
  };
}

/**
 * Read the fixture's terminal facts directly from the durable journal.
 * @param tx - Current host transaction.
 * @param id - Run to inspect.
 * @returns Validated facts from the test owner's subject and run ordering key.
 */
export async function readRedemptionOwnerEndings(tx: HostTransaction, id: JobRunId): Promise<EndingFact[]> {
  const query = getTransactionQueryContext(tx);
  const { journalEntries: table } = resolveSchema(query, journalStorageSchema);
  const facts = await query
    .select({ payload: table.payload })
    .from(table)
    .where(and(eq(table.extension, redemptionJournalOwner), eq(table.subject, endingSubject), eq(table.orderKey, id)));
  return facts.map(({ payload }) => endingFact.parse(payload));
}

const rows = defineDualTable('redemption_test_order', (c) => ({
  id: c.text('id').primaryKey(),
  state: c.text('state').$type<CommittedWorkerOrder['state']>().notNull(),
  booking: c
    .jsonCol<{
      order: StartOrder;
      owner: PartyRef;
      payload: JsonValue;
      identityRevocationKey?: string;
      includeDeadline?: true;
    }>('booking')
    .notNull(),
  tokenDigest: c.text('token_digest'),
  generation: c.text('generation').notNull(),
  revoked: c.bool('revoked').notNull(),
  stored: c.jsonCol<StoredWorkerRedemption>('stored'),
  cancellationDeadlineAt: c.text('cancellation_deadline_at'),
  ending: c.jsonCol<JobRunEnding>('ending'),
  receipt: c.jsonCol<StoredJobRunOutcome>('receipt'),
  effects: c.int4('effects').notNull().default(0),
}));
type OwnerRow = typeof rows.sqlite.$inferSelect;
const schema = defineDialectSchema({ rows: rows.sqlite }, { rows: rows.postgres });
const payload = { order: { inputs: ['first', 'second'] } };

/**
 * Read the booked digests without acquiring the database's write lock.
 * @param executor - Standalone database reader.
 * @param id - Order to look up.
 * @param signal - Lifetime of the credential read.
 * @returns The booked credential digests when redemption is enabled.
 */
async function readCredentials(
  executor: RawSqlExecutor,
  id: JobRunId,
  signal: AbortSignal,
): Promise<WorkerRedemptionCredentials | undefined> {
  signal.throwIfAborted();
  const [row] = await executor.all<{ token_digest: string | null; runtime_digest: string | null }>(sql`
    SELECT token_digest, stored ->> 'runtimeDigest' AS runtime_digest FROM redemption_test_order WHERE id = ${id}
  `);
  signal.throwIfAborted();
  return row?.token_digest == null
    ? undefined
    : { tokenDigest: row.token_digest, runtimeDigest: row.runtime_digest ?? undefined };
}

/**
 * Apply the test owner's private schema to the isolated host database.
 * @param context - Real storage conformance database.
 */
export async function migrateRedemptionOwner(
  context: Pick<StorageDatabaseContext, 'dialect' | 'executor'>,
): Promise<void> {
  const jsonType = sql.raw(context.dialect === 'postgres' ? 'jsonb' : 'text');
  const boolType = sql.raw(context.dialect === 'postgres' ? 'boolean' : 'integer');
  await context.executor.run(sql`
    CREATE TABLE redemption_test_order (
      id text PRIMARY KEY, state text NOT NULL, booking ${jsonType} NOT NULL, token_digest text,
      generation text NOT NULL, revoked ${boolType} NOT NULL, stored ${jsonType},
      cancellation_deadline_at text, ending ${jsonType},
      CHECK (id <> 'storage-reject' OR stored IS NULL)
    )
  `);
  await context.executor.run(sql`ALTER TABLE redemption_test_order ADD COLUMN receipt ${jsonType}`);
  await context.executor.run(sql`ALTER TABLE redemption_test_order ADD COLUMN effects integer NOT NULL DEFAULT 0`);
}

/**
 * Resolve the test owner's query surface inside a host transaction.
 * @param tx - Live owner transaction.
 */
function ownerStorage(tx: HostTransaction) {
  const query = getTransactionQueryContext(tx);
  return { query, table: resolveSchema(query, schema).rows };
}

/**
 * Inspect the test owner's row from a live transaction.
 * @param tx - Current storage transaction.
 * @param id - Stored order to read.
 * @returns The persisted row.
 */
export async function readRedemptionOwnerRow(tx: HostTransaction, id: JobRunId) {
  const { query, table } = ownerStorage(tx);
  const [row] = await query.select().from(table).where(eq(table.id, id));
  return row;
}

/**
 * Read the authoritative row under the same row lock used by all state transitions.
 * @param tx - Live owner transaction.
 * @param id - Order to read.
 */
async function lockRow(tx: HostTransaction, id: JobRunId) {
  const { query, table } = ownerStorage(tx);
  const match = eq(table.id, id);
  // PostgreSQL locks the row on read. SQLite serializes the owner transactions on the writer.
  const [row] = await query
    .select()
    .from(table)
    .where(query.dialect === 'postgres' ? sql`${match} FOR UPDATE` : match);
  return row;
}

/**
 * Write the single terminal transition and mark its commit notification.
 * @param tx - Transaction holding the authoritative run lock.
 * @param row - Locked snapshot of the run.
 * @param ending - Terminal input accepted by the test owner.
 * @param write - Journal writer for the lifecycle composition.
 */
async function closeLocked(
  tx: HostTransaction,
  row: OwnerRow,
  ending: JobRunEnding,
  write?: EndingWriter,
): Promise<void> {
  const { query, table } = ownerStorage(tx);
  await write?.(tx, { jobRunId: row.id, ending });
  await query.update(table).set({ state: 'closed', revoked: true, ending }).where(eq(table.id, row.id));
  retireAcceptedSession(tx, row);
  markTransactionWakeTopic(tx, redemptionOwnerClosedTopic);
}

/**
 * Retire the accepted generation of a run after its owner transaction commits.
 * @param tx - Live owner transaction.
 * @param row - Locked snapshot of the run.
 */
function retireAcceptedSession(tx: HostTransaction, row: OwnerRow): void {
  if (row.stored === null) return;
  retireWorkerRunSessionOnCommit(tx, { jobRunId: row.id, revocationKey: row.stored.accepted.revocationKey });
}

/**
 * Classify an elapsed deadline in a locked owner snapshot.
 * @param row - Locked snapshot of the run.
 * @returns The ending to persist, if the owner must close the run.
 */
function expiredEnding(row: OwnerRow): JobRunEnding | undefined {
  if (row.state === 'ordered' && !hasOpenDeadline(row.booking.order.bootstrapDeadlineAt)) {
    return { kind: 'no-result', outcome: 'lost', cause: 'bootstrap-expired' };
  }
  if (row.state !== 'redeemed' || row.stored === null) return undefined;
  const original = row.stored.accepted.expiresAt;
  const grace = row.cancellationDeadlineAt;
  // Both deadlines are canonical ISO timestamps written by this owner and redemption.
  if (grace !== null && grace < original && !hasOpenDeadline(grace)) {
    return { kind: 'no-result', outcome: 'cancelled', cause: 'cancellation-expired' };
  }
  if (!hasOpenDeadline(original)) {
    return { kind: 'no-result', outcome: grace === null ? 'lost' : 'cancelled', cause: 'result-expired' };
  }
  return undefined;
}

/**
 * Check result eligibility against the same locked snapshot used by expiry.
 * @param row - Locked snapshot of the run.
 * @param ending - Proposed result.
 * @returns The refusal code, if the result cannot close this run.
 */
function refuseResult(row: OwnerRow, ending: Extract<JobRunEnding, { kind: 'result' }>): JobRunErrorCode | undefined {
  if (ending.result.jobRunId !== row.id) return 'result-run-mismatch';
  if (row.state !== 'redeemed' || row.revoked || expiredEnding(row) !== undefined) return 'run-not-running';
  if ((ending.result.status === 'cancelled') !== (row.cancellationDeadlineAt !== null)) return 'ending-invalid';
  return undefined;
}

/**
 * Bind lifecycle operations to the same row used by the redemption source.
 * @param id - Booking owned by the fixture.
 * @param write - Writer required by the transactional close capability.
 */
function bindLifecycle(id: JobRunId, write: EndingWriter) {
  const capability: JobRunCapability = {
    async close(call, input) {
      const { tx, jobRunId } = input;
      const ending = structuredClone(input.ending);
      if (jobRunId !== id) throw new Error('run-unknown' satisfies JobRunErrorCode);
      const row = await lockRow(tx, jobRunId);
      if (row === undefined) throw new Error('run-unknown' satisfies JobRunErrorCode);
      if (
        !isMintedCallContext(call) ||
        !isInProcessCaller(call) ||
        row.booking.owner.kind !== call.caller.kind ||
        row.booking.owner.id !== call.caller.id
      ) {
        throw new Error('not-acceptance-owner' satisfies JobRunErrorCode);
      }
      if (row.state === 'closed') throw new Error('run-not-running' satisfies JobRunErrorCode);
      const refusal = ending.kind === 'result' ? refuseResult(row, ending) : undefined;
      if (refusal !== undefined) throw new Error(refusal);
      if (ending.kind === 'no-result' && row.state === 'redeemed') {
        if ((ending.outcome === 'cancelled') !== (row.cancellationDeadlineAt !== null)) {
          throw new Error('ending-invalid' satisfies JobRunErrorCode);
        }
      }
      await closeLocked(tx, row, ending, write);
    },
  };
  return {
    capability,
    /**
     * Request cancellation in a transaction that may already hold the lock.
     * @param tx - Caller-owned transaction.
     */
    async cancelIn(tx: HostTransaction) {
      const row = await lockRow(tx, id);
      if (row === undefined || row.state === 'closed') return;
      if (row.state === 'ordered') {
        await closeLocked(tx, row, { kind: 'no-result', outcome: 'cancelled', cause: 'cancel-requested' }, write);
      } else if (row.cancellationDeadlineAt === null && expiredEnding(row) === undefined) {
        const { query, table } = ownerStorage(tx);
        const deadline = new Date(Date.now() + timing.cancellationWindowMs).toISOString();
        await query.update(table).set({ cancellationDeadlineAt: deadline }).where(eq(table.id, id));
      }
    },
    /**
     * Let owner supervision close a run whose deadline has elapsed.
     * @param tx - Caller-owned transaction.
     */
    async expireIn(tx: HostTransaction) {
      const row = await lockRow(tx, id);
      if (row === undefined) return;
      const ending = expiredEnding(row);
      if (ending !== undefined) await closeLocked(tx, row, ending, write);
    },
  };
}

/**
 * Persist the accepted exchange on the ordered row and return the stored value.
 * @param tx - Transaction holding the run lock.
 * @param row - Ordered snapshot for the owning generation.
 * @param stored - Candidate durable acceptance.
 */
async function accept(tx: HostTransaction, row: OwnerRow, stored: StoredWorkerRedemption) {
  const { query, table } = ownerStorage(tx);
  const [winner] = await query
    .update(table)
    .set({ state: 'redeemed', stored })
    .where(
      and(eq(table.id, row.id), eq(table.generation, row.generation), eq(table.state, 'ordered'), isNull(table.stored)),
    )
    .returning({ stored: table.stored });
  return winner?.stored ?? undefined;
}

/**
 * Record a tentative owner effect that must roll back with a rejected result.
 * @param tx - Owner's transaction.
 * @param jobRunId - Authoritative run row.
 */
export async function noteTestOwnerEffect(tx: HostTransaction, jobRunId: JobRunId): Promise<void> {
  const { query, table } = ownerStorage(tx);
  await query
    .update(table)
    .set({ effects: sql`${table.effects} + 1` })
    .where(eq(table.id, jobRunId));
}

/**
 * Apply an authorized end inside the locked test owner's transaction.
 * @param tx - Owner transaction holding the run lock.
 * @param row - Locked authoritative row.
 * @param update - Terminal decision from the close authority.
 * @param options - Fixture journal and replay-proof policy.
 * @returns Whether the owner generation and state still permit the update.
 */
async function acceptOutcome(
  tx: HostTransaction,
  row: OwnerRow,
  update: WorkerOrderClose,
  options: TestOutcomeStorage,
) {
  const { query, table } = ownerStorage(tx);
  const result = update.kind === 'result';
  const ending: JobRunEnding = result ? { kind: 'result', result: update.receipt.result } : update;
  const [changed] = await query
    .update(table)
    .set({
      state: 'closed',
      ending,
      revoked: !(result && options.keepProof),
      receipt: result ? update.receipt : null,
    })
    .where(
      and(
        eq(table.id, row.id),
        eq(table.generation, row.generation),
        eq(table.state, row.state),
        isNull(table.receipt),
      ),
    )
    .returning({ id: table.id });
  if (changed === undefined) return false;
  await options.write(tx, { jobRunId: row.id, ending });
  markTransactionWakeTopic(tx, redemptionOwnerClosedTopic);
  return true;
}

interface TestOutcomeStorage {
  readonly write: EndingWriter;
  readonly keepProof: boolean;
}

/**
 * Add the real SQL outcome operations to the test source.
 * @param executor - Standalone reader against the same database.
 * @param token - Volatile bootstrap material.
 * @param origin - Journal provenance stamped by the owner.
 * @param keepProof - Whether this test deliberately keeps proof valid for replay.
 * @returns Order source using the same run lock for all transitions.
 */
export function testOutcomeOwnerSource(
  executor: RawSqlExecutor,
  token: string,
  origin: EndingOrigin,
  keepProof: boolean,
) {
  return redemptionOwnerSource(executor, token, { write: bindEndingWriter(origin), keepProof });
}

/**
 * Read the persisted test owner's booking and apply its conditional redemption.
 * @param executor - Standalone reader on the same database as the owner.
 * @param token - Volatile bootstrap material for the original dispatcher.
 * @param outcome - Optional outcome acceptance storage for the fixture.
 */
export function redemptionOwnerSource(
  executor: RawSqlExecutor,
  token: string,
  outcome?: TestOutcomeStorage,
): AtomicRedemptionWorkerOrderSource {
  return {
    readRedemptionCredentials: (runId, signal) => readCredentials(executor, runId, signal),
    async lockOrder(tx, id, signal) {
      signal?.throwIfAborted();
      const row = await lockRow(tx, id);
      signal?.throwIfAborted();
      if (row === undefined) return undefined;
      return {
        order: row.booking.order,
        owner: row.booking.owner,
        orderDigest: row.id,
        state: row.state,
        runtimeInputs: { workerManifest: { contributionRefs: [] } },
        ...(outcome && {
          outcome: {
            stored: row.receipt ?? undefined,
            resultDeadlineAt: row.stored?.accepted.expiresAt,
            cancellationDeadlineAt: row.cancellationDeadlineAt ?? undefined,
            accept: (ownerTx: HostTransaction, ending: WorkerOrderClose) =>
              acceptOutcome(ownerTx, row, ending, outcome),
          },
        }),
        redemption:
          row.tokenDigest === null
            ? undefined
            : {
                generation: row.generation,
                tokenDigest: row.tokenDigest,
                // Deny expired grace on reads without changing the original acceptance or closing the row.
                tokenRevoked:
                  row.revoked || (row.cancellationDeadlineAt !== null && !hasOpenDeadline(row.cancellationDeadlineAt)),
                issuerActive: true,
                identityRevocationKey: row.booking.identityRevocationKey,
                ...timing,
                preparePayload: (latestResultAt) =>
                  row.booking.includeDeadline ? { order: row.booking.payload, latestResultAt } : row.booking.payload,
                stored: row.stored ?? undefined,
                accept: (ownerTx, result) => accept(ownerTx, row, result),
              },
      };
    },
    hasStartToken: () => true,
    readStartToken: () => token,
  };
}

/**
 * Install an extension-owned order adapter against the production dispatch port.
 * @param database - Host transaction facade.
 * @param order - Booking admitted for the test owner.
 * @param owner - Identity of the test extension that owns the run.
 * @param token - Volatile bootstrap material.
 * @param legacy - Whether the original booking uses separate binding.
 * @param reply - Test order content when the owner includes the result deadline.
 */
export async function bookRedemptionOwner(
  database: HostDatabase,
  order: StartOrder,
  owner: PartyRef,
  token: string,
  legacy: boolean,
  reply?: JsonValue,
) {
  const tokenDigest = digestWorkerBootstrapToken(token);
  const booking = deepFreeze(
    structuredClone({
      order,
      owner,
      identityRevocationKey: randomUUID(),
      payload: reply ?? payload,
      ...(reply === undefined ? {} : { includeDeadline: true as const }),
    }),
  );
  const id = booking.order.jobRunId;
  await database.transaction(async (tx) => {
    const { query, table } = ownerStorage(tx);
    await query.insert(table).values({
      id,
      state: 'ordered',
      booking,
      tokenDigest: legacy ? null : tokenDigest,
      generation: 'initial',
      revoked: false,
    });
  });

  /**
   * Revoke the token under the owner lock inside a caller's transaction.
   * @param tx - Live owner transaction.
   */
  async function revokeIn(tx: HostTransaction): Promise<void> {
    const row = await lockRow(tx, id);
    const { query, table } = ownerStorage(tx);
    await query.update(table).set({ revoked: true }).where(eq(table.id, id));
    if (row !== undefined) retireAcceptedSession(tx, row);
  }

  /**
   * Read the owner's row in the same snapshot as the related dispatch.
   * @param tx - Current storage transaction.
   */
  async function readIn(tx: HostTransaction) {
    return readRedemptionOwnerRow(tx, id);
  }

  return {
    /**
     * Close the test run under its owner lock and return the committed issuer key.
     * @param origin - Provenance for the terminal journal fact.
     * @param rollback - Abort after writing the fact and terminal row.
     * @returns The issuer key only when the terminal transaction commits.
     */
    async closeForLocalInvalidation(origin: EndingOrigin, rollback: boolean): Promise<string | undefined> {
      const interrupted = new Error('Test terminal rollback');
      try {
        return await database.transaction(async (tx) => {
          const row = await lockRow(tx, id);
          if (row === undefined || row.state !== 'redeemed' || row.stored === null) {
            throw new Error('Expected a redeemed run under the owner lock');
          }
          const key = row.stored.accepted.revocationKey;
          const ending: JobRunEnding =
            row.cancellationDeadlineAt === null
              ? { kind: 'no-result', outcome: 'lost', cause: 'owner-closed' }
              : { kind: 'no-result', outcome: 'cancelled', cause: 'cancel-requested' };
          await closeLocked(tx, row, ending, bindEndingWriter(origin));
          if (rollback) throw interrupted;
          return key;
        });
      } catch (error) {
        if (error !== interrupted) throw error;
        return undefined;
      }
    },
    /**
     * Enable the transactional lifecycle with a fixture-owned journal writer.
     * @param origin - Provenance for the fixture's journal writes.
     */
    withJournal(origin: EndingOrigin) {
      return bindLifecycle(id, bindEndingWriter(origin));
    },
    async close() {
      await database.transaction(async (tx) => {
        const row = await lockRow(tx, id);
        if (row !== undefined && row.state !== 'closed') {
          await closeLocked(tx, row, { kind: 'no-result', outcome: 'lost', cause: 'owner-closed' });
        }
      });
    },

    /**
     * Use the same owner adapter with an independent reader over the same database.
     * @param executor - Reader on the host's database connection.
     */
    sourceFor(executor: RawSqlExecutor): AtomicRedemptionWorkerOrderSource {
      return redemptionOwnerSource(executor, token);
    },
    /**
     * Acquire the test owner's real run lock in an existing transaction.
     * @param tx - Live owner transaction.
     */
    async holdLock(tx: HostTransaction) {
      const row = await lockRow(tx, id);
      if (row === undefined) throw new Error('Test owner row is missing');
    },
    readIn,
    async read() {
      return database.transaction(readIn);
    },
    async enableRedemption() {
      await database.transaction(async (tx) => {
        await lockRow(tx, id);
        const { query, table } = ownerStorage(tx);
        await query.update(table).set({ tokenDigest }).where(eq(table.id, id));
      });
    },
    /** Persist the old untagged encoding to exercise real credential reads. */
    async storeUntaggedToken() {
      const untagged = createHash('sha256').update(token).digest('hex');
      await database.transaction(async (tx) => {
        await lockRow(tx, id);
        const { query, table } = ownerStorage(tx);
        await query.update(table).set({ tokenDigest: untagged }).where(eq(table.id, id));
      });
    },
    /**
     * Replace the stored runtime digest to exercise replay against real persisted legacy data.
     * @param runtimeDigest - Exact encoding to persist in the runtime credential slot.
     */
    async replaceRuntimeDigest(runtimeDigest: string) {
      await database.transaction(async (tx) => {
        const row = await lockRow(tx, id);
        if (row?.stored == null) throw new Error('Test owner has no stored acceptance');
        const { query, table } = ownerStorage(tx);
        await query
          .update(table)
          .set({ stored: { ...row.stored, runtimeDigest } })
          .where(eq(table.id, id));
      });
    },
    /**
     * Change only the issuer key on the locked booking.
     * @param key - Replacement key, or undefined to remove it.
     */
    async setIssuerIdentityKey(key: string | undefined) {
      await database.transaction(async (tx) => {
        const row = await lockRow(tx, id);
        if (row === undefined) throw new Error('Test owner row is missing');
        const { query, table } = ownerStorage(tx);
        await query
          .update(table)
          .set({ booking: { ...row.booking, identityRevocationKey: key } })
          .where(eq(table.id, id));
      });
    },
    async revoke() {
      await database.transaction(revokeIn);
    },
    /** Persist a direct owner revocation without its optional local notification. */
    async revokeWithoutNotification() {
      await database.transaction(async (tx) => {
        const row = await lockRow(tx, id);
        if (row?.state !== 'redeemed') throw new Error('Expected a redeemed run under the owner lock');
        const { query, table } = ownerStorage(tx);
        await query.update(table).set({ revoked: true }).where(eq(table.id, id));
      });
    },
    revokeIn,
    /**
     * Persist a change of owner without changing the credentials or generation.
     * @param nextOwner - Replacement owner for the booked run.
     */
    async transferTo(nextOwner: PartyRef) {
      const snapshot = Object.freeze({ ...nextOwner });
      await database.transaction(async (tx) => {
        const row = await lockRow(tx, id);
        if (row === undefined) throw new Error('Test owner row is missing');
        const { query, table } = ownerStorage(tx);
        await query
          .update(table)
          .set({ booking: { ...row.booking, owner: snapshot } })
          .where(eq(table.id, id));
      });
    },
  };
}
