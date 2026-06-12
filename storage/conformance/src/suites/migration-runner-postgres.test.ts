/**
 * Migration-runner conformance suite — Postgres-specific invariants.
 *
 * All content is gated on `config.dialect === 'postgres'` so the file
 * runs under any dialect selection but skips cleanly on SQLite.
 *
 * Covers:
 * 1. Concurrent-runner serialization (apply window): two sibling clients race
 *    to apply the same migration; exactly one ledger row results. The race is
 *    made deterministic by a third client that pre-holds the advisory lock
 *    (see raceRunnersBehindHeldLock), so the loser always exercises the
 *    in-lock recheck rather than the run-level snapshot.
 * 2. Concurrent-runner serialization (post-adoption-ROLLBACK window): both
 *    runners hit the adoption path (pre-created table); the gap-recheck under
 *    the fresh advisory lock prevents a duplicate ledger INSERT.
 * 3. Isolation pin: ambient REPEATABLE READ setting does not break the
 *    in-lock recheck — the explicit BEGIN ISOLATION LEVEL READ COMMITTED pin
 *    keeps the loser's recheck snapshot post-lock-acquisition.
 * 4. Canceled / timed-out advisory-lock wait: a timed-out lock wait leaves
 *    the pooled session in a usable (non-aborted) state because the runner
 *    combines the lock-failure cleanup with the executor's release(true)
 *    guarantee.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { MigrationMeta } from '@makaio/storage-migrations';
import {
  applyMigrations,
  buildBeginTransactionStatement,
  migrationAdvisoryLockKey,
  resolveDefaultMigrationsTable,
} from '@makaio/storage-migrations/apply-migrations';
import type { SiblingClient, StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { fixtureMigration } from '../harness/fixture-migrations.js';

// ---------------------------------------------------------------------------
// Helper: walk the cause chain collecting non-standard `code` properties
// ---------------------------------------------------------------------------

/**
 * Walk the full cause chain of an error and collect every string `code`
 * property found on any link.
 *
 * Driver errors (node-postgres `DatabaseError`) carry SQLSTATE codes as a
 * non-standard string `code` property. Walking the chain is necessary because
 * the runner may wrap driver errors in higher-level `Error` instances.
 * @param err - Top-level error (or arbitrary thrown value) to inspect.
 * @returns Array of SQLSTATE/driver code strings found anywhere in the chain.
 */
function findCodeInCauseChain(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    const { code } = current as Error & { code?: unknown };
    if (typeof code === 'string') {
      codes.push(code);
    }
    current = current.cause;
  }
  return codes;
}

// ---------------------------------------------------------------------------
// Helper: deterministic two-runner race behind a held advisory lock
// ---------------------------------------------------------------------------

/**
 * Race two fresh sibling runners over the same single-migration list while a
 * third client initially holds the migration advisory lock.
 *
 * Without coordination the loser frequently sees the winner's commit in its
 * ordinary ledger snapshot and the in-lock recheck windows are exercised only
 * probabilistically. The holder forces the interleaving the recheck cases pin:
 *
 * 1. The holder takes the advisory lock inside an open transaction.
 * 2. Both runners start; their ledger-snapshot transactions enqueue on the
 *    lock (verified via pg_locks, scoped to the runners' backend pids).
 * 3. The holder commits. Postgres grants heavyweight locks in queue order, so
 *    both runners snapshot an empty ledger before either apply transaction
 *    acquires the lock — the loser therefore always decides inside its apply
 *    transaction (in-lock recheck / post-adoption gap recheck), never via the
 *    run-level snapshot.
 * @param ctx - Suite database context (pg_locks polling and sibling creation).
 * @param migration - Migration both runners race to apply.
 * @param postgresSettings - Extra GUC settings for the two runner siblings.
 * @returns Settlement results of runner A and runner B.
 */
async function raceRunnersBehindHeldLock(
  ctx: StorageDatabaseContext,
  migration: MigrationMeta,
  postgresSettings?: Readonly<Record<string, string>>,
): Promise<[PromiseSettledResult<void>, PromiseSettledResult<void>]> {
  const lockKeyStr = migrationAdvisoryLockKey(resolveDefaultMigrationsTable('postgres')).toString();

  const [sibA, sibB, sibHolder] = await Promise.all([
    ctx.createSiblingClient({ poolMax: 1, postgresSettings }),
    ctx.createSiblingClient({ poolMax: 1, postgresSettings }),
    ctx.createSiblingClient({ poolMax: 1 }),
  ]);

  // Pin the runner backend pids: the advisory key is derived from the ledger
  // table name and is therefore shared database-wide, so the pg_locks poll
  // below must count exactly these two sessions and no concurrent suite's.
  const backendPid = async (sib: SiblingClient): Promise<number> => {
    const rows = await sib.executor.all<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
    return rows[0]!.pid;
  };
  const [pidA, pidB] = await Promise.all([backendPid(sibA), backendPid(sibB)]);

  let resolveRelease!: () => void;
  const waitForRelease = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  let resolveLockHeld!: () => void;
  const waitForLockHeld = new Promise<void>((resolve) => {
    resolveLockHeld = resolve;
  });

  const holderPromise = sibHolder.executor.withSession(async (s) => {
    await s.run(sql.raw(buildBeginTransactionStatement('postgres')));
    await s.run(sql`SELECT pg_advisory_xact_lock(CAST(${lockKeyStr} AS bigint))`);
    // The lock statement resolving IS the synchronization point.
    resolveLockHeld();
    await waitForRelease;
    await s.run(sql.raw('COMMIT'));
  });

  let racers: Array<Promise<void>> = [];
  try {
    // Race against the holder promise so a holder failure surfaces instead of
    // hanging the lock-held wait forever.
    await Promise.race([waitForLockHeld, holderPromise]);

    racers = [applyMigrations(sibA.db, [migration]), applyMigrations(sibB.db, [migration])];

    // Wait on the database's own lock queue (not wall-clock guesses) until
    // both runners are enqueued behind the holder.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const rows = await ctx.executor.all<{ waiting: number | string }>(
        sql`SELECT count(*) AS waiting FROM pg_locks
            WHERE locktype = 'advisory' AND granted = false AND pid IN (${pidA}, ${pidB})`,
      );
      if (Number(rows[0]?.waiting) === 2) break;
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for both runners to enqueue on the migration advisory lock');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    resolveRelease();
    const results = await Promise.allSettled(racers);
    return [results[0]!, results[1]!];
  } catch (error) {
    // Prevent unhandled rejections from in-flight runners when the setup fails.
    for (const racer of racers) {
      racer.catch(() => undefined);
    }
    throw error;
  } finally {
    // Always release the holder: a failure above must not leave the advisory
    // lock held, which would wedge afterAll's DROP SCHEMA behind it.
    resolveRelease();
    await holderPromise;
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('migration-runner-postgres', (config) => {
  // Gate: all cases in this file are Postgres-only.
  const describePg = config.dialect === 'postgres' ? describe : describe.skip;

  const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: false });

  // -------------------------------------------------------------------------
  // Case 1: Concurrent-runner serialization — apply window
  //
  // Both runners reach applyMigrations concurrently with a migration whose
  // table does NOT yet exist. The held-lock interleaving guarantees both
  // snapshot an empty ledger, so the loser decides inside its apply
  // transaction: the in-lock ledger recheck (skipIfRecordedByConcurrentRunner)
  // finds the winner's committed row and skips cleanly. Result: exactly one
  // ledger row, no duplicate-object error.
  // -------------------------------------------------------------------------
  describePg('concurrent-runner serialization — apply window', () => {
    const mConcurrent = fixtureMigration(
      '0001_concurrent_apply',
      ['CREATE TABLE pg_conc_apply_t1 (id text PRIMARY KEY)'],
      0,
    );

    it('both runners fulfill; table exists; exactly 1 ledger row', async () => {
      const ctx = getCtx();
      const results = await raceRunnersBehindHeldLock(ctx, mConcurrent);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');

      // Table must exist.
      const tableRows = await ctx.executor.all<{ exists: string | null }>(
        sql`SELECT to_regclass(${'pg_conc_apply_t1'}) AS exists`,
      );
      expect(tableRows[0]?.exists).not.toBeNull();

      // Exactly one ledger row.
      const defaultLedger = resolveDefaultMigrationsTable('postgres');
      const ledgerId = sql.identifier(defaultLedger);
      const ledgerRows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${ledgerId} WHERE hash = ${mConcurrent.hash}`,
      );
      expect(ledgerRows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: Concurrent-runner serialization — post-adoption-ROLLBACK window
  //
  // The table is pre-created so BOTH runners take the adoption path. The
  // adoption path issues ROLLBACK (releasing the advisory lock) before
  // recording in a fresh transaction. The held-lock interleaving guarantees
  // both runners enter adoption with an empty snapshot, so the loser's gap
  // recheck under the fresh lock is what prevents the duplicate INSERT that
  // would violate the UNIQUE(hash) constraint.
  // -------------------------------------------------------------------------
  describePg('concurrent-runner serialization — post-adoption-ROLLBACK window', () => {
    const adoptDdl = 'CREATE TABLE pg_conc_adopt_t1 (id text PRIMARY KEY)';
    const mAdopt = fixtureMigration('0001_concurrent_adopt', [adoptDdl], 10);

    it('pre-creates table; both runners fulfill via adoption; exactly 1 ledger row', async () => {
      const ctx = getCtx();
      // Pre-create the table so both runners enter the adoption path.
      await ctx.executor.run(sql.raw(adoptDdl));

      const results = await raceRunnersBehindHeldLock(ctx, mAdopt);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');

      const defaultLedger = resolveDefaultMigrationsTable('postgres');
      const ledgerId = sql.identifier(defaultLedger);
      const ledgerRows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${ledgerId} WHERE hash = ${mAdopt.hash}`,
      );
      expect(ledgerRows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: Isolation pin under ambient REPEATABLE READ
  //
  // Both runner siblings are created with default_transaction_isolation =
  // repeatable read. Without the explicit BEGIN ISOLATION LEVEL READ COMMITTED
  // pin in the runner, the loser's transaction would take its snapshot at the
  // pg_advisory_xact_lock SELECT — before lock-wait completion — and the
  // in-lock recheck would miss the winner's committed ledger row, causing a
  // re-apply.
  //
  // The fixture is deliberately MULTI-statement: a re-applied single-statement
  // CREATE would be silently rescued by the adoption path (ROLLBACK + fresh
  // lock + gap recheck), making the pin's absence externally invisible. A
  // multi-statement migration refuses adoption ('Cannot adopt multi-statement
  // migration'), so a stale-snapshot re-apply rejects and this case goes red
  // exactly when the pin is dropped.
  //
  // With the pin: loser gets READ COMMITTED, recheck sees the committed row,
  // skips cleanly. Test validates:
  // (a) the harness joint: the setting actually reached the sibling session.
  // (b) the business invariant: both settle fulfilled, exactly 1 ledger row.
  // -------------------------------------------------------------------------
  describePg('isolation pin: explicit READ COMMITTED survives ambient REPEATABLE READ', () => {
    const mIsolation = fixtureMigration(
      '0001_isolation_pin',
      ['CREATE TABLE pg_isol_pin_t1 (id text PRIMARY KEY)', 'CREATE INDEX idx_pg_isol_pin_t1 ON pg_isol_pin_t1 (id)'],
      20,
    );
    const rrSettings = { default_transaction_isolation: 'repeatable read' } as const;

    it('sibling connection actually carries repeatable read (guards the harness joint)', async () => {
      const sib = await getCtx().createSiblingClient({ poolMax: 1, postgresSettings: rrSettings });
      const rows = await sib.executor.all<{ setting: string }>(
        sql`SELECT current_setting('default_transaction_isolation') AS setting`,
      );
      expect(rows[0]?.setting).toBe('repeatable read');
    });

    it('both RR runners settle fulfilled; exactly 1 ledger row', async () => {
      const ctx = getCtx();
      const results = await raceRunnersBehindHeldLock(ctx, mIsolation, rrSettings);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');

      const defaultLedger = resolveDefaultMigrationsTable('postgres');
      const ledgerId = sql.identifier(defaultLedger);
      const ledgerRows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${ledgerId} WHERE hash = ${mIsolation.hash}`,
      );
      expect(ledgerRows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: Canceled / timed-out advisory-lock wait
  //
  // This case pins the combined invariant:
  //   (a) A timed-out pg_advisory_xact_lock wait rejects with SQLSTATE 57014
  //       (query_canceled / statement_timeout), NOT 25P02 (in_failed_sql_transaction).
  //   (b) The runner's lock-failure cleanup (ROLLBACK inside beginMigrationTransaction)
  //       combined with the executor's release(true) guarantee leaves the pooled
  //       connection usable — a follow-up SELECT 1 and a fresh applyMigrations
  //       both succeed.
  //
  // Setup:
  //   H (holder, poolMax 1) checks out a session, opens a READ COMMITTED
  //   transaction, and takes the advisory lock with pg_advisory_xact_lock.
  //   It holds the lock until a deferred promise is resolved.
  //
  //   W (waiter, poolMax 1, statement_timeout 500ms) calls applyMigrations.
  //   W's lock wait exceeds the timeout and is canceled.
  //
  //   After validating the rejection, we resolve the deferred so H commits
  //   and releases, then assert W's client is still usable and applyMigrations
  //   now succeeds with exactly 1 ledger row.
  // -------------------------------------------------------------------------
  describePg('canceled/timed-out advisory-lock wait', () => {
    const mLock = fixtureMigration('0001_lock_timeout', ['CREATE TABLE pg_lock_wait_t1 (id text PRIMARY KEY)'], 30);

    it('rejects with SQLSTATE 57014; no 25P02; client remains usable; retry succeeds', async () => {
      const ctx = getCtx();
      const defaultLedger = resolveDefaultMigrationsTable('postgres');

      // Deferreds: H signals once it holds the lock; the test signals release.
      let resolveRelease!: () => void;
      const waitForRelease = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      let resolveLockHeld!: () => void;
      const waitForLockHeld = new Promise<void>((resolve) => {
        resolveLockHeld = resolve;
      });

      // Sibling H: holder. poolMax 1 ensures the advisory lock is taken on the
      // only available connection (which stays checked out for the full hold).
      const sibH = await ctx.createSiblingClient({ poolMax: 1 });

      // Sibling W: waiter with a 500 ms statement_timeout so its lock wait
      // is canceled quickly and predictably.
      const sibW = await ctx.createSiblingClient({
        poolMax: 1,
        postgresSettings: { statement_timeout: '500' },
      });

      const lockKey = migrationAdvisoryLockKey(defaultLedger);
      const lockKeyStr = lockKey.toString();

      // H acquires the advisory lock and holds it until waitForRelease resolves.
      const holderPromise = sibH.executor.withSession(async (s) => {
        await s.run(sql.raw(buildBeginTransactionStatement('postgres')));
        await s.run(sql`SELECT pg_advisory_xact_lock(CAST(${lockKeyStr} AS bigint))`);
        // The lock statement resolving IS the synchronization point: once it
        // returns, W's lock wait is guaranteed to contend. No wall-clock guess.
        resolveLockHeld();
        await waitForRelease;
        await s.run(sql.raw('COMMIT'));
      });

      try {
        // Race against the holder promise so a holder failure surfaces
        // instead of hanging the lock-held wait forever.
        await Promise.race([waitForLockHeld, holderPromise]);

        // W attempts to apply — it will block on the advisory lock and time out.
        let waiterError: unknown;
        try {
          await applyMigrations(sibW.db, [mLock]);
        } catch (err) {
          waiterError = err;
        }

        // (a) W must have rejected.
        expect(waiterError).toBeDefined();

        // (a) The cause chain must contain SQLSTATE 57014 (query_canceled /
        //     statement_timeout). This is the direct signal that the rejection
        //     originated from the lock-wait timeout, not from a subsequent
        //     statement running inside an aborted transaction (25P02).
        const codes = findCodeInCauseChain(waiterError);
        expect(codes).toContain('57014');

        // (a) The cause chain must NOT contain 25P02 (in_failed_sql_transaction).
        //     25P02 would mean the runner failed to clean up the aborted
        //     transaction before re-entering the pool, poisoning the connection.
        expect(codes).not.toContain('25P02');
      } finally {
        // Always release H: a failing assertion above must not leave the
        // advisory lock held in an open transaction, which would wedge
        // afterAll's DROP SCHEMA cleanup (leaking the conformance schema) and
        // mask the real assertion failure with a timeout.
        resolveRelease();
        // Await the holder's session so its connection returns to the pool
        // before we probe W's client.
        await holderPromise;
      }

      // (b) W's client must be usable after the timeout — a simple SELECT 1
      //     must succeed (no "current transaction is aborted" error).
      await expect(sibW.executor.run(sql`SELECT 1`)).resolves.toBeDefined();

      // (b) A fresh applyMigrations on W must now succeed end-to-end with
      //     exactly 1 ledger row.
      await applyMigrations(sibW.db, [mLock]);

      const ledgerId = sql.identifier(defaultLedger);
      const ledgerRows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${ledgerId} WHERE hash = ${mLock.hash}`,
      );
      expect(ledgerRows).toHaveLength(1);
    });
  });
});
