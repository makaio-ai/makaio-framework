import { createBusInstance } from '@makaio/bus-core';
import { callFromReceive } from '@makaio/bus-core/kernel-api';
import type { HostTransaction, ProviderAllocationRef } from '@makaio/contracts';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { applyMigrations } from '@makaio/storage-migrations';
import { canonicalStringify } from '@makaio/utils';
import { readCentralChain } from '../../../../../storage/conformance/src/harness/chains.js';
import { createPostgresConfig } from '../../../../../storage/conformance/src/harness/postgres-config.js';
import { createSqliteConfig } from '../../../../../storage/conformance/src/harness/sqlite-config.js';
import type { StoredWorkerRedemption } from '../start-order.js';
import { createWorkerDispatch } from '../start-ordered-worker.js';
import { readDispatch } from '../dispatch-store.js';
import { WorkerExchangeReplyTooLargeError } from '../redemption-reply.js';
import { prepareWorkerRedemption, type WorkerRedemptionHost } from '../redeem-worker.js';
import { WorkerProviderRegistry } from '../provider-registry.js';
import { AllocationObservationSignal } from '../allocation-observation-signal.js';
import { bookRedemptionOwner, migrateRedemptionOwner } from './redemption-owner-fixture.js';
import { controllableProvider, fixtureToken, handleFor, processBoundProvider } from './ordered-worker-fixture.js';
import { RUN_ID, TEST_EXCHANGE_BUDGET, type ExchangeScenario } from './worker-exchange-process-types.js';

export const TEST_RUNTIME_SECRET = 'runtime-fixture-secret';

interface ExchangePauses {
  readonly beforeCommit: () => Promise<void>;
  readonly beforeCorrelation: () => Promise<void>;
  readonly duringDigest: () => Promise<void>;
  readonly afterDigest: () => void;
  readonly duringCommit: () => Promise<void>;
}

/**
 * Create one host-owned booking and run the real dispatch and redemption services.
 * @param scenario - Independent storage and transport case.
 * @param pauses - Test barriers for owner commit and provider correlation.
 * @param operationSignal - Host shutdown lifetime.
 */
export async function setupExchangeStorage(
  scenario: ExchangeScenario,
  pauses: ExchangePauses,
  operationSignal: AbortSignal,
) {
  const config =
    process.env['MAKAIO_STORAGE_TEST_DIALECT'] === 'postgres'
      ? createPostgresConfig(process.env['MAKAIO_STORAGE_TEST_URL'] ?? '')
      : createSqliteConfig();
  const storage = await config.createDatabaseContext({ applyCentralChain: false });
  try {
    // Each process needs the real dispatch schema and its persisted test owner.
    const dispatch = readCentralChain(storage.dialect).find(({ tag }) => tag.endsWith('_worker-dispatch'));
    if (dispatch === undefined) throw new Error('Missing worker dispatch migration');
    await applyMigrations(storage.db, [dispatch]);
    return await book(scenario, pauses, operationSignal, storage);
  } catch (error) {
    await storage.cleanup();
    throw error;
  }
}

/**
 * Persist a booking and select its owning dispatch in the test database.
 * @param scenario - Requested storage state.
 * @param pauses - Event barriers for the requested scenario.
 * @param operationSignal - Owning host lifetime.
 * @param storage - Isolated test database.
 */
async function book(
  scenario: ExchangeScenario,
  pauses: ExchangePauses,
  operationSignal: AbortSignal,
  storage: Awaited<ReturnType<ReturnType<typeof createSqliteConfig>['createDatabaseContext']>>,
) {
  const bus = createBusInstance();
  const ownerCall = bus.own('start');
  const supervisionCall = bus.own('observer');
  const database = createHostDatabase(storage.db);
  await migrateRedemptionOwner(storage);
  const jobRunId = scenario === 'rollback' ? 'storage-reject' : RUN_ID;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const control = controllableProvider();
  const allocation: ProviderAllocationRef = {
    version: 1,
    providerId: control.provider.id,
    providerData: { allocation: jobRunId },
  };
  const outcome = { kind: 'allocated' as const, allocationRef: allocation, handle: handleFor(jobRunId) };
  let visible = scenario !== 'correlation';
  const provider = {
    ...processBoundProvider(control.provider),
    async proveLocalLive() {
      if (!visible) {
        void pauses.beforeCorrelation().then(() => {
          visible = true;
          control.answer.resolve(outcome);
        });
        return undefined;
      }
      return { allocationRef: allocation, expiresAt };
    },
  };
  const providers = new WorkerProviderRegistry();
  await providers.replace(
    supervisionCall,
    { owner: 'example', key: 'primary', managedScopeConfirmed: false, providers: [provider] },
    operationSignal,
  );
  const order = {
    jobRunId,
    workerProviderId: provider.id,
    bootstrapDeadlineAt: expiresAt,
    allocationLifetime: provider.allocationLifetime,
  };
  const owner = await bookRedemptionOwner(
    database,
    order,
    { kind: ownerCall.caller.kind, id: ownerCall.caller.id },
    fixtureToken,
    false,
    replyOrder(scenario),
  );
  const foreign =
    scenario === 'foreign'
      ? await bookRedemptionOwner(
          database,
          { ...order, jobRunId: 'other-run' },
          { kind: ownerCall.caller.kind, id: ownerCall.caller.id },
          'other-run-token',
          false,
        )
      : undefined;
  const source = owner.sourceFor(storage.executor);
  const commitBoundary = scenario === 'dropped-commit' ? instrumentCommit(storage, pauses.duringCommit) : undefined;
  let digestReadFollowups = 0;
  let proofReadCount = 0;
  const host: WorkerRedemptionHost = {
    source: {
      ...source,
      async readRedemptionCredentials(id, signal) {
        if (scenario === 'storage-read-interrupted' && ++proofReadCount === 2) {
          throw new Error('Test post-proof credential read interrupted');
        }
        if (scenario !== 'dropped-digest') return await source.readRedemptionCredentials(id, signal);
        try {
          const [credentials] = await Promise.all([
            source.readRedemptionCredentials(id, signal),
            pauses.duringDigest(),
          ]);
          return credentials;
        } finally {
          pauses.afterDigest();
        }
      },
      async lockOrder(tx, id, signal) {
        if (scenario === 'dropped-digest' && signal !== undefined) digestReadFollowups += 1;
        const booked = await source.lockOrder(tx, id, signal);
        const redemption = booked?.redemption;
        if (booked === undefined || redemption === undefined) return booked;
        return {
          ...booked,
          redemption: {
            ...redemption,
            async accept(ownerTx: HostTransaction, result: StoredWorkerRedemption) {
              if (scenario === 'storage-interrupted') throw new Error('Test write interrupted');
              const winner = await redemption.accept(ownerTx, result);
              if (scenario === 'committed' || scenario === 'dropped' || scenario === 'transport-stopped') {
                await pauses.beforeCommit();
              }
              commitBoundary?.();
              return winner;
            },
          },
        };
      },
    },
    supervisionCall,
    allocationObservation: new AllocationObservationSignal(),
    database,
    providers,
    operationSignal,
    scopeSetting: { kind: 'absent' },
    processIncarnation: 'test-incarnation',
    handles: new Map(),
    connection: () => ({ busAuth: { kind: 'none' } }),
  };
  const dispatched = createWorkerDispatch(host).startOrderedWorker(ownerCall, order, operationSignal);
  if (scenario === 'correlation') {
    await Promise.race([
      control.exposed.getPromise(),
      dispatched.then(() => {
        throw new Error('Expected provisioning to remain pending');
      }),
    ]);
  } else {
    control.answer.resolve(outcome);
    const dispatch = await dispatched;
    if (dispatch.kind !== 'unknown' || dispatch.reason !== 'dispatch-unresolved') {
      throw new Error('Dispatch did not leave assignment to redemption');
    }
  }
  if (scenario === 'revoked') await owner.revoke();
  if (scenario === 'wrong-secret' || scenario === 'stored-over' || scenario === 'over') {
    const anonymous = callFromReceive(undefined, undefined, undefined, () => {});
    const prepared = await prepareWorkerRedemption(
      scenario === 'over' ? { ...host, exchangeReplyByteLimit: TEST_EXCHANGE_BUDGET } : host,
      anonymous,
      { jobRunId, oneTimeToken: fixtureToken, runtimeSecret: TEST_RUNTIME_SECRET },
      { kind: 'allocation-only' },
      Date.parse(expiresAt),
    );
    if (prepared.commit === undefined) throw new Error('Could not seed a redeemed booking');
    const commit = prepared.commit;
    await database.transaction(async (tx) => {
      if (scenario !== 'over') {
        const result = await commit(anonymous, tx);
        if (result.reject !== undefined) throw new Error('Could not seed committed redemption');
        return;
      }
      try {
        await commit(anonymous, tx);
      } catch (error) {
        if (!(error instanceof WorkerExchangeReplyTooLargeError) || error.code !== 'reply-too-large') throw error;
        const row = await owner.readIn(tx);
        const claim = await readDispatch(tx, jobRunId);
        if (row?.stored != null || claim?.boundAllocation != null)
          throw new Error('Reply budget checked after writing');
        return;
      }
      throw new Error('Expected a typed reply budget refusal');
    });
  }
  const read = () =>
    database.transaction(async (tx) => ({
      owner: await owner.readIn(tx),
      dispatch: await readDispatch(tx, jobRunId),
      foreign: await foreign?.readIn(tx),
    }));
  const initial = canonicalStringify(await read());
  if (scenario === 'expired') {
    const now = Date.parse(expiresAt);
    Date.now = () => now;
  }
  return {
    bus,
    host,
    read,
    initial,
    expiresAt,
    digestReadFollowups: () => digestReadFollowups,
    async cleanup() {
      control.answer.resolve(outcome);
      await dispatched.catch(() => undefined);
      await storage.cleanup();
    },
  };
}

/**
 * Pause a real driver transaction after the host releases its callback to the commit boundary.
 * This works with synchronous SQLite commits as well as asynchronous PostgreSQL commits.
 * @param storage - Isolated real database.
 * @param pause - Release controlled by the process supervisor.
 * @returns Arms the boundary for the transaction that persists the accepted order.
 */
function instrumentCommit(
  storage: Awaited<ReturnType<ReturnType<typeof createSqliteConfig>['createDatabaseContext']>>,
  pause: () => Promise<void>,
): () => void {
  let armed = false;
  const transact = storage.db.transaction.bind(storage.db);
  storage.db.transaction = (callback, config) =>
    transact(async (tx) => {
      const result = await callback(tx);
      if (armed) {
        armed = false;
        await pause();
      }
      return result;
    }, config);
  return () => {
    armed = true;
  };
}

/**
 * Form multibyte test payloads on either side of the complete reply budget.
 * @param scenario - Target encoded byte size.
 */
function replyOrder(scenario: ExchangeScenario): string {
  if (scenario !== 'exact' && scenario !== 'just-under' && scenario !== 'over' && scenario !== 'stored-over')
    return 'booked';
  const empty = canonicalStringify({
    type: 'connection-exchange-result',
    payload: { order: '', latestResultAt: new Date(0).toISOString() },
  });
  const offset = scenario === 'exact' ? 0 : scenario === 'just-under' ? -1 : 1;
  const bytes = TEST_EXCHANGE_BUDGET + offset - Buffer.byteLength(empty);
  return 'é'.repeat(Math.floor(bytes / 2)) + 'x'.repeat(bytes % 2);
}
