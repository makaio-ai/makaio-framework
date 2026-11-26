import { createHash } from 'node:crypto';
import type { HostDatabase, HostTransaction, JobRunId, JsonValue } from '@makaio/contracts';
import type { PartyRef } from '@makaio/core';
import type { StorageDatabaseContext } from '@makaio/storage-conformance';
import {
  defineDialectSchema,
  defineDualTable,
  getTransactionQueryContext,
  resolveSchema,
  type RawSqlExecutor,
} from '@makaio/storage-drizzle';
import { deepFreeze } from '@makaio/utils';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { digestWorkerBootstrapToken } from '../credential-digest.js';
import type {
  CommittedWorkerOrder,
  StartOrder,
  StoredWorkerRedemption,
  AtomicRedemptionWorkerOrderSource,
  WorkerRedemptionCredentials,
} from '../start-order.js';

const rows = defineDualTable('redemption_test_order', (c) => ({
  id: c.text('id').primaryKey(),
  state: c.text('state').$type<CommittedWorkerOrder['state']>().notNull(),
  booking: c
    .jsonCol<{ order: StartOrder; owner: PartyRef; payload: JsonValue; includeDeadline?: true }>('booking')
    .notNull(),
  tokenDigest: c.text('token_digest'),
  generation: c.text('generation').notNull(),
  revoked: c.bool('revoked').notNull(),
  stored: c.jsonCol<StoredWorkerRedemption>('stored'),
}));
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
      CHECK (id <> 'storage-reject' OR stored IS NULL)
    )
  `);
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
 * Persist the accepted exchange on the ordered row and return the stored value.
 * @param tx - Transaction holding the run lock.
 * @param row - Ordered snapshot for the owning generation.
 * @param stored - Candidate durable acceptance.
 */
async function accept(tx: HostTransaction, row: typeof rows.sqlite.$inferSelect, stored: StoredWorkerRedemption) {
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
 * Read the persisted test owner's booking and apply its conditional redemption.
 * @param executor - Standalone reader on the same database as the owner.
 * @param token - Volatile bootstrap material for the original dispatcher.
 */
export function redemptionOwnerSource(executor: RawSqlExecutor, token: string): AtomicRedemptionWorkerOrderSource {
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
        redemption:
          row.tokenDigest === null
            ? undefined
            : {
                generation: row.generation,
                tokenDigest: row.tokenDigest,
                tokenRevoked: row.revoked,
                issuerActive: true,
                maxRuntimeMs: 120_000,
                cancellationWindowMs: 10_000,
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
    await lockRow(tx, id);
    const { query, table } = ownerStorage(tx);
    await query.update(table).set({ revoked: true }).where(eq(table.id, id));
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
    async close() {
      await database.transaction(async (tx) => {
        await lockRow(tx, id);
        const { query, table } = ownerStorage(tx);
        await query.update(table).set({ state: 'closed', revoked: true }).where(eq(table.id, id));
      });
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
    async revoke() {
      await database.transaction(revokeIn);
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
