import { setImmediate } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { createBusInstance } from '@makaio/bus-core';
import { callFromReceive } from '@makaio/bus-core/kernel-api';
import type { HostDatabase, HostTransaction, ProviderAllocationRef } from '@makaio/contracts';
import { WORKER_REDEMPTION_EXCHANGE } from '@makaio/contracts/boundary';
import type { JobRunEnding } from '@makaio/contracts/workflow';
import type { CallContext } from '@makaio/core';
import {
  resolveStorageConformanceConfig,
  useJournalHostFixture,
  useSuiteDatabaseContext,
  type StorageDatabaseContext,
} from '@makaio/storage-conformance';
import { createHostDatabase, getDatabaseSignals, getHostDatabaseWake } from '@makaio/storage-drizzle';
import { makeStubExtensionBus, stubExtensionIdentity } from '@makaio/test-utils';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createWorkerConnectionExchange } from '../../../../../runtimes/node/src/worker-connection-exchange.js';
import { waitForWakeFence } from '../../../../../storage/conformance/src/harness/wake-fence.js';
import { prepareWorkerRedemption, type WorkerRedemptionHost } from '../../internal/worker-provider-host-binding.js';
import { readDispatch } from '../dispatch-store.js';
import { createWorkerDispatch } from '../start-ordered-worker.js';
import {
  call,
  controllableProvider,
  fixtureToken,
  handleFor,
  orderFixture,
  providerId,
} from './ordered-worker-fixture.js';
import {
  bookRedemptionOwner,
  migrateRedemptionOwner,
  readRedemptionOwnerEndings,
  redemptionJournalOwner,
  redemptionOwnerClosedTopic,
} from './redemption-owner-fixture.js';

const config = resolveStorageConformanceConfig();
if (config === null) throw new Error('MAKAIO_STORAGE_TEST_URL is required for PostgreSQL owner lifecycle tests');

const runtimeSecret = 'lifecycle-test-identity';
const allocationProof = 'lifecycle-test-allocation-proof';
const lost: JobRunEnding = { kind: 'no-result', outcome: 'lost', cause: 'provider-ended' };

/**
 * Count each committed wake once on the native delivery path of this dialect.
 * @param storage - Database handle used to write.
 * @param database - Host transaction facade over that handle.
 */
async function watchEndings(storage: StorageDatabaseContext, database: HostDatabase) {
  let wakes = 0;
  const signals = getDatabaseSignals(storage.db);
  const increment = () => {
    wakes++;
  };
  if (signals.kind === 'database-notify') {
    onTestFinished(
      signals.subscribe((event) => {
        if (event.kind === 'topic' && event.topic === redemptionOwnerClosedTopic) increment();
      }),
    );
    await signals.ready();
  } else {
    onTestFinished(getHostDatabaseWake(database).subscribe(redemptionOwnerClosedTopic, increment));
  }
  return {
    wakeCount: () => wakes,
    flushWake: () => waitForWakeFence(database, signals),
  };
}

/**
 * Claim an atomic order through the real dispatch service and pause its provider response.
 * @param storage - Isolated dialect-backed test database.
 * @param database - Host facade from the journal fixture.
 * @param journalCall - Provenance minted by the fixture journal owner.
 * @param jobRunId - Run owned by this fixture.
 * @param visible - Whether supervision can independently observe the allocation.
 */
async function start(
  storage: StorageDatabaseContext,
  database: HostDatabase,
  journalCall: CallContext,
  jobRunId: string,
  visible: boolean,
) {
  let time = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
  onTestFinished(() => clock.mockRestore());
  const worker = controllableProvider('externally-visible');
  const { order, host: base } = await orderFixture(database, worker.provider, jobRunId);
  const { kind, id } = call.caller;
  const owner = await bookRedemptionOwner(database, order, { kind, id }, fixtureToken, false, { inputs: [] });
  const lifecycle = owner.withJournal(journalCall);
  const host: WorkerRedemptionHost = {
    ...base,
    source: owner.sourceFor(storage.executor),
    supervisionCall: createBusInstance().own('observer'),
    requireIssuerIdentityKey: true,
  };
  const allocation: ProviderAllocationRef = { version: 1, providerId, providerData: { run: jobRunId } };
  if (visible) worker.allocations.push(allocation);
  worker.proveUniqueness();
  const dispatch = createWorkerDispatch(host);
  const sending = dispatch.startOrderedWorker(call, order, host.operationSignal);
  const returnAllocation = () => {
    worker.answer.resolve({ kind: 'allocated', allocationRef: allocation, handle: handleFor(jobRunId) });
    return sending;
  };
  onTestFinished(async () => {
    await returnAllocation();
  });
  await Promise.race([
    worker.exposed.getPromise(),
    sending.then(() => {
      throw new Error('Dispatch completed before reaching the provider');
    }),
  ]);

  const anonymous = callFromReceive({ transportName: 'test', connectionId: 'peer' }, undefined, undefined, () => {});
  const presented = { jobRunId, oneTimeToken: fixtureToken, runtimeSecret, proof: allocationProof };
  const proofDeadline = (ref: ProviderAllocationRef) =>
    isDeepStrictEqual(ref, allocation) ? new Date(time + 60_000).toISOString() : undefined;
  const exchange = createWorkerConnectionExchange(host, {
    maxPendingExchanges: 1,
    async withRunPromotion() {
      // These cases exercise owner storage without publishing a socket.
    },
    async verifyProof(proof, ref) {
      return proof === allocationProof ? proofDeadline(ref) : undefined;
    },
  });
  const admit = (frame: object) =>
    exchange.admit(JSON.stringify(frame), {
      connectionId: 'peer',
      deadline: time + 30_000,
      signal: host.operationSignal,
      markProofVerified() {},
    });
  const wake = await watchEndings(storage, database);

  return {
    order,
    owner,
    lifecycle,
    database,
    setTime(value: number) {
      time = value;
    },
    ...wake,
    readFacts: () => database.transaction((tx) => readRedemptionOwnerEndings(tx, jobRunId)),
    readDispatch: () => database.transaction((tx) => readDispatch(tx, jobRunId)),
    supervise: () => dispatch.superviseOrderedWorker(call, jobRunId, host.operationSignal),
    returnAllocation,
    exposeAllocation: () => worker.allocations.push(allocation),
    terminatedAllocations: worker.terminated,
    bootstrap: () => admit({ type: 'connection-exchange', exchange: WORKER_REDEMPTION_EXCHANGE, presented }),
    reconnect: () => admit({ kind: 'job-run', jobRunId, runtimeSecret }),
    async prepareBootstrap(targetDatabase = database) {
      const { commit } = await prepareWorkerRedemption(
        { ...host, database: targetDatabase },
        anonymous,
        presented,
        { kind: 'externally-visible', verifyPlatform: async (ref) => proofDeadline(ref) },
        time + 30_000,
      );
      if (commit === undefined) throw new Error('Expected a prepared bootstrap');
      return (tx: HostTransaction) => commit(anonymous, tx);
    },
    endIn: (tx: HostTransaction, ending: JobRunEnding) =>
      lifecycle.capability.close(
        call,
        ending.kind === 'result' ? { tx, jobRunId, ending, answer: null } : { tx, jobRunId, ending },
      ),
  };
}

/**
 * Hold the winner before commit and verify where the contending transaction waits.
 * @param storage - Real storage harness, including an independent Postgres connection.
 * @param database - Host facade used by the winner.
 * @param first - Action to run and pause after writing.
 * @param prepareSecond - Bind the contending action to its own database before the race.
 * @typeParam T - Contender's transaction result.
 */
async function contend<T>(
  storage: StorageDatabaseContext,
  database: HostDatabase,
  first: (tx: HostTransaction) => Promise<unknown>,
  prepareSecond: (
    database: HostDatabase,
  ) => Promise<(tx: HostTransaction) => Promise<T>> | ((tx: HostTransaction) => Promise<T>),
): Promise<T> {
  const sibling = storage.dialect === 'postgres' ? await storage.createSiblingClient({ poolMax: 1 }) : undefined;
  if (sibling !== undefined) onTestFinished(() => sibling.close());
  const rivalDatabase = sibling === undefined ? database : createHostDatabase(sibling.db);
  const [backend] = (await sibling?.executor.all<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)) ?? [];
  const second = await prepareSecond(rivalDatabase);
  const written = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const winner = database.transaction(async (tx) => {
    await first(tx);
    written.resolve();
    await release.promise;
  });
  await Promise.race([written.promise, winner]);
  let entered = false;
  const rival = rivalDatabase.transaction(async (tx) => {
    entered = true;
    return await second(tx);
  });
  // Attach a rejection handler while the barrier is checked.
  const completedEarly = () => {
    throw new Error('Rival completed before the winner committed');
  };
  const completion = rival.then(completedEarly, completedEarly);
  try {
    await Promise.race([
      completion,
      (async () => {
        if (backend === undefined) {
          await setImmediate();
          expect(entered).toBe(false);
        } else {
          await vi.waitFor(async () => {
            const [row] = await storage.executor.all<{ blocked: boolean }>(
              sql`SELECT cardinality(pg_blocking_pids(${backend.pid})) > 0 AS blocked`,
            );
            expect(row?.blocked).toBe(true);
          });
        }
      })(),
    ]);
  } finally {
    release.resolve();
    await winner;
    await rival.catch(() => undefined);
  }
  return await rival;
}

/**
 * Build a result in the current close contract's shape.
 * @param jobRunId - Run identity carried by the result.
 * @param status - Disposition proposed by the worker.
 */
function result(jobRunId: string, status: 'completed' | 'cancelled' = 'completed'): JobRunEnding {
  return { kind: 'result', result: { jobRunId, workflowId: 'test-workflow', status } };
}

/**
 * Check that repeated supervision leaves the single committed fact and wake intact.
 * @param fixture - Closed run on the migrated host database.
 */
async function expectCommittedEnding(fixture: Awaited<ReturnType<typeof start>>) {
  const { database, lifecycle, owner, order } = fixture;
  const ending = (await owner.read())?.ending;
  expect(ending).toBeDefined();
  expect(ending).not.toBeNull();
  await database.transaction(lifecycle.cancelIn);
  await database.transaction(lifecycle.expireIn);
  await expect(fixture.readFacts()).resolves.toEqual([{ jobRunId: order.jobRunId, ending }]);
  await fixture.flushWake();
  expect(fixture.wakeCount()).toBe(1);
}

describe(`transactional run owner lifecycle (${config.dialect})`, () => {
  const getContext = useSuiteDatabaseContext(config);
  const journal = useJournalHostFixture(getContext);
  const journalBus = makeStubExtensionBus(createBusInstance(), redemptionJournalOwner);
  beforeAll(async () => migrateRedemptionOwner(getContext()));

  /**
   * Start a run on the journal fixture's migrated host database.
   * @param id - Run to book.
   * @param visible - Whether supervision can see the allocation.
   */
  function startRun(id: string, visible = true) {
    const context = journal.makeContext(journalBus, { identity: stubExtensionIdentity(redemptionJournalOwner) });
    return start(getContext(), context.database, context.bus.own('root'), id, visible);
  }

  it('closes a booked run before a prepared bootstrap can redeem', async () => {
    const storage = getContext();
    const fixture = await startRun('cancel-before-bootstrap');
    await expect(
      contend(storage, fixture.database, fixture.lifecycle.cancelIn, fixture.prepareBootstrap),
    ).resolves.toEqual({
      reject: 'rejected',
    });
    await expect(fixture.owner.read()).resolves.toMatchObject({
      state: 'closed',
      revoked: true,
      stored: null,
      ending: { kind: 'no-result', outcome: 'cancelled', cause: 'cancel-requested' },
    });
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
    await expectCommittedEnding(fixture);
  });

  it('leaves verifier-only expiry neutral and closes before a prepared bootstrap can redeem', async () => {
    const storage = getContext();
    const fixture = await startRun('expired-before-bootstrap');
    const attempt = contend(storage, fixture.database, fixture.lifecycle.expireIn, async (rivalDatabase) => {
      const bootstrap = await fixture.prepareBootstrap(rivalDatabase);
      const before = await fixture.owner.read();
      const dispatchBefore = await fixture.readDispatch();
      fixture.setTime(Date.parse(fixture.order.bootstrapDeadlineAt));
      await expect(fixture.bootstrap()).resolves.toBeUndefined();
      expect(isDeepStrictEqual(await fixture.owner.read(), before)).toBe(true);
      expect(isDeepStrictEqual(await fixture.readDispatch(), dispatchBefore)).toBe(true);
      await expect(fixture.readFacts()).resolves.toEqual([]);
      expect(fixture.wakeCount()).toBe(0);
      return bootstrap;
    });
    // The original preparation deadline also closes at this instant.
    await expect(attempt).rejects.toMatchObject({
      code: 'rejected',
      message: 'Run redemption commit failed',
    });
    await expect(fixture.owner.read()).resolves.toMatchObject({
      state: 'closed',
      revoked: true,
      stored: null,
      ending: { kind: 'no-result', outcome: 'lost', cause: 'bootstrap-expired' },
    });
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
    await expectCommittedEnding(fixture);
  });

  it('supervises an allocation first observed after owner expiry without binding it', async () => {
    const fixture = await startRun('late-allocation-after-expiry', false);
    fixture.setTime(Date.parse(fixture.order.bootstrapDeadlineAt));
    await fixture.database.transaction(fixture.lifecycle.expireIn);
    const closed = await fixture.owner.read();
    expect(closed).toMatchObject({ state: 'closed', revoked: true, stored: null });
    fixture.exposeAllocation();
    await fixture.returnAllocation();
    await fixture.supervise();
    expect(isDeepStrictEqual(await fixture.owner.read(), closed)).toBe(true);
    await expect(fixture.readDispatch()).resolves.toMatchObject({
      boundAllocation: null,
      sendSettled: true,
      candidates: [{ providerData: { run: fixture.order.jobRunId } }],
    });
    expect(fixture.terminatedAllocations).toContainEqual(
      expect.objectContaining({ providerData: { run: fixture.order.jobRunId } }),
    );
    await expectCommittedEnding(fixture);
  });

  it.each([
    'matching-result',
    'grace-expiry',
    'original-expiry',
  ] as const)('keeps the first cancellation grace after redemption (%s)', async (ending) => {
    const storage = getContext();
    const fixture = await startRun(`grace-${ending}`);
    const { jobRunId } = fixture.order;
    const bootstrap = await fixture.prepareBootstrap();
    await contend(
      storage,
      fixture.database,
      async (tx) => {
        const accepted = await bootstrap(tx);
        expect(accepted).toHaveProperty('party.id', jobRunId);
        if (ending === 'original-expiry' && accepted.expiresAt !== undefined) {
          fixture.setTime(Date.parse(accepted.expiresAt) - 2_000);
        }
      },
      () => fixture.lifecycle.cancelIn,
    );
    const cancelling = await fixture.owner.read();
    const { stored, cancellationDeadlineAt } = cancelling ?? {};
    if (!stored || !cancellationDeadlineAt) throw new Error('Expected a redeemed run in grace');
    const cancellation = Date.parse(cancellationDeadlineAt);
    const original = Date.parse(stored.accepted.expiresAt);
    const effective = Math.min(cancellation, original);
    expect(cancellation - Date.now()).toBe(10_000);
    fixture.setTime(effective - 1);
    await fixture.database.transaction(fixture.lifecycle.cancelIn);
    expect(isDeepStrictEqual(await fixture.owner.read(), cancelling)).toBe(true);
    const replay = await fixture.bootstrap();
    expect(replay?.expiresAt).toBe(stored.accepted.expiresAt);
    expect((await fixture.reconnect())?.expiresAt).toBe(stored.accepted.expiresAt);
    const submit = (value: JobRunEnding) => fixture.database.transaction((tx) => fixture.endIn(tx, value));
    await expect(submit(result(jobRunId))).rejects.toThrow('ending-invalid');
    await expect(submit(lost)).rejects.toThrow('ending-invalid');
    await expect(submit(result('different-run', 'cancelled'))).rejects.toThrow('result-run-mismatch');
    expect(isDeepStrictEqual(await fixture.owner.read(), cancelling)).toBe(true);
    await expect(fixture.readFacts()).resolves.toEqual([]);
    expect(fixture.wakeCount()).toBe(0);

    const cancelled = result(jobRunId, 'cancelled');
    let expected: JobRunEnding = cancelled;
    if (ending === 'matching-result') {
      await submit(cancelled);
    } else {
      fixture.setTime(effective);
      await expect(fixture.bootstrap()).resolves.toBeUndefined();
      await expect(fixture.reconnect()).resolves.toBeUndefined();
      await expect(submit(cancelled)).rejects.toThrow('run-not-running');
      expect(isDeepStrictEqual(await fixture.owner.read(), cancelling)).toBe(true);
      expect(fixture.wakeCount()).toBe(0);
      await fixture.database.transaction(fixture.lifecycle.expireIn);
      expected = {
        kind: 'no-result',
        outcome: 'cancelled',
        cause: ending === 'grace-expiry' ? 'cancellation-expired' : 'result-expired',
      };
    }
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'closed', revoked: true, ending: expected });
    expect(isDeepStrictEqual((await fixture.owner.read())?.stored, stored)).toBe(true);
    await expect(fixture.bootstrap()).resolves.toBeUndefined();
    await expect(fixture.reconnect()).resolves.toBeUndefined();
    await expectCommittedEnding(fixture);
  });

  it.each(['result', 'no-result'] as const)('commits only the winning %s ending', async (first) => {
    const storage = getContext();
    const fixture = await startRun(`winner-${first}`);
    const accepted = await fixture.bootstrap();
    expect(accepted).toBeDefined();
    const before = await fixture.owner.read();
    const { jobRunId } = fixture.order;
    const readFacts = (tx: HostTransaction) => readRedemptionOwnerEndings(tx, jobRunId);
    const completed = result(jobRunId);
    const winner = first === 'result' ? completed : lost;
    const rival = first === 'result' ? lost : completed;
    await expect(
      fixture.database.transaction(async (tx) => {
        await fixture.endIn(tx, winner);
        await expect(fixture.owner.readIn(tx)).resolves.toMatchObject({
          state: 'closed',
          revoked: true,
          ending: winner,
        });
        expect(fixture.wakeCount()).toBe(0);
        await expect(readFacts(tx)).resolves.toEqual([{ jobRunId, ending: winner }]);
        throw new Error('Abort prepared ending');
      }),
    ).rejects.toThrow('Abort prepared ending');
    expect(isDeepStrictEqual(await fixture.owner.read(), before)).toBe(true);
    await expect(fixture.readFacts()).resolves.toEqual([]);
    await fixture.flushWake();
    expect(fixture.wakeCount()).toBe(0);
    expect(await fixture.bootstrap()).toEqual({ ...accepted, withPromotion: expect.any(Function) });
    await expect(fixture.reconnect()).resolves.toBeDefined();

    await expect(
      contend(
        storage,
        fixture.database,
        async (tx) => {
          await fixture.endIn(tx, winner);
          expect(fixture.wakeCount()).toBe(0);
        },
        () => (tx) => fixture.endIn(tx, rival),
      ),
    ).rejects.toThrow('run-not-running');
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'closed', revoked: true, ending: winner });
    await expectCommittedEnding(fixture);
    await expect(fixture.bootstrap()).resolves.toBeUndefined();
    await expect(fixture.reconnect()).resolves.toBeUndefined();
  });
});
