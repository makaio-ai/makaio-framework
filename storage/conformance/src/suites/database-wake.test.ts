/**
 * Conformance suite: the database wake seam (`markTransactionWakeTopic`,
 * `getHostDatabaseWake`, and the per-client `DatabaseSignals` capability).
 *
 * Covers: local after-commit delivery (ordering, dedupe, unsubscribe, several
 * facades of one handle sharing delivery); rollback and listener-error
 * isolation; `HostTransaction` authorization of marking; the capability each
 * SQLite/libsql target and an unbound handle declare; and, Postgres only,
 * cross-connection delivery, reconnect/resync, topic validation, and
 * close()/lifecycle guarantees.
 *
 * One subtlety threads through every case that subscribes on the SAME handle
 * a transaction commits on: on Postgres that handle's own commit both
 * delivers locally (right after the commit) AND notifies its own listener
 * connection (the database's NOTIFY echo) — both are legitimate wakes, by
 * design (see `host-database-wake.ts`), so a listener there may observe one
 * or two deliveries per commit. SQLite/libsql only ever deliver locally.
 * Cases that subscribe on a DIFFERENT handle than the one that commits (the
 * Postgres cross-connection/reconnect cases) have no such ambiguity: exactly
 * one delivery per commit.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { inArray, sql } from 'drizzle-orm';
import {
  bindDatabaseSignals,
  createHostDatabase,
  getDatabaseSignals,
  getHostDatabaseWake,
  getTransactionQueryContext,
  HostTransactionError,
  markTransactionWakeTopic,
  releaseHostDatabaseWake,
  resolveSchema,
  type DatabaseSignal,
  type DatabaseSignals,
  type MakaioDatabase,
  type StorageDialect,
} from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import type { HostTransaction } from '@makaio/contracts/host-database';
import { describeStorageConformance, STORAGE_TEST_URL_ENV } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { ensurePostgresEngineRegistered } from '../harness/postgres-config.js';
import { fixtureKvDdl, fixtureKv, type conformanceKvSqlite } from '../harness/fixture-table.js';
import type { StorageDatabaseContext } from '../harness/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical (SQLite view) fixture table type the builders are created from. */
type KvTable = typeof conformanceKvSqlite;

/**
 * Unique id per case so cases never see each other's rows or topics.
 * @param prefix - Human-readable case prefix.
 * @returns A unique id.
 */
function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Wait for the given time, letting pending macrotasks (and, on Postgres, a
 * NOTIFY round trip) run.
 * @param ms - Milliseconds to wait.
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the stored rows with the given ids through a plain handle, ordered by id.
 * @param db - Handle to read through.
 * @param ids - Row ids to read.
 * @returns The rows that exist, ordered by id.
 */
async function readRows(db: MakaioDatabase, ids: readonly string[]) {
  const { kv } = resolveSchema(db, fixtureKv);
  return db
    .select()
    .from(kv)
    .where(inArray(kv.id, [...ids]))
    .orderBy(kv.id);
}

/**
 * Insert one fixture row through a host transaction's query context.
 * @param context - Query context of the owning transaction.
 * @param kv - Fixture table.
 * @param id - Id of the row to insert.
 * @param label - Label to store on the row.
 */
async function insertFixtureRow(
  context: ReturnType<typeof getTransactionQueryContext>,
  kv: KvTable,
  id: string,
  label: string,
): Promise<void> {
  await context.insert(kv).values({ id, label, payload: {} });
}

/**
 * A one-shot latch: `opened` settles once `open()` was called. Used to hold a
 * transaction callback open across an assertion made from outside it.
 */
interface Gate {
  /** Resolves after {@link Gate.open}. */
  readonly opened: Promise<void>;
  /** Open the gate. Idempotent. */
  open(): void;
}

/**
 * Create a closed gate.
 * @returns A gate whose `opened` promise resolves after `open()`.
 */
function createGate(): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

/**
 * Counts invocations of a wake listener and exposes a promise that resolves
 * once it has fired at least once. The single driver every delivery
 * assertion in this suite goes through: no case re-implements its own call
 * counting.
 */
interface CallTracker {
  /** Pass directly as a `WakeListener`. */
  readonly listener: () => void;
  /** Resolves once {@link CallTracker.listener} has been invoked at least once. */
  readonly firstCall: Promise<void>;
  /** Number of times the listener has fired so far. */
  count(): number;
}

/**
 * Create a fresh call tracker.
 * @returns A tracker whose `listener` can be registered with `subscribe`/`onResync`.
 */
function createCallTracker(): CallTracker {
  let calls = 0;
  let resolveFirst: () => void = () => undefined;
  const firstCall = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  return {
    listener: () => {
      calls += 1;
      resolveFirst();
    },
    firstCall,
    count: () => calls,
  };
}

/**
 * Wait for a tracker's first delivery, then settle for a dialect-appropriate
 * grace window so a Postgres NOTIFY echo (see the suite's header note) has a
 * chance to arrive before the count is read.
 * @param tracker - Tracker to observe.
 * @param dialect - Dialect of the handle the tracker is subscribed on.
 * @returns The call count once settled.
 */
async function settledDeliveryCount(tracker: CallTracker, dialect: StorageDialect): Promise<number> {
  await tracker.firstCall;
  await delay(dialect === 'postgres' ? 300 : 30);
  return tracker.count();
}

/**
 * Assert that a tracker delivered on a handle that may receive both a local
 * and an echoed delivery for the one commit under test: at least one
 * delivery, never more than two (dedupe still holds — it never scales with
 * how many times a topic was marked).
 * @param tracker - Tracker to assert on.
 * @param dialect - Dialect of the handle the tracker is subscribed on.
 */
async function expectDeliveredOnceOrTwice(tracker: CallTracker, dialect: StorageDialect): Promise<void> {
  const count = await settledDeliveryCount(tracker, dialect);
  expect(count).toBeGreaterThanOrEqual(1);
  expect(count).toBeLessThanOrEqual(2);
}

/**
 * Assert that a {@link HostTransactionError} with the given code was thrown.
 * @param run - Operation to execute.
 * @param code - Expected machine-readable code.
 */
function expectHostTransactionErrorCode(run: () => void, code: HostTransactionError['code']): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostTransactionError);
  expect(caught).toMatchObject({ code });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('database wake', (config) => {
  const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: false });

  beforeAll(async () => {
    const ctx = getCtx();
    await ctx.executor.run(sql.raw(fixtureKvDdl(ctx.dialect)));
  });

  // ─── Local after-commit wake ─────────────────────────────────────────────

  describe('local after-commit wake', () => {
    it('delivers only after the transaction committed, and the listener can then read the row', async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const hostDb = createHostDatabase(ctx.db);
      const wake = getHostDatabaseWake(hostDb);
      const topic = uniqueId('wake-after-commit');
      const rowId = uniqueId('wake-after-commit-row');
      const tracker = createCallTracker();
      let readAfterDelivery: Promise<unknown> | undefined;
      const unsubscribe = wake.subscribe(topic, () => {
        tracker.listener();
        readAfterDelivery ??= readRows(ctx.db, [rowId]);
      });
      const entered = createGate();
      const release = createGate();

      try {
        const txPromise = hostDb.transaction(async (tx) => {
          markTransactionWakeTopic(tx, topic);
          await insertFixtureRow(getTransactionQueryContext(tx), kv, rowId, 'after-commit');
          entered.open();
          await release.opened;
        });

        await entered.opened;
        expect(tracker.count()).toBe(0);
        release.open();
        await txPromise;

        await expectDeliveredOnceOrTwice(tracker, ctx.dialect);
        expect(await readAfterDelivery).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    });

    it('dedupes a topic marked more than once on the same transaction', async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const hostDb = createHostDatabase(ctx.db);
      const wake = getHostDatabaseWake(hostDb);
      const topic = uniqueId('wake-dedupe');
      const rowId = uniqueId('wake-dedupe-row');
      const tracker = createCallTracker();
      const unsubscribe = wake.subscribe(topic, tracker.listener);

      try {
        await hostDb.transaction(async (tx) => {
          markTransactionWakeTopic(tx, topic);
          markTransactionWakeTopic(tx, topic);
          markTransactionWakeTopic(tx, topic);
          await insertFixtureRow(getTransactionQueryContext(tx), kv, rowId, 'dedupe');
        });

        // Dedupe means "never more than the one-or-two-origin bound", not
        // "exactly one": a single mark-three-times transaction must behave
        // identically to a single mark-once transaction.
        await expectDeliveredOnceOrTwice(tracker, ctx.dialect);
      } finally {
        unsubscribe();
      }
    });

    it('stops delivery after unsubscribe', async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const hostDb = createHostDatabase(ctx.db);
      const wake = getHostDatabaseWake(hostDb);
      const topic = uniqueId('wake-unsubscribe');
      const rowId = uniqueId('wake-unsubscribe-row');
      const tracker = createCallTracker();
      const unsubscribe = wake.subscribe(topic, tracker.listener);
      unsubscribe();

      await hostDb.transaction(async (tx) => {
        markTransactionWakeTopic(tx, topic);
        await insertFixtureRow(getTransactionQueryContext(tx), kv, rowId, 'unsubscribed');
      });

      await delay(ctx.dialect === 'postgres' ? 300 : 30);
      expect(tracker.count()).toBe(0);
    });

    it('delivers to every facade sharing the same handle', async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const facadeA = createHostDatabase(ctx.db);
      const facadeB = createHostDatabase(ctx.db);
      const topic = uniqueId('wake-shared-facade');
      const rowId = uniqueId('wake-shared-facade-row');
      const tracker = createCallTracker();
      const unsubscribe = getHostDatabaseWake(facadeA).subscribe(topic, tracker.listener);

      try {
        await facadeB.transaction(async (tx) => {
          markTransactionWakeTopic(tx, topic);
          await insertFixtureRow(getTransactionQueryContext(tx), kv, rowId, 'shared-facade');
        });

        await expectDeliveredOnceOrTwice(tracker, ctx.dialect);
      } finally {
        unsubscribe();
      }
    });
  });

  // ─── Rollback and listener-error isolation ───────────────────────────────

  describe('rollback and listener-error isolation', () => {
    it('commits no row and wakes no one when marking is followed by a throw', async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const hostDb = createHostDatabase(ctx.db);
      const wake = getHostDatabaseWake(hostDb);
      const topic = uniqueId('wake-rollback');
      const rowId = uniqueId('wake-rollback-row');
      const tracker = createCallTracker();
      const unsubscribe = wake.subscribe(topic, tracker.listener);

      try {
        await expect(
          hostDb.transaction(async (tx) => {
            markTransactionWakeTopic(tx, topic);
            await insertFixtureRow(getTransactionQueryContext(tx), kv, rowId, 'rollback');
            throw new Error('forced rollback');
          }),
        ).rejects.toThrow('forced rollback');

        await delay(ctx.dialect === 'postgres' ? 300 : 30);
        expect(tracker.count()).toBe(0);
        expect(await readRows(ctx.db, [rowId])).toHaveLength(0);
      } finally {
        unsubscribe();
      }
    });

    it.each([
      {
        name: 'throws synchronously',
        makeListener: () => () => {
          throw new Error('listener boom');
        },
        logPattern: /threw/,
      },
      {
        name: 'rejects its returned promise',
        makeListener: () => () => Promise.reject(new Error('listener boom')),
        logPattern: /rejected/,
      },
      {
        name: 'never settles',
        makeListener: () => () => new Promise<void>(() => undefined),
        logPattern: undefined,
      },
    ])('a listener that $name does not change the commit outcome, and other listeners still run', async ({
      makeListener,
      logPattern,
    }) => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const hostDb = createHostDatabase(ctx.db);
      const wake = getHostDatabaseWake(hostDb);
      const topic = uniqueId('wake-listener-isolation');
      const rowId = uniqueId('wake-listener-isolation-row');
      const otherTracker = createCallTracker();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const unsubscribeBad = wake.subscribe(topic, makeListener());
      const unsubscribeGood = wake.subscribe(topic, otherTracker.listener);

      try {
        const result = await hostDb.transaction(async (tx) => {
          markTransactionWakeTopic(tx, topic);
          await insertFixtureRow(getTransactionQueryContext(tx), kv, rowId, 'isolation');
          return 'committed';
        });

        expect(result).toBe('committed');
        await expectDeliveredOnceOrTwice(otherTracker, ctx.dialect);
        expect(await readRows(ctx.db, [rowId])).toHaveLength(1);

        if (logPattern) {
          await delay(ctx.dialect === 'postgres' ? 300 : 30);
          const matching = errorSpy.mock.calls.find(
            (call) =>
              typeof call[0] === 'string' && call[0].includes('[makaio:storage-drizzle]') && logPattern.test(call[0]),
          );
          expect(matching).toBeDefined();
        }
      } finally {
        unsubscribeBad();
        unsubscribeGood();
        errorSpy.mockRestore();
      }
    });
  });

  // ─── Authorization ────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('refuses to mark a foreign transaction', () => {
      const foreign = Object.freeze({}) as HostTransaction;
      expectHostTransactionErrorCode(() => markTransactionWakeTopic(foreign, 'topic'), 'foreign-transaction');
    });

    it('refuses to mark a transaction after it ended', async () => {
      const ctx = getCtx();
      const hostDb = createHostDatabase(ctx.db);
      const kept = await hostDb.transaction(async (tx) => tx);

      expectHostTransactionErrorCode(() => markTransactionWakeTopic(kept, 'topic'), 'transaction-finished');
    });

    it.skipIf(config.dialect !== 'postgres')('an unmarked transaction issues no notify at all', async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const sibling = await ctx.createSiblingClient();

      try {
        const siblingSignals = getDatabaseSignals(sibling.db);
        if (siblingSignals.kind !== 'database-notify') {
          throw new Error('Postgres sibling client unexpectedly declared no database-notify capability.');
        }
        const events: DatabaseSignal[] = [];
        const unsubscribe = siblingSignals.subscribe((event) => {
          events.push(event);
        });

        try {
          await siblingSignals.ready();
          const hostDb = createHostDatabase(ctx.db);
          await hostDb.transaction(async (tx) => {
            await insertFixtureRow(getTransactionQueryContext(tx), kv, uniqueId('wake-unmarked-row'), 'unmarked');
          });

          await delay(300);
          expect(events).toEqual([]);
        } finally {
          unsubscribe();
        }
      } finally {
        await sibling.close();
      }
    });
  });

  // ─── Capability declaration ───────────────────────────────────────────────

  describe('capability declaration', () => {
    /** One case of the capability-declaration table. */
    interface CapabilityCase {
      /** Human-readable case name. */
      readonly name: string;
      /** URL to create the client from. */
      readonly url: string;
      /** Expected `{ kind: 'none', reason }` capability. */
      readonly expected: Extract<DatabaseSignals, { kind: 'none' }>;
      /** Only meaningful under the `bun:sqlite` driver. */
      readonly bunOnly?: boolean;
    }

    const filesToUnlink: string[] = [];

    afterAll(() => {
      for (const filePath of filesToUnlink) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Best-effort only — the file may never have been created.
        }
      }
    });

    const tempFilePath = path.join(os.tmpdir(), `makaio-database-wake-${randomUUID()}.db`);
    filesToUnlink.push(tempFilePath, `${tempFilePath}-wal`, `${tempFilePath}-shm`);

    const cases: readonly CapabilityCase[] = [
      {
        name: 'a local SQLite file',
        url: `file:${tempFilePath}`,
        expected: { kind: 'none', reason: 'sqlite-file' },
      },
      {
        name: 'a lazily constructed remote libsql client (http URL, no network call)',
        url: 'http://localhost:18080',
        expected: { kind: 'none', reason: 'remote-libsql' },
      },
      {
        name: 'a bun:sqlite in-memory database',
        url: ':memory:',
        expected: { kind: 'none', reason: 'in-memory' },
        bunOnly: true,
      },
    ];

    /**
     * Create a client for `case_.url`, assert both `DatabaseClient.signals`
     * and `getDatabaseSignals(client.db)` resolve to `case_.expected`, then
     * close it. The one driver function every capability case goes through.
     * @param case_ - Capability case to exercise.
     */
    async function assertCapabilityDeclaration(case_: CapabilityCase): Promise<void> {
      const client = await createDatabaseClient({ url: case_.url });
      try {
        expect(client.signals).toEqual(case_.expected);
        expect(getDatabaseSignals(client.db)).toEqual(case_.expected);
      } finally {
        await client.close();
      }
    }

    const applicableCases = cases.filter((case_) => !case_.bunOnly || 'Bun' in globalThis);

    it.skipIf(config.dialect !== 'sqlite').each(applicableCases)(
      'declares the no-cross-process-signal reason for $name',
      async (case_) => {
        await assertCapabilityDeclaration(case_);
      },
    );

    it.skipIf(config.dialect !== 'sqlite')('throws when resolving signals on a handle without a binding', () => {
      // Hand-rolled raw drizzle instance — never passes through
      // createDatabaseClient, so it carries no signals binding. Never
      // queried or used for a transaction, so no connection is actually
      // needed for this assertion.
      const rawDb = drizzle({ connection: { url: ':memory:' } });
      try {
        expect(() => getDatabaseSignals(rawDb)).toThrow(/carries no signal capability binding/);
      } finally {
        rawDb.$client.close();
      }
    });
  });

  // ─── Postgres only: cross-connection, reconnect, validation, lifecycle ───

  describe('postgres cross-connection, reconnect, validation and lifecycle', () => {
    it.skipIf(config.dialect !== 'postgres')(
      'wakes a sibling across connections after commit; a rollback wakes no one',
      async () => {
        const ctx = getCtx();
        const { kv } = resolveSchema(ctx.db, fixtureKv);
        const siblingB = await ctx.createSiblingClient();

        try {
          const hostA = createHostDatabase(ctx.db);
          const hostB = createHostDatabase(siblingB.db);
          const wakeB = getHostDatabaseWake(hostB);
          const topic = uniqueId('wake-cross-connection');
          const tracker = createCallTracker();
          const unsubscribe = wakeB.subscribe(topic, tracker.listener);

          try {
            await wakeB.ready();

            const rowId = uniqueId('wake-cross-connection-row');
            await hostA.transaction(async (tx) => {
              markTransactionWakeTopic(tx, topic);
              await insertFixtureRow(getTransactionQueryContext(tx), kv, rowId, 'cross-connection');
            });

            await tracker.firstCall;
            // B's dispatcher only ever observes A's commit through the one
            // NOTIFY it issued — no local-origin delivery is possible here,
            // since the commit ran on a different handle than B subscribed on.
            expect(tracker.count()).toBe(1);
            expect(await readRows(siblingB.db, [rowId])).toHaveLength(1);

            const beforeRollbackCount = tracker.count();
            await expect(
              hostA.transaction(async (tx) => {
                markTransactionWakeTopic(tx, topic);
                await insertFixtureRow(
                  getTransactionQueryContext(tx),
                  kv,
                  uniqueId('wake-cross-connection-rb-row'),
                  'cross-connection-rb',
                );
                throw new Error('forced rollback');
              }),
            ).rejects.toThrow('forced rollback');

            await delay(300);
            expect(tracker.count()).toBe(beforeRollbackCount);
          } finally {
            unsubscribe();
          }
        } finally {
          await siblingB.close();
        }
      },
      15_000,
    );

    /**
     * Poll `pg_stat_activity` for the backend running the dedicated signal
     * listener's `LISTEN` statement — it stays the connection's last query
     * while the connection sits idle waiting for notifications.
     *
     * The listener sets no `application_name` and the capability reports no
     * backend pid to its caller, so this can only identify "the most
     * recently started `LISTEN` backend", not "this specific client's"
     * unambiguously — safe only because this suite's cases run sequentially,
     * never two listener connections mid-setup at once.
     * @param ctx - Conformance database context used for the lookup.
     * @returns The listener backend's process id.
     */
    async function findListenerBackendPid(ctx: StorageDatabaseContext): Promise<number> {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const rows = await ctx.executor.all<{ pid: number }>(sql`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND query ILIKE 'LISTEN %'
          ORDER BY backend_start DESC
          LIMIT 1
        `);
        if (rows.length > 0) return rows[0]!.pid;
        if (Date.now() > deadline) {
          throw new Error('Timed out waiting for the signal listener backend to appear in pg_stat_activity.');
        }
        await delay(10);
      }
    }

    it.skipIf(config.dialect !== 'postgres')(
      'resyncs and resumes delivery after the listener backend is terminated',
      async () => {
        const ctx = getCtx();
        const { kv } = resolveSchema(ctx.db, fixtureKv);
        const siblingB = await ctx.createSiblingClient();

        try {
          const hostB = createHostDatabase(siblingB.db);
          const wakeB = getHostDatabaseWake(hostB);
          const resyncTracker = createCallTracker();
          const unsubscribeResync = wakeB.onResync(resyncTracker.listener);

          try {
            await wakeB.ready();

            const pid = await findListenerBackendPid(ctx);
            await ctx.executor.run(sql`SELECT pg_terminate_backend(${pid})`);

            await resyncTracker.firstCall;

            const topic = uniqueId('wake-resync');
            const rowTracker = createCallTracker();
            const unsubscribeTopic = wakeB.subscribe(topic, rowTracker.listener);

            try {
              const hostA = createHostDatabase(ctx.db);
              const rowId = uniqueId('wake-resync-row');
              await hostA.transaction(async (tx) => {
                markTransactionWakeTopic(tx, topic);
                await insertFixtureRow(getTransactionQueryContext(tx), kv, rowId, 'resync');
              });

              await rowTracker.firstCall;
              expect(await readRows(siblingB.db, [rowId])).toHaveLength(1);
            } finally {
              unsubscribeTopic();
            }
          } finally {
            unsubscribeResync();
          }
        } finally {
          await siblingB.close();
        }
      },
      20_000,
    );

    it.skipIf(config.dialect !== 'postgres')('rejects invalid notify topics with a clear error', () => {
      const ctx = getCtx();
      const signals = getDatabaseSignals(ctx.db);
      if (signals.kind !== 'database-notify') {
        throw new Error('Postgres handle unexpectedly declared no database-notify capability.');
      }

      expect(() => signals.notifyExpression('')).toThrow(/non-empty/);
      expect(() => signals.notifyExpression('contains-\u0000-a-nul')).toThrow(/NUL/);
      expect(() => signals.notifyExpression('x'.repeat(8000))).toThrow(/7999/);
    });

    it.skipIf(config.dialect !== 'postgres')('closing one client leaves another client delivering', async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const siblingToClose = await ctx.createSiblingClient();
      const siblingToKeep = await ctx.createSiblingClient();
      let siblingToCloseAlreadyClosed = false;

      try {
        const hostToClose = createHostDatabase(siblingToClose.db);
        const hostToKeep = createHostDatabase(siblingToKeep.db);
        const wakeToClose = getHostDatabaseWake(hostToClose);
        const wakeToKeep = getHostDatabaseWake(hostToKeep);
        const topic = uniqueId('wake-close-survives');
        const trackerToKeep = createCallTracker();
        const unsubscribeToKeep = wakeToKeep.subscribe(topic, trackerToKeep.listener);
        // Subscribed only so the closed client's listener connection is
        // actually open at close time; its own delivery is irrelevant here.
        const unsubscribeToClose = wakeToClose.subscribe(topic, () => undefined);

        try {
          await Promise.all([wakeToClose.ready(), wakeToKeep.ready()]);
          await siblingToClose.close();
          siblingToCloseAlreadyClosed = true;

          const hostA = createHostDatabase(ctx.db);
          const rowId = uniqueId('wake-close-survives-row');
          await hostA.transaction(async (tx) => {
            markTransactionWakeTopic(tx, topic);
            await insertFixtureRow(getTransactionQueryContext(tx), kv, rowId, 'close-survives');
          });

          await trackerToKeep.firstCall;
          expect(trackerToKeep.count()).toBe(1);
          expect(await readRows(siblingToKeep.db, [rowId])).toHaveLength(1);
        } finally {
          unsubscribeToKeep();
          unsubscribeToClose();
        }
      } finally {
        await siblingToKeep.close();
        if (!siblingToCloseAlreadyClosed) await siblingToClose.close();
      }
    });

    it.skipIf(config.dialect !== 'postgres')('repeated close() of the signal capability is safe', async () => {
      ensurePostgresEngineRegistered();
      const baseUrl = process.env[STORAGE_TEST_URL_ENV];
      if (baseUrl === undefined) {
        throw new Error(`${STORAGE_TEST_URL_ENV} must be set while the postgres dialect is active.`);
      }

      const client = await createDatabaseClient({ url: baseUrl });
      const signals = getDatabaseSignals(client.db);
      if (signals.kind !== 'database-notify') {
        throw new Error('Postgres client unexpectedly declared no database-notify capability.');
      }
      await signals.ready();

      await expect(client.close()).resolves.toBeUndefined();
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  // ─── Registrations and release: generic dispatcher mechanics ────────────
  //
  // Dialect-independent — exercises the host-side wake dispatcher directly
  // over a never-connected raw handle carrying a hand-rolled `database-notify`
  // capability, so double registration, release-on-close, and resync-listener
  // isolation are covered without a real cross-process signal. Gated to the
  // sqlite run only (same convention as "capability declaration" above): the
  // mechanics under test do not vary by dialect, so there is nothing to gain
  // from repeating them under the Postgres and Bun runs.

  describe('wake dispatcher: registrations and release', () => {
    /**
     * Build a `database-notify` signal capability whose `subscribe` captures
     * its listener so the test can `emit` events directly, without ever
     * opening a real connection.
     * @returns The fake capability and the `emit` function driving it.
     */
    function createFakeNotifySignals(): {
      readonly signals: Extract<DatabaseSignals, { kind: 'database-notify' }>;
      emit(event: DatabaseSignal): void;
    } {
      let listener: ((event: DatabaseSignal) => void) | undefined;
      const signals: Extract<DatabaseSignals, { kind: 'database-notify' }> = {
        kind: 'database-notify',
        notifyExpression: (topic) => sql`SELECT ${topic}`,
        subscribe: (nextListener) => {
          listener = nextListener;
          return () => {
            listener = undefined;
          };
        },
        ready: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      return { signals, emit: (event) => listener?.(event) };
    }

    /**
     * Create a never-connected raw handle (same pattern as "throws when
     * resolving signals on a handle without a binding" above) carrying a fake
     * `database-notify` capability, and the `createHostDatabase` facade over
     * it. The caller must close `db.$client` when done.
     * @returns The raw handle, its facade, and the fake capability's `emit`.
     */
    function createFakeHostDatabase() {
      const db = drizzle({ connection: { url: ':memory:' } });
      const { signals, emit } = createFakeNotifySignals();
      bindDatabaseSignals(db, signals);
      const host = createHostDatabase(db);
      return { db, host, emit };
    }

    it.skipIf(config.dialect !== 'sqlite')(
      'registers the same listener twice as two independent registrations; one unsubscribe removes exactly one',
      () => {
        const { db, host, emit } = createFakeHostDatabase();
        try {
          const wake = getHostDatabaseWake(host);
          const tracker = createCallTracker();
          const unsubscribeFirst = wake.subscribe('topic', tracker.listener);
          const unsubscribeSecond = wake.subscribe('topic', tracker.listener);

          emit({ kind: 'topic', topic: 'topic' });
          expect(tracker.count()).toBe(2);

          unsubscribeFirst();
          emit({ kind: 'topic', topic: 'topic' });
          expect(tracker.count()).toBe(3);

          unsubscribeSecond();
          emit({ kind: 'topic', topic: 'topic' });
          expect(tracker.count()).toBe(3);
        } finally {
          db.$client.close();
        }
      },
    );

    it.skipIf(config.dialect !== 'sqlite')(
      'releases every registration on close() and rejects further subscriptions; close() is idempotent',
      () => {
        const { db, host, emit } = createFakeHostDatabase();
        try {
          const wake = getHostDatabaseWake(host);
          const topicTracker = createCallTracker();
          const resyncTracker = createCallTracker();
          wake.subscribe('topic', topicTracker.listener);
          wake.onResync(resyncTracker.listener);

          releaseHostDatabaseWake(db);
          releaseHostDatabaseWake(db); // idempotent — must not throw

          emit({ kind: 'topic', topic: 'topic' });
          emit({ kind: 'resynced' });
          expect(topicTracker.count()).toBe(0);
          expect(resyncTracker.count()).toBe(0);

          // A facade minted before close(), and one minted after, both see the
          // handle as released: closing is a property of the handle, not of
          // the facade a given subscribe call went through.
          const freshWake = getHostDatabaseWake(host);
          expect(() => wake.subscribe('topic', topicTracker.listener)).toThrow(/closed/i);
          expect(() => freshWake.onResync(resyncTracker.listener)).toThrow(/closed/i);
        } finally {
          db.$client.close();
        }
      },
    );

    it.skipIf(config.dialect !== 'sqlite')(
      'release before any subscription still rejects a later subscribe on the same handle',
      () => {
        const { db, host } = createFakeHostDatabase();
        try {
          releaseHostDatabaseWake(db);
          const wake = getHostDatabaseWake(host);
          expect(() => wake.subscribe('topic', () => undefined)).toThrow(/closed/i);
        } finally {
          db.$client.close();
        }
      },
    );

    it.skipIf(config.dialect !== 'sqlite')(
      'a resync listener that throws or rejects does not stop another resync listener from running',
      async () => {
        const { db, emit, host } = createFakeHostDatabase();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          const wake = getHostDatabaseWake(host);
          const goodTracker = createCallTracker();
          const unsubscribeThrowing = wake.onResync(() => {
            throw new Error('resync listener boom');
          });
          const unsubscribeRejecting = wake.onResync(() => Promise.reject(new Error('resync listener rejected')));
          const unsubscribeGood = wake.onResync(goodTracker.listener);

          try {
            emit({ kind: 'resynced' });
            expect(goodTracker.count()).toBe(1);

            // Give the rejecting listener's promise a turn to settle before
            // reading the log it produced.
            await Promise.resolve();
            await Promise.resolve();

            const logged = (pattern: RegExp) =>
              errorSpy.mock.calls.some(
                (call) =>
                  typeof call[0] === 'string' && call[0].includes('[makaio:storage-drizzle]') && pattern.test(call[0]),
              );
            expect(logged(/threw/)).toBe(true);
            expect(logged(/rejected/)).toBe(true);
          } finally {
            unsubscribeThrowing();
            unsubscribeRejecting();
            unsubscribeGood();
          }
        } finally {
          errorSpy.mockRestore();
          db.$client.close();
        }
      },
    );
  });

  // ─── Postgres only: ready()/close() ordering, direct-subscriber isolation ───
  //
  // Reconnecting after more than one consecutive failed attempt in a row is
  // covered deterministically, with a fake client and fake timers for the
  // backoff, in `signal-listener.test.ts`; this suite keeps only the single
  // real-server reconnect case above ("resyncs and resumes delivery after the
  // listener backend is terminated"), using the one `findListenerBackendPid`
  // helper declared earlier in this file.

  describe('postgres listener lifecycle: ready()/close() ordering and direct-subscriber isolation', () => {
    it.skipIf(config.dialect !== 'postgres')(
      'ready() rejects a connection attempt in flight once close() starts, and every later call too',
      async () => {
        ensurePostgresEngineRegistered();
        const baseUrl = process.env[STORAGE_TEST_URL_ENV];
        if (baseUrl === undefined) {
          throw new Error(`${STORAGE_TEST_URL_ENV} must be set while the postgres dialect is active.`);
        }

        const client = await createDatabaseClient({ url: baseUrl });
        const signals = getDatabaseSignals(client.db);
        if (signals.kind !== 'database-notify') {
          throw new Error('Postgres client unexpectedly declared no database-notify capability.');
        }

        // The very first connection attempt is guaranteed still in flight
        // (never awaited) when close() is issued right after it — a pending
        // ready() call, not one made after close() already started. Attach a
        // no-op rejection handler immediately: close() rejects this promise
        // synchronously, before the `.rejects` assertion below gets to
        // attach its own handler, which Node would otherwise flag as an
        // unhandled rejection in the gap between the two.
        const pendingReady = signals.ready();
        pendingReady.catch(() => undefined);
        await client.close();

        await expect(pendingReady).rejects.toThrow(/close/);
        await expect(signals.ready()).rejects.toThrow(/close/);
        expect(() => signals.subscribe(() => undefined)).toThrow(/close/);
      },
    );

    it.skipIf(config.dialect !== 'postgres')(
      'a throwing direct capability subscriber does not stop delivery to others',
      async () => {
        const ctx = getCtx();
        const { kv } = resolveSchema(ctx.db, fixtureKv);
        const sibling = await ctx.createSiblingClient();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
          const siblingSignals = getDatabaseSignals(sibling.db);
          if (siblingSignals.kind !== 'database-notify') {
            throw new Error('Postgres sibling client unexpectedly declared no database-notify capability.');
          }
          const topic = uniqueId('wake-direct-subscriber-throws');
          const tracker = createCallTracker();
          const unsubscribeBad = siblingSignals.subscribe((event) => {
            if (event.kind === 'topic' && event.topic === topic) {
              throw new Error('direct subscriber boom');
            }
          });
          const unsubscribeGood = siblingSignals.subscribe((event) => {
            if (event.kind === 'topic' && event.topic === topic) tracker.listener();
          });

          try {
            await siblingSignals.ready();

            const hostA = createHostDatabase(ctx.db);
            const rowId = uniqueId('wake-direct-subscriber-throws-row');
            await hostA.transaction(async (tx) => {
              markTransactionWakeTopic(tx, topic);
              await insertFixtureRow(getTransactionQueryContext(tx), kv, rowId, 'direct-subscriber-throws');
            });

            await tracker.firstCall;
            expect(tracker.count()).toBeGreaterThanOrEqual(1);
            expect(errorSpy).toHaveBeenCalled();
          } finally {
            unsubscribeBad();
            unsubscribeGood();
          }
        } finally {
          errorSpy.mockRestore();
          await sibling.close();
        }
      },
      15_000,
    );
  });
});
