import { createHash, randomBytes } from 'node:crypto';
import { createBusInstance } from '@makaio/bus-core';
import { callFromReceive } from '@makaio/bus-core/kernel-api';
import type { HostTransaction, JsonValue, ProviderAllocationRef } from '@makaio/contracts';
import { WORKER_REDEMPTION_EXCHANGE, type WorkerExchangeRequest } from '@makaio/contracts/boundary';
import type { DispatchBinding, OrderedWorkerProvider } from '@makaio/contracts/extension';
import type { CallContext } from '@makaio/core';
import { createHostDatabase, serializeByKey } from '@makaio/storage-drizzle';
import { abortableWait, canonicalStringify } from '@makaio/utils';
import type { StoredWorkerRedemption } from '../start-order.js';
import { createWorkerDispatch } from '../start-ordered-worker.js';
import { readDispatch } from '../dispatch-store.js';
import { WorkerExchangeReplyTooLargeError } from '../redemption-reply.js';
import { prepareWorkerRedemption, type WorkerRedemptionHost } from '../redeem-worker.js';
import { WorkerProviderRegistry } from '../provider-registry.js';
import { AllocationObservationSignal } from '../allocation-observation-signal.js';
import { readIssuerIdentityKey } from '../issuer-identity-key.js';
import {
  bookRedemptionOwner,
  readRedemptionOwnerEndings,
  readRedemptionOwnerRow,
  redemptionOwnerSource,
} from './redemption-owner-fixture.js';
import {
  controllableProvider,
  fixtureToken,
  handleFor,
  orderSourceFixture,
  processBoundProvider,
} from './ordered-worker-fixture.js';
import {
  OTHER_RUN_ID,
  RUN_ID,
  TEST_EXCHANGE_BUDGET,
  type ExchangeHostStart,
  type ExchangeScenario,
  type StockLaunchAuth,
} from './worker-exchange-process-types.js';
import { openExchangeDatabase } from './worker-exchange-restart-storage.js';
import { bindExchangeShutdown } from './worker-exchange-shutdown.js';
import { bindTwoHostWake } from './worker-exchange-two-host-wake.js';
import {
  createWorkerConnectionExchange,
  type WorkerConnectionExchangeOptions,
} from '../../../../../runtimes/node/src/worker-connection-exchange.js';
import { createOrderedWorkerBusAuth } from '../../../../../runtimes/node/src/workflow-worker/worker-bus-auth.js';

export const TEST_RUNTIME_SECRET = 'runtime-fixture-secret';

/**
 * Bind the private proof to the observed allocation without storing the proof.
 * @param proof - Per-allocation start material.
 * @returns Fixed-width digest used only by the test's proof verifier.
 */
function allocationProofDigest(proof: string): string {
  return createHash('sha256').update('allocation-proof:').update(proof).digest('hex');
}

/**
 * Match the presented fixture proof to the independently observed allocation.
 * @param proof - Proof from the TLS setup message.
 * @param allocation - Allocation established by supervision.
 * @param expiresAt - Proof expiry for this test booking.
 * @returns The deadline only for matching proof.
 */
export function verifyExchangeAllocationProof(proof: JsonValue, allocation: ProviderAllocationRef, expiresAt: string) {
  return typeof proof === 'string' && allocationProofDigest(proof) === allocation.providerData['proofDigest']
    ? expiresAt
    : undefined;
}

interface ExchangePauses {
  readonly beforeCommit: () => Promise<void>;
  readonly beforeCorrelation: () => Promise<void>;
  readonly duringDigest: () => Promise<void>;
  readonly afterDigest: () => void;
  readonly duringCommit: () => Promise<void>;
  readonly beforeWakeReconnect: () => Promise<void>;
  readonly beforeWakeReconcile: () => Promise<void>;
}

interface StockLaunch {
  readonly resume: boolean;
  send(auth: StockLaunchAuth): void;
}

type ExchangeStorage = Awaited<ReturnType<typeof openExchangeDatabase>>;

/**
 * Create one host-owned booking and run the real dispatch and redemption services.
 * @param scenario - Independent storage and transport case.
 * @param pauses - Test barriers for owner commit and provider correlation.
 * @param operationSignal - Host shutdown lifetime.
 * @param url - Prepared test database endpoint.
 * @param proof - Independent allocation evidence.
 * @param start - Replacement host clock and optional cross-host wake configuration.
 * @param launch - Independent stock worker launch and durable restart settings.
 */
export async function setupExchangeStorage(
  scenario: ExchangeScenario,
  pauses: ExchangePauses,
  operationSignal: AbortSignal,
  url: string,
  proof: string,
  start: Pick<ExchangeHostStart, 'expiredAt' | 'wake'>,
  launch?: StockLaunch,
) {
  const listenerTag = start.wake?.role === 'listener' ? start.wake.listenerTag : undefined;
  const storage = await openExchangeDatabase(
    url,
    listenerTag === undefined
      ? undefined
      : {
          applicationName: listenerTag,
          async beforeReconnect() {
            await pauses.beforeWakeReconnect();
            operationSignal.throwIfAborted();
          },
        },
  );
  try {
    return await book(scenario, pauses, operationSignal, storage, proof, start, launch);
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
 * @param proof - Independent allocation evidence.
 * @param start - Replacement host clock and optional cross-host wake configuration.
 * @param launch - Stock worker launch channel, when used.
 */
async function book(
  scenario: ExchangeScenario,
  pauses: ExchangePauses,
  operationSignal: AbortSignal,
  storage: ExchangeStorage,
  proof: string,
  start: Pick<ExchangeHostStart, 'expiredAt' | 'wake'>,
  launch?: StockLaunch,
) {
  const { expiredAt, wake } = start;
  const attached = launch?.resume === true || wake?.role === 'listener';
  const bus = createBusInstance();
  const ownerCall = bus.own('start');
  const supervisionCall = bus.own('observer');
  const database = createHostDatabase(storage.db);
  const jobRunId = scenario === 'rollback' ? 'storage-reject' : RUN_ID;
  const ownerTurns = new Map<string, Promise<void>>();
  const runTurn = (id: string, work: () => Promise<void>) => serializeByKey(ownerTurns, id, work);
  let completedTerminalTurns = 0;
  const withOtherRun = scenario === 'local-revoke' || scenario === 'local-expiry' || scenario === 'local-takeover';
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const control = controllableProvider();
  const allocation: ProviderAllocationRef = {
    version: 1,
    providerId: control.provider.id,
    providerData: { proofDigest: allocationProofDigest(proof) },
  };
  const otherAllocation = { ...allocation, providerData: { ...allocation.providerData, run: OTHER_RUN_ID } };
  const outcome = { kind: 'allocated' as const, allocationRef: allocation, handle: handleFor(jobRunId) };
  let visible = scenario !== 'correlation';
  const processBound = {
    ...processBoundProvider(control.provider),
    async provision(...args: Parameters<OrderedWorkerProvider['provision']>) {
      if (withOtherRun && args[1].binding.jobRunId === OTHER_RUN_ID) {
        return { kind: 'allocated' as const, allocationRef: otherAllocation, handle: handleFor(OTHER_RUN_ID) };
      }
      return control.provider.provision(...args);
    },
    async proveLocalLive(_call: CallContext, binding: DispatchBinding) {
      if (!visible) {
        void pauses.beforeCorrelation().then(() => {
          visible = true;
          control.answer.resolve(outcome);
        });
        return undefined;
      }
      const allocationRef = binding.jobRunId === OTHER_RUN_ID && withOtherRun ? otherAllocation : allocation;
      return { allocationRef, expiresAt };
    },
  };
  const managed = launch === undefined ? undefined : await orderSourceFixture(database, 'provider-managed', jobRunId);
  const managedProvider: OrderedWorkerProvider = {
    ...control.provider,
    async provision(call, request, signal) {
      if (launch === undefined || launch.resume) throw new Error('Unexpected provisioning');
      launch.send(
        scenario === 'stock-legacy'
          ? { kind: 'hmac', secret: 'shared-test-credential' }
          : createOrderedWorkerBusAuth(
              request,
              scenario === 'stock-refused' ? randomBytes(16).toString('hex') : proof,
              new Date(Date.parse(expiresAt) + 120_000).toISOString(),
            ),
      );
      return await abortableWait(control.provider.provision(call, request, signal), signal);
    },
  };
  const provider = managed === undefined ? processBound : managedProvider;
  if (managed !== undefined) {
    control.allocations.push(allocation);
    control.proveUniqueness();
  }
  const providers = new WorkerProviderRegistry();
  await providers.replace(
    supervisionCall,
    { owner: 'example', key: 'primary', managedScopeConfirmed: managed !== undefined, providers: [provider] },
    operationSignal,
  );
  const order =
    managed === undefined
      ? {
          jobRunId,
          workerProviderId: provider.id,
          bootstrapDeadlineAt: expiresAt,
          allocationLifetime: processBound.allocationLifetime,
        }
      : {
          ...managed.order,
          bootstrapDeadlineAt:
            scenario === 'stock-offline'
              ? new Date(Date.now() + 2_000).toISOString()
              : scenario === 'stock-lost' || scenario === 'stock-expired'
                ? new Date(Date.now() + 4_000).toISOString()
                : managed.order.bootstrapDeadlineAt,
        };
  const owner = attached
    ? undefined
    : await bookRedemptionOwner(
        database,
        order,
        { kind: ownerCall.caller.kind, id: ownerCall.caller.id },
        fixtureToken,
        false,
        replyOrder(scenario),
      );
  const otherOrder = { ...order, jobRunId: OTHER_RUN_ID };
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
  const other = withOtherRun
    ? await bookRedemptionOwner(
        database,
        otherOrder,
        { kind: ownerCall.caller.kind, id: ownerCall.caller.id },
        fixtureToken,
        false,
        replyOrder(scenario),
      )
    : undefined;
  if (scenario === 'local-takeover') {
    const key = (await owner?.read())?.booking.identityRevocationKey;
    if (key === undefined || other === undefined) throw new Error('Missing takeover fixture owners');
    await other.setIssuerIdentityKey(key);
  }
  const source = owner?.sourceFor(storage.executor) ?? redemptionOwnerSource(storage.executor, '');
  const commitBoundary = scenario === 'dropped-commit' ? instrumentCommit(storage, pauses.duringCommit) : undefined;
  let digestReadFollowups = 0;
  let proofReadCount = 0;
  let stockRetryCount = 0;
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
            ...(scenario === 'local-expiry' && id === RUN_ID ? { maxRuntimeMs: 2_000, cancellationWindowMs: 0 } : {}),
            async accept(ownerTx: HostTransaction, result: StoredWorkerRedemption) {
              if (scenario === 'storage-interrupted') throw new Error('Test write interrupted');
              if (scenario === 'stock-retry' && stockRetryCount++ === 0) throw new Error('Test write interrupted');
              if (scenario === 'stock-deadline') {
                if (stockRetryCount++ === 1) await pauses.beforeCommit();
                throw new Error('Test write interrupted');
              }
              const winner = await redemption.accept(ownerTx, result);
              if (
                scenario === 'committed' ||
                scenario === 'dropped' ||
                scenario === 'transport-stopped' ||
                ((scenario === 'stock-dropped' || scenario === 'stock-expired') && !launch?.resume) ||
                scenario === 'stock-shutdown'
              ) {
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
    scopeSetting: managed?.options.scopeSetting ?? { kind: 'absent' },
    processIncarnation: 'test-incarnation',
    handles: new Map(),
    connection: () => ({ busAuth: { kind: 'none' } }),
  };
  const shutdown =
    scenario === 'stock-shutdown' ? await bindExchangeShutdown(bus, host, provider, storage.cleanup) : undefined;
  const dispatch = shutdown?.capability ?? createWorkerDispatch(host);
  const dispatched = attached ? undefined : dispatch.startOrderedWorker(ownerCall, order, operationSignal);
  if (shutdown !== undefined) void dispatched?.catch(() => undefined);
  if (shutdown !== undefined) {
    await control.exposed.getPromise();
  } else if (scenario === 'correlation' && dispatched !== undefined) {
    await Promise.race([
      control.exposed.getPromise(),
      dispatched.then(() => {
        throw new Error('Expected provisioning to remain pending');
      }),
    ]);
  } else if (dispatched !== undefined) {
    control.answer.resolve(outcome);
    const dispatch = await dispatched;
    if (dispatch.kind !== 'unknown' || dispatch.reason !== 'dispatch-unresolved') {
      throw new Error('Dispatch did not leave assignment to redemption');
    }
  }
  if (scenario === 'revoked') await owner?.revoke();
  if (other !== undefined) await dispatch.startOrderedWorker(ownerCall, otherOrder, operationSignal);
  const seedIdentity = scenario.startsWith('identity-') && scenario !== 'identity-missing';
  if (scenario === 'over') {
    await checkOversizedRedemption(host, jobRunId, expiresAt);
  } else if (seedIdentity || scenario === 'wrong-secret' || scenario === 'proof-replay' || scenario === 'stored-over') {
    await seedProtectedRedemption(host, jobRunId, proof, expiresAt);
  }
  if (scenario === 'identity-closed') await owner?.close();
  if (scenario === 'identity-revoked') await owner?.revoke();
  const read = () =>
    database.transaction(async (tx) => ({
      owner: await readRedemptionOwnerRow(tx, jobRunId),
      dispatch: await readDispatch(tx, jobRunId),
      foreign: await foreign?.readIn(tx),
    }));
  const initial = canonicalStringify(await read());
  if (scenario === 'expired' || scenario === 'identity-expired' || expiredAt !== undefined) {
    const now = Date.now;
    const through =
      scenario === 'identity-expired'
        ? Date.parse((await read()).owner?.stored?.accepted.expiresAt ?? '') + 1
        : (expiredAt ?? Date.parse(expiresAt));
    const adjustment = Math.max(0, through - now());
    Date.now = () => now() + adjustment;
  }
  return {
    bus,
    host,
    read,
    initial,
    expiresAt,
    shutdown,
    closeRun: () => owner?.close(),
    twoHostWake:
      wake === undefined
        ? undefined
        : bindTwoHostWake(
            wake,
            storage.db,
            database,
            ownerCall,
            owner?.withJournal(ownerCall).capability,
            pauses.beforeWakeReconcile,
            (work) => runTurn(jobRunId, work),
          ),
    /**
     * Create the owner promotion boundary for the verified run.
     * @param beforeOwnerRead - Observe the turn immediately before its storage read.
     */
    withRunPromotion(
      beforeOwnerRead?: (completedTerminalTurns: number) => void,
    ): WorkerConnectionExchangeOptions['withRunPromotion'] {
      return async (run, signal, publish) => {
        await runTurn(run.jobRunId, async () => {
          signal.throwIfAborted();
          beforeOwnerRead?.(completedTerminalTurns);
          const current = await database.transaction((tx) => source.lockOrder(tx, run.jobRunId, signal), { signal });
          const redemption = current?.redemption;
          if (
            current?.state !== 'redeemed' ||
            redemption?.tokenRevoked !== false ||
            readIssuerIdentityKey(redemption) !== run.revocationKey ||
            redemption.stored?.accepted.expiresAt !== run.expiresAt
          )
            return;
          signal.throwIfAborted();
          publish();
        });
      };
    },
    /**
     * Exercise the test owner's journal-bound terminal transition.
     * @param rollback - Abort the transaction after its writes.
     * @param finish - Observe the outcome and finish synchronous local invalidation, if committed.
     */
    async endLocalRun(rollback: boolean, finish: (key: string | undefined) => Promise<void>) {
      if (owner === undefined) throw new Error('Missing local run owner');
      await runTurn(jobRunId, async () => {
        await finish(await owner.closeForLocalInvalidation(ownerCall, rollback));
        completedTerminalTurns += 1;
      });
    },
    async enterLocalGrace() {
      if (owner === undefined) throw new Error('Missing local run owner');
      await database.transaction(owner.withJournal(ownerCall).cancelIn);
    },
    async terminalFacts() {
      const { owner } = await read();
      const facts = await database.transaction((tx) => readRedemptionOwnerEndings(tx, jobRunId));
      return {
        closed: owner?.state === 'closed',
        revoked: owner?.revoked === true,
        grace: owner?.cancellationDeadlineAt != null,
        facts: facts.length,
      };
    },
    excludesProof: (encoded: string) => !encoded.includes(proof),
    digestReadFollowups: () => digestReadFollowups,
    async cleanup() {
      control.answer.resolve(outcome);
      await dispatched?.catch(() => undefined);
      if (shutdown !== undefined) await shutdown.run();
      else await storage.cleanup();
    },
  };
}

/**
 * Prepare a winner using the protected path and its original valid proof.
 * @param host - Live test host.
 * @param jobRunId - Booking whose winner is needed for a replay or reconnect test.
 * @param proof - Original allocation proof.
 * @param expiresAt - Original bootstrap deadline.
 */
async function seedProtectedRedemption(host: WorkerRedemptionHost, jobRunId: string, proof: string, expiresAt: string) {
  const exchange = createWorkerConnectionExchange(host, {
    maxPendingExchanges: 1,
    async withRunPromotion() {
      // This setup only seeds storage and never publishes a route.
    },
    async verifyProof(presented, allocation) {
      return verifyExchangeAllocationProof(presented, allocation, expiresAt);
    },
  });
  const request: WorkerExchangeRequest = {
    type: 'connection-exchange',
    exchange: WORKER_REDEMPTION_EXCHANGE,
    presented: { jobRunId, oneTimeToken: fixtureToken, runtimeSecret: TEST_RUNTIME_SECRET, proof },
  };
  const result = await exchange.admit(JSON.stringify(request), {
    connectionId: 'setup-peer',
    deadline: Date.parse(expiresAt),
    signal: host.operationSignal,
    markProofVerified: () => {},
  });
  if (result === undefined) throw new Error('Could not seed committed redemption');
}

/**
 * Verify that the internal size error is raised before either durable write.
 * @param host - Live test host.
 * @param jobRunId - Booking with an oversized reply.
 * @param expiresAt - Original bootstrap deadline.
 */
async function checkOversizedRedemption(host: WorkerRedemptionHost, jobRunId: string, expiresAt: string) {
  const anonymous = callFromReceive(undefined, undefined, undefined, () => {});
  const prepared = await prepareWorkerRedemption(
    { ...host, exchangeReplyByteLimit: TEST_EXCHANGE_BUDGET },
    anonymous,
    { jobRunId, oneTimeToken: fixtureToken, runtimeSecret: TEST_RUNTIME_SECRET },
    { kind: 'allocation-only' },
    Date.parse(expiresAt),
  );
  const { commit } = prepared;
  if (commit === undefined) throw new Error('Could not prepare oversized redemption');
  await host.database.transaction(async (tx) => {
    try {
      await commit(anonymous, tx);
    } catch (error) {
      if (!(error instanceof WorkerExchangeReplyTooLargeError) || error.code !== 'reply-too-large') throw error;
      const row = await readRedemptionOwnerRow(tx, jobRunId);
      const claim = await readDispatch(tx, jobRunId);
      if (row?.stored != null || claim?.boundAllocation != null) throw new Error('Reply budget checked after writing');
      return;
    }
    throw new Error('Expected a typed reply budget refusal');
  });
}

/**
 * Pause a real driver transaction after the host releases its callback to the commit boundary.
 * This works with synchronous SQLite commits as well as asynchronous PostgreSQL commits.
 * @param storage - Isolated real database.
 * @param pause - Release controlled by the process supervisor.
 * @returns Arms the boundary for the transaction that persists the accepted order.
 */
function instrumentCommit(storage: Pick<ExchangeStorage, 'db'>, pause: () => Promise<void>): () => void {
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
