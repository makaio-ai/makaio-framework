import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createBusInstance } from '@makaio/bus-core';
import { callFromReceive } from '@makaio/bus-core/kernel-api';
import type { HostDatabase, ProviderAllocationRef } from '@makaio/contracts';
import type {
  ConnectionExchangeAccepted,
  ConnectionExchangeCommit,
  ConnectionExchangeRejected,
} from '@makaio/contracts/boundary';
import { AllocationBindingRequiresRedemptionError, type StartValueVisibility } from '@makaio/contracts/capabilities';
import type { OrderedWorkerProvider } from '@makaio/contracts/extension';
import { CorePartyKind, type CallContext } from '@makaio/core';
import { ExtensionCoordinator, type ExtensionContextBase } from '@makaio/kernel';
import { createHostDatabase, type RawSqlExecutor } from '@makaio/storage-drizzle';
import {
  resolveStorageConformanceConfig,
  useJournalHostFixture,
  useSuiteDatabaseContext,
} from '@makaio/storage-conformance';
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';
import {
  prepareWorkerRedemption,
  WorkerRedemptionError,
  type WorkerRedemptionHost,
} from '../../internal/worker-provider-host-binding.js';
import { decideAllocationScope } from '../scope-decision.js';
import { confirmAllocationScope } from '../scope-confirmation.js';
import { readDispatch } from '../dispatch-store.js';
import { WorkerProviderRegistry } from '../provider-registry.js';
import { createWorkerDispatch } from '../start-ordered-worker.js';
import type {
  AtomicRedemptionWorkerOrderSource,
  SeparateBindingWorkerOrderSource,
  StartOrder,
  WorkerOrderSource,
} from '../index.js';
import { createWorkerProviderContributionProcessor } from '../worker-provider-contribution-processor.js';
import {
  controllableProvider,
  fixtureToken,
  handleFor,
  processBoundProvider,
  setting,
} from './ordered-worker-fixture.js';
import { bookRedemptionOwner, migrateRedemptionOwner } from './redemption-owner-fixture.js';
import type { SqliteContenderInput, SqliteContenderMessage } from './sqlite-redemption-contender.js';

const config = resolveStorageConformanceConfig();
if (config === null) throw new Error('MAKAIO_STORAGE_TEST_URL is required for worker redemption tests');
const runtimeSecret = 'original-runtime-secret';
const localPolicy = { kind: 'allocation-only' } as const;

type WorkerControl = ReturnType<typeof controllableProvider>;
type FixtureMode = 'local' | 'managed' | 'legacy';
type ManagedRecovery = NonNullable<WorkerControl['provider']['recovery']>;
type ManageRecovery = (recovery: ManagedRecovery) => ManagedRecovery;

interface FixtureStorage {
  readonly constructContext: ExtensionContextBase['constructContext'];
  readonly executor: RawSqlExecutor;
}

/**
 * Expose a managed allocation whose inspection requires the host supervision call.
 * @param control - Provider with real in-memory allocation state.
 * @param allocation - Reference visible to host supervision.
 * @param supervisionCall - Exact host call authorized to inspect in this fixture.
 * @param configure - Optional provider behavior for this scenario.
 * @returns The contributed provider.
 */
function managedProvider(
  control: WorkerControl,
  allocation: ProviderAllocationRef,
  supervisionCall: CallContext,
  configure?: ManageRecovery,
): OrderedWorkerProvider {
  control.allocations.push(allocation);
  control.proveUniqueness();
  const recovery = configure?.(control.provider.recovery) ?? control.provider.recovery;
  return {
    ...control.provider,
    recovery: {
      ...recovery,
      async inspect(call, binding, ref, signal) {
        const isOwner = call.caller.kind === CorePartyKind.extension && call.caller.id === 'example';
        if (call !== supervisionCall && !isOwner) {
          throw new Error('Provider inspection requires host supervision');
        }
        return recovery.inspect(call, binding, ref, signal);
      },
    },
  };
}

/**
 * Build the committed order for the selected provider.
 * @param provider - Contributed provider instance.
 * @param jobRunId - Isolated booking key.
 * @param deadline - Bootstrap deadline in milliseconds.
 * @returns The booked order with its confirmed scope when required.
 */
function bookedOrder(provider: OrderedWorkerProvider, jobRunId: string, deadline: number): StartOrder {
  const common = {
    jobRunId,
    workerProviderId: provider.id,
    bootstrapDeadlineAt: new Date(deadline).toISOString(),
  };
  if (provider.allocationLifetime === 'provisioner-process-bound') {
    return { ...common, allocationLifetime: provider.allocationLifetime };
  }
  const scope = decideAllocationScope(setting, 'example-scope');
  if (scope.kind !== 'bound') throw new Error('Missing test allocation scope');
  return { ...common, allocationLifetime: provider.allocationLifetime, allocationScope: scope.scope };
}

/**
 * Start a committed dispatch and hold its provision response until the test ends.
 * @param storage - Host context binder and standalone reader for the persisted test extension.
 * @param jobRunId - Isolated booking key.
 * @param mode - Provider and booking mode.
 * @param configureManaged - Optional managed recovery behavior.
 */
async function startFixture(
  storage: FixtureStorage,
  jobRunId: string,
  mode: FixtureMode,
  configureManaged?: ManageRecovery,
) {
  const allocation: ProviderAllocationRef = {
    version: 1,
    providerId: 'example.worker:primary',
    providerData: { allocation: jobRunId },
  };
  const control = controllableProvider();
  const deadline = Date.now() + 60_000;
  let proveLive = true;
  const local = {
    ...processBoundProvider(control.provider),
    async proveLocalLive() {
      return proveLive ? { allocationRef: allocation, expiresAt: new Date(deadline).toISOString() } : undefined;
    },
  };
  const bus = createBusInstance();
  const supervisionCall = bus.own('observer');
  const provider = mode === 'managed' ? managedProvider(control, allocation, supervisionCall, configureManaged) : local;
  const order = bookedOrder(provider, jobRunId, deadline);
  const coordinator = new ExtensionCoordinator(bus, {
    extensionContextBase: {
      constructContext: storage.constructContext,
      platform: 'linux',
      homedir: '/home/test',
      makaioHome: '/home/test/.makaio',
      username: 'test',
      machineId: 'test',
      tryImport: async () => null,
    },
  });
  const providers = new WorkerProviderRegistry();
  coordinator.registerContributionProcessor(createWorkerProviderContributionProcessor(providers));
  let booking:
    | {
        owner: Awaited<ReturnType<typeof bookRedemptionOwner>>;
        host: WorkerRedemptionHost;
        start: () => Promise<unknown>;
        supervise: () => Promise<unknown>;
        prepareSeparateBinding: () => ReturnType<ReturnType<typeof createWorkerDispatch>['prepareAllocationBinding']>;
      }
    | undefined;
  coordinator.load([
    {
      name: 'example',
      version: '1.0.0',
      displayName: 'Test run owner',
      critical: true,
      workerProviders: {
        createProviders: () => ({ key: 'primary', managedScopeConfirmed: mode === 'managed', providers: [provider] }),
      },
      async create(ctx) {
        const call = ctx.bus.own('start');
        const identity = { kind: CorePartyKind.extension, id: ctx.identity.extensionName };
        if (order.allocationLifetime === 'provider-managed') {
          await confirmAllocationScope(ctx.database, setting, order.allocationScope.value, call);
        }
        const owner = await bookRedemptionOwner(ctx.database, order, identity, fixtureToken, mode === 'legacy');
        const host: WorkerRedemptionHost = {
          supervisionCall,
          database: ctx.database,
          source: owner.sourceFor(storage.executor),
          providers,
          operationSignal: ctx.signal,
          scopeSetting: setting,
          processIncarnation: 'initial-incarnation',
          handles: new Map(),
          connection: () => ({ busAuth: { kind: 'none' } }),
        };
        const dispatch = createWorkerDispatch(host);
        booking = {
          owner,
          host,
          start: () => dispatch.startOrderedWorker(call, order, ctx.signal),
          supervise: () => dispatch.superviseOrderedWorker(call, jobRunId, ctx.signal),
          prepareSeparateBinding: () => dispatch.prepareAllocationBinding(call, jobRunId, localPolicy),
        };
        return {};
      },
    },
  ]);
  onTestFinished(() => coordinator.shutdown());
  await coordinator.startAll();
  if (booking === undefined) throw new Error('Run owner did not book the test order');
  const { host, owner, start, supervise, prepareSeparateBinding } = booking;
  const pending = start();
  const finishProvision = async (allocationRef = allocation) => {
    control.answer.resolve({ kind: 'allocated', allocationRef, handle: handleFor(jobRunId) });
    await pending;
  };
  onTestFinished(() => finishProvision());
  await Promise.race([
    control.exposed.getPromise(),
    pending.then(() => {
      throw new Error('Order did not reach the provider');
    }),
  ]);
  return {
    host,
    owner,
    allocation,
    deadline,
    finishProvision,
    supervise,
    prepareSeparateBinding,
    async readDispatch() {
      return host.database.transaction((tx) => readDispatch(tx, jobRunId));
    },
    loseLiveProof() {
      proveLive = false;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof startFixture>>;
type ExchangeOutcome = ConnectionExchangeAccepted | ConnectionExchangeRejected;

interface CommitBarrier {
  readonly enter?: () => void;
  readonly beforeRelease?: (result: ExchangeOutcome) => Promise<void>;
}

interface RedemptionRival {
  readonly entered: Promise<void>;
  /**
   * Request the rival transaction.
   * @param winner - The winning transaction, including its commit.
   */
  begin(winner: Promise<ExchangeOutcome>): Promise<ExchangeOutcome>;
}

/**
 * Prepare an independently connected rival that reports SQLite write contention.
 * @param executor - The SQLite conformance database's raw executor.
 * @param input - Booked run and local provider fixture shared with the rival.
 */
async function startSqliteRival(
  executor: RawSqlExecutor,
  input: Omit<SqliteContenderInput, 'databaseUrl'>,
): Promise<RedemptionRival> {
  const files = await executor.all<{ name: string; file: string }>(sql`PRAGMA database_list`);
  const file = files.find(({ name }) => name === 'main')?.file;
  if (!file) throw new Error('Expected a file-backed SQLite conformance database');
  const worker = new Worker(new URL('./sqlite-redemption-contender.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
    workerData: { ...input, databaseUrl: pathToFileURL(file).href } satisfies SqliteContenderInput,
  });
  onTestFinished(async () => {
    await worker.terminate();
  });
  const prepared = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<ExchangeOutcome>();
  worker.on('message', (message: SqliteContenderMessage) => {
    if (message.kind === 'prepared') prepared.resolve();
    else if (message.kind === 'write-locked') entered.resolve();
    else completed.resolve(message.result);
  });
  worker.once('error', (error) => completed.reject(error));
  worker.once('exit', () => completed.reject(new Error('SQLite contender exited before returning the result')));
  await Promise.race([prepared.promise, completed.promise]);
  return {
    entered: entered.promise,
    begin(winner) {
      worker.postMessage('commit');
      void winner.then(() => worker.postMessage('winner-committed'), completed.reject);
      return completed.promise;
    },
  };
}

/**
 * Prepare one exchange and bind its application to the minted connection call.
 * @param fixture - Running provider and booked owner.
 * @param jobRunId - Presented job run.
 * @param credentials - Optional credentials to replace for this attempt.
 * @param policy - Host-selected visibility policy.
 */
async function prepare(
  fixture: Fixture,
  jobRunId: string,
  credentials: { token?: string; secret?: string } = {},
  policy: StartValueVisibility = localPolicy,
) {
  const anonymous = callFromReceive(
    { transportName: 'worker-test', connectionId: 'peer' },
    undefined,
    undefined,
    () => {},
  );
  const prepared = await prepareWorkerRedemption(
    fixture.host,
    anonymous,
    {
      jobRunId,
      oneTimeToken: credentials.token ?? fixtureToken,
      runtimeSecret: credentials.secret ?? runtimeSecret,
    },
    policy,
  );
  return {
    anonymous,
    prepared,
    async exchange(commitCall: CallContext = anonymous, barrier?: CommitBarrier, database = fixture.host.database) {
      const { commit } = prepared;
      if (commit === undefined) return prepared;
      return database.transaction(async (tx) => {
        barrier?.enter?.();
        const result = await commit(commitCall, tx);
        await barrier?.beforeRelease?.(result);
        return result;
      });
    },
    async rollback() {
      const { commit } = prepared;
      if (commit === undefined) throw new Error('Expected a prepared exchange');
      return fixture.host.database.transaction(async (tx) => {
        const result = await commit(anonymous, tx);
        if ('reject' in result) throw new Error('Redemption was refused');
        throw new Error('Abort before commit');
      });
    },
    async catchCommitFailure() {
      const { commit } = prepared;
      if (commit === undefined) throw new Error('Expected a prepared exchange');
      return fixture.host.database.transaction(async (tx) => {
        try {
          await commit(anonymous, tx);
        } catch (error) {
          // The exchange must still roll back when the transaction caller catches its failure.
          expect(error).toBeInstanceOf(WorkerRedemptionError);
          expect(error).toMatchObject({ code: 'rejected', message: 'Run redemption commit failed' });
          expect(error).not.toHaveProperty('cause');
        }
      });
    },
  };
}

/**
 * Require a pending storage callback for the test's pre-commit assertions.
 * @param value - Prepared exchange.
 */
function expectPrepared(value: { prepared: { commit?: ConnectionExchangeCommit['commit'] } }) {
  expect(value.prepared.commit).toBeTypeOf('function');
}

describe(`worker redemption owner storage (${config.dialect})`, () => {
  const getContext = useSuiteDatabaseContext(config);
  const { constructContext } = useJournalHostFixture(getContext);
  beforeAll(async () => migrateRedemptionOwner(getContext()));
  afterEach(() => vi.useRealTimers());

  it('requires a lock-free lookup for an order source that can book atomic redemption', () => {
    expectTypeOf<
      Omit<AtomicRedemptionWorkerOrderSource, 'readRedemptionCredentials'>
    >().not.toExtend<WorkerOrderSource>();
    expectTypeOf<SeparateBindingWorkerOrderSource>().toExtend<WorkerOrderSource>();
  });

  /**
   * Book and claim one run in the test database.
   * @param id - Unique test booking key.
   * @param mode - Provider and booking mode.
   * @param configureManaged - Optional managed recovery behavior.
   */
  async function start(id: string, mode: FixtureMode = 'local', configureManaged?: ManageRecovery) {
    return startFixture({ constructContext, executor: getContext().executor }, id, mode, configureManaged);
  }

  /**
   * Use the same persisted owner through an independent connection.
   * @param fixture - Booked run and host authority.
   */
  async function siblingFixture(fixture: Fixture) {
    const sibling = await getContext().createSiblingClient();
    return {
      ...fixture,
      host: {
        ...fixture.host,
        database: createHostDatabase(sibling.db),
        source: fixture.owner.sourceFor(sibling.executor),
      },
    };
  }

  /**
   * Prepare a rival using an independent database connection.
   * @param fixture - Booked run and host authority.
   * @param jobRunId - Run presented by both runtimes.
   * @param runtimeSecret - Rival runtime's secret.
   */
  async function prepareRival(fixture: Fixture, jobRunId: string, runtimeSecret: string): Promise<RedemptionRival> {
    const context = getContext();
    if (context.dialect === 'sqlite') {
      return startSqliteRival(context.executor, {
        jobRunId,
        runtimeSecret,
        allocation: fixture.allocation,
        deadline: fixture.deadline,
        processIncarnation: fixture.host.processIncarnation,
      });
    }
    const second = await prepare(await siblingFixture(fixture), jobRunId, { secret: runtimeSecret });
    expectPrepared(second);
    const entered = Promise.withResolvers<void>();
    return { entered: entered.promise, begin: () => second.exchange(undefined, { enter: entered.resolve }) };
  }

  /**
   * Hold the winner's real write transaction while comparing two setup attempts.
   * @param fixture - Booked run.
   * @param id - Run presented by both runtimes.
   * @param secondSecret - Runtime secret used by the competing connection.
   */
  async function compete(fixture: Fixture, id: string, secondSecret: string) {
    const first = await prepare(fixture, id);
    expectPrepared(first);
    const contender = await prepareRival(fixture, id, secondSecret);
    const written = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const winner = first.exchange(undefined, {
      async beforeRelease(result) {
        expect(result).toHaveProperty('party');
        written.resolve();
        await release.promise;
      },
    });
    await Promise.race([written.promise, winner]);
    const rival = contender.begin(winner);
    try {
      await Promise.race([
        contender.entered,
        rival.then(() => {
          throw new Error('Rival completed before reaching its transaction barrier');
        }),
      ]);
    } finally {
      release.resolve();
    }
    return Promise.all([winner, rival]);
  }

  it('commits the allocation and owner identity with the stored reply', async () => {
    const fixture = await start('first-valid');
    const exchange = await prepare(fixture, 'first-valid');
    expectPrepared(exchange);
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
    const result = await exchange.exchange();
    const row = await fixture.owner.read();
    expect(row).toMatchObject({ state: 'redeemed', stored: { accepted: result } });
    if (row?.stored === null || row?.stored === undefined) throw new Error('Missing committed identity');
    expect(Date.parse(row.stored.accepted.expiresAt) - Date.parse(row.stored.redeemedAt)).toBe(130_000);
    expect(result).toMatchObject({
      party: { kind: 'makaio.job-run', id: 'first-valid' },
      payload: { order: { inputs: ['first', 'second'] } },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.party)).toBe(true);
    expect(Object.isFrozen(result.payload)).toBe(true);
    expect(result).toHaveProperty('payload.order.inputs', expect.toSatisfy(Object.isFrozen));
    expect(JSON.stringify(row)).not.toContain(runtimeSecret);
    expect(JSON.stringify(row)).not.toContain(fixtureToken);
    await expect(fixture.host.database.transaction((tx) => readDispatch(tx, 'first-valid'))).resolves.toMatchObject({
      boundAllocation: fixture.allocation,
    });
  });

  it('returns the durable reply past bootstrap expiry without fresh liveness', async () => {
    const fixture = await start('replay');
    const result = await (await prepare(fixture, 'replay')).exchange();
    const before = await fixture.owner.read();
    fixture.loseLiveProof();
    vi.setSystemTime(fixture.deadline + 1);
    const peer = await siblingFixture(fixture);
    const restarted = {
      ...peer,
      host: { ...peer.host, processIncarnation: 'restarted' },
    };
    const replay = await (await prepare(restarted, 'replay')).exchange();
    expect(replay).toEqual(result);
    expect(Object.isFrozen(replay.payload)).toBe(true);
    await expect(fixture.owner.read()).resolves.toEqual(before);
    expect(before?.state).toBe('redeemed');
  });

  it('refuses a different runtime secret without replacing the winning identity', async () => {
    const fixture = await start('different-secret');
    const winner = await (await prepare(fixture, 'different-secret')).exchange();
    const loser = await prepare(fixture, 'different-secret', { secret: 'different-secret' });
    await expect(loser.exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'redeemed', stored: { accepted: winner } });
  });

  it('refuses an expired bootstrap credential', async () => {
    const fixture = await start('expired');
    vi.setSystemTime(fixture.deadline);
    await expect((await prepare(fixture, 'expired')).exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

  it('refuses a revoked bootstrap credential', async () => {
    const fixture = await start('revoked');
    await fixture.owner.revoke();
    await expect((await prepare(fixture, 'revoked')).exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', revoked: true, stored: null });
  });

  it('refuses a foreign bootstrap credential', async () => {
    const fixture = await start('foreign');
    await expect((await prepare(fixture, 'foreign', { token: 'foreign' })).exchange()).resolves.toEqual({
      reject: 'rejected',
    });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

  it('refuses an unknown run without changing the booked run', async () => {
    const fixture = await start('known-run');
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    await expect((await prepare(fixture, 'unknown-run')).exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it('refuses a wrong credential without requesting the held run lock', async () => {
    const fixture = await start('no-lock-for-wrong-credential');
    const id = 'no-lock-for-wrong-credential';
    const sibling = await getContext().createSiblingClient();
    const database = createHostDatabase(sibling.db);
    const transactionRequested = Promise.withResolvers<'transaction'>();
    const observed: HostDatabase = {
      transaction(fn) {
        transactionRequested.resolve('transaction');
        return database.transaction(fn);
      },
    };
    const peer = {
      ...fixture,
      host: { ...fixture.host, database: observed, source: fixture.owner.sourceFor(sibling.executor) },
    };
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const owner = fixture.host.database.transaction(async (tx) => {
      await fixture.owner.holdLock(tx);
      held.resolve();
      await release.promise;
    });
    const refusal = held.promise.then(async () => (await prepare(peer, id, { token: 'wrong-token' })).exchange());
    try {
      await expect(Promise.race([refusal, transactionRequested.promise, owner])).resolves.toEqual({
        reject: 'rejected',
      });
    } finally {
      release.resolve();
      await Promise.allSettled([owner, refusal]);
    }
  });

  it('refuses prepared work after the persisted owner changes', async () => {
    const fixture = await start('owner-changed');
    const prepared = await prepare(fixture, 'owner-changed');
    expectPrepared(prepared);
    await fixture.owner.transferTo({ kind: CorePartyKind.extension, id: 'other-owner' });
    await expect(prepared.exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({
      booking: { owner: { id: 'other-owner' } },
      state: 'ordered',
      stored: null,
    });
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
  });

  it('refuses a commit from a foreign facade even over the same handle', async () => {
    const fixture = await start('foreign-facade');
    const prepared = await prepare(fixture, 'foreign-facade');
    expectPrepared(prepared);
    const foreign = createHostDatabase(getContext().db);
    await expect(prepared.exchange(undefined, undefined, foreign)).rejects.toMatchObject({
      name: 'WorkerRedemptionError',
      code: 'rejected',
      message: 'Run redemption requires the host transaction',
    });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
  });

  it('refuses prepared work when the owner closes the run before commit', async () => {
    const fixture = await start('owner-closed');
    const prepared = await prepare(fixture, 'owner-closed');
    expectPrepared(prepared);
    await fixture.owner.close();
    await expect(prepared.exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'closed', stored: null });
  });

  it('rolls back both allocation binding and owner identity with the exchange', async () => {
    const fixture = await start('rollback');
    const prepared = await prepare(fixture, 'rollback');
    await expect(prepared.rollback()).rejects.toThrow('Abort before commit');
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
    await expect(fixture.host.database.transaction((tx) => readDispatch(tx, 'rollback'))).resolves.toMatchObject({
      boundAllocation: null,
    });
  });

  it('marks the borrowed transaction rollback-only after the owner write fails', async () => {
    const fixture = await start('storage-reject');
    const prepared = await prepare(fixture, 'storage-reject');
    await expect(prepared.catchCommitFailure()).rejects.toThrow('Run redemption commit failed');
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
    await expect(fixture.host.database.transaction((tx) => readDispatch(tx, 'storage-reject'))).resolves.toMatchObject({
      boundAllocation: null,
    });
  });

  it('preserves the caller write when the host stopped before commit', async () => {
    const id = 'stopped-before-commit';
    const fixture = await start(id);
    const operations = new AbortController();
    const { anonymous, prepared } = await prepare(
      { ...fixture, host: { ...fixture.host, operationSignal: operations.signal } },
      id,
    );
    const { commit } = prepared;
    if (commit === undefined) throw new Error('Expected a prepared exchange');
    operations.abort(new Error('Internal stop reason'));
    await fixture.host.database.transaction(async (tx) => {
      await fixture.owner.revokeIn(tx);
      await expect(commit(anonymous, tx)).rejects.toMatchObject({
        name: 'WorkerRedemptionError',
        code: 'rejected',
        message: 'Run redemption host stopped',
      });
    });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', revoked: true, stored: null });
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
  });

  it('returns the first committed reply to a separately prepared same-secret exchange', async () => {
    const fixture = await start('same-secret');
    const [winner, rival] = await compete(fixture, 'same-secret', runtimeSecret);
    expect(rival).toEqual(winner);
  });

  it('refuses a separately prepared competitor with a different runtime secret', async () => {
    const fixture = await start('competing-secret');
    const [winner, rival] = await compete(fixture, 'competing-secret', 'different-secret');
    expect(rival).toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({ stored: { accepted: winner } });
  });

  it('rejects first use when proof names a different allocation', async () => {
    const fixture = await start('proof-first-use');
    const policy: StartValueVisibility = {
      kind: 'externally-visible',
      async verifyPlatform(ref) {
        return ref.providerData.allocation === 'some-other-allocation'
          ? new Date(fixture.deadline).toISOString()
          : undefined;
      },
    };
    await expect((await prepare(fixture, 'proof-first-use', {}, policy)).exchange()).resolves.toEqual({
      reject: 'rejected',
    });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

  it('refuses replay after the owner revokes the run', async () => {
    const fixture = await start('revoked-replay');
    const winner = await (await prepare(fixture, 'revoked-replay')).exchange();
    expect(winner).toHaveProperty('party');
    await fixture.owner.close();
    await expect((await prepare(fixture, 'revoked-replay')).exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'closed', stored: { accepted: winner } });
  });

  it('rejects replay with a proof that does not verify the stored allocation', async () => {
    const fixture = await start('proof-replay');
    const verified = {
      kind: 'externally-visible',
      async verifyPlatform() {
        return new Date(fixture.deadline).toISOString();
      },
    } as const;
    const winner = await (await prepare(fixture, 'proof-replay', {}, verified)).exchange();
    expect(winner).toHaveProperty('party');
    const invalid = {
      kind: 'externally-visible',
      async verifyPlatform() {
        return undefined;
      },
    } as const;
    await expect((await prepare(fixture, 'proof-replay', {}, invalid)).exchange()).resolves.toEqual({
      reject: 'rejected',
    });
    await expect(fixture.owner.read()).resolves.toMatchObject({ stored: { accepted: winner } });
  });

  it('rejects separate binding preparation for an atomic redemption booking', async () => {
    const fixture = await start('separate-prepare');
    await expect(fixture.prepareSeparateBinding()).rejects.toThrow(AllocationBindingRequiresRedemptionError);
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

  it('rejects a prepared separate binding after the owner enables atomic redemption', async () => {
    const fixture = await start('separate-commit', 'legacy');
    const binding = await fixture.prepareSeparateBinding();
    if (binding === undefined) throw new Error('Expected a prepared separate binding');
    await fixture.owner.enableRedemption();
    await expect(fixture.host.database.transaction(binding.bind)).rejects.toThrow(
      AllocationBindingRequiresRedemptionError,
    );
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

  it('preserves the caller write after a caught separate binding refusal', async () => {
    const fixture = await start('separate-binding-refusal', 'legacy');
    const binding = await fixture.prepareSeparateBinding();
    if (binding === undefined) throw new Error('Expected a prepared separate binding');
    vi.setSystemTime(fixture.deadline);
    await fixture.host.database.transaction(async (tx) => {
      await fixture.owner.revokeIn(tx);
      await expect(binding.bind(tx)).rejects.toThrow('Allocation binding is no longer valid');
    });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', revoked: true, stored: null });
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
  });

  it('commits a managed redemption when inspection authorizes host supervision', async () => {
    const fixture = await start('managed-accept', 'managed');
    const exchange = await prepare(fixture, 'managed-accept');
    expectPrepared(exchange);
    const result = await exchange.exchange();
    expect(result).toHaveProperty('party');
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: fixture.allocation });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'redeemed', stored: { accepted: result } });
  });

  it('proves the settled sender reference when listing finds it on the second page', async () => {
    const id = 'managed-multipage';
    const cursors: (string | undefined)[] = [];
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async listAllocations(call, request, signal) {
        cursors.push(request.cursor);
        return request.cursor === undefined
          ? { observations: [], nextCursor: 'second' }
          : recovery.listAllocations(call, request, signal);
      },
    }));
    await fixture.finishProvision();
    await expect(fixture.readDispatch()).resolves.toMatchObject({
      candidates: [fixture.allocation],
      boundAllocation: null,
      sendSettled: true,
    });
    const result = await (await prepare(fixture, id)).exchange();
    expect(cursors).toEqual([undefined, 'second']);
    expect(result).toHaveProperty('party');
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: fixture.allocation });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'redeemed', stored: { accepted: result } });
  });

  it('refuses competing managed references even after the sender settles', async () => {
    const id = 'managed-disagreement';
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async listAllocations() {
        return {
          observations: [
            {
              jobRunId: id,
              allocationRef: {
                version: 1,
                providerId: 'example.worker:primary',
                providerData: { allocation: 'different' },
              },
              state: 'running',
            },
          ],
          completeness: { kind: 'complete' },
        };
      },
    }));
    await fixture.finishProvision();
    const dispatch = await fixture.readDispatch();
    await expect((await prepare(fixture, id)).exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

  it('keeps the sender unbound when supervision has already stored a different candidate', async () => {
    const id = 'managed-observation-before-send';
    const observed: ProviderAllocationRef = {
      version: 1,
      providerId: 'example.worker:primary',
      providerData: { allocation: 'observed-before-send' },
    };
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async listAllocations() {
        return {
          observations: [{ jobRunId: id, allocationRef: observed, state: 'running' }],
          completeness: { kind: 'complete' },
        };
      },
    }));
    await fixture.supervise();
    await expect(fixture.readDispatch()).resolves.toMatchObject({ sendSettled: false, candidates: [observed] });
    await fixture.finishProvision();
    const dispatch = await fixture.readDispatch();
    expect(dispatch).toMatchObject({
      sendSettled: true,
      senderReference: fixture.allocation,
      candidates: [observed, fixture.allocation],
      boundAllocation: null,
    });
    await expect((await prepare(fixture, id)).exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

  it('refuses a candidate observed only in incomplete listings after a send without a usable reference', async () => {
    const id = 'managed-observed-only';
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async listAllocations(call, request, signal) {
        const { observations } = await recovery.listAllocations(call, request, signal);
        return {
          observations,
          completeness: {
            kind: 'unknown',
            evidence: {
              source: 'test-listing',
              summary: 'Listing did not complete',
              observedAt: new Date().toISOString(),
            },
          },
        };
      },
    }));
    await fixture.finishProvision({ ...fixture.allocation, providerId: 'example.worker:other' });
    await expect(fixture.readDispatch()).resolves.toMatchObject({ sendSettled: true, candidates: [] });
    await fixture.supervise();
    const claim = await fixture.readDispatch();
    const order = await fixture.owner.read();
    expect(claim).toMatchObject({ sendSettled: true, candidates: [fixture.allocation], boundAllocation: null });
    await expect((await prepare(fixture, id)).exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.readDispatch()).resolves.toEqual(claim);
    await expect(fixture.owner.read()).resolves.toEqual(order);
  });

  it('aborts a hanging managed inspection at bootstrap expiry and releases its handle', async () => {
    const id = 'managed-inspection-deadline';
    const inspecting = Promise.withResolvers<AbortSignal>();
    const released = Promise.withResolvers<void>();
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async attach(call, binding, ref, signal) {
        const handle = await recovery.attach(call, binding, ref, signal);
        return {
          ...handle,
          async release() {
            await handle.release();
            released.resolve();
          },
        };
      },
      async inspect(_call, _binding, _ref, signal) {
        inspecting.resolve(signal);
        return new Promise(() => {});
      },
    }));
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const attempt = prepare(fixture, id);
    const signal = await Promise.race([
      inspecting.promise,
      attempt.then(() => {
        throw new Error('Preparation ended before inspection');
      }),
    ]);
    await vi.advanceTimersByTimeAsync(fixture.deadline - Date.now());
    await expect(attempt.then((exchange) => exchange.exchange())).resolves.toEqual({ reject: 'rejected' });
    expect(signal.aborted).toBe(true);
    await released.promise;
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it('releases an attachment that completes after bootstrap expiry without inspecting it', async () => {
    const id = 'managed-attachment-deadline';
    const attaching = Promise.withResolvers<AbortSignal>();
    const resume = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let inspected = false;
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async attach(call, binding, ref, signal) {
        const handle = await recovery.attach(call, binding, ref, signal);
        attaching.resolve(signal);
        await resume.promise;
        return {
          ...handle,
          async release() {
            await handle.release();
            released.resolve();
          },
        };
      },
      async inspect(call, binding, ref, signal) {
        inspected = true;
        return recovery.inspect(call, binding, ref, signal);
      },
    }));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const attempt = prepare(fixture, id);
    const signal = await Promise.race([
      attaching.promise,
      attempt.then(() => {
        throw new Error('Preparation ended before attachment');
      }),
    ]);
    try {
      await vi.advanceTimersByTimeAsync(fixture.deadline - Date.now());
      await expect(attempt.then((exchange) => exchange.exchange())).resolves.toEqual({ reject: 'rejected' });
      expect(signal.aborted).toBe(true);
    } finally {
      resume.resolve();
    }
    await released.promise;
    expect(inspected).toBe(false);
  });

  it('aborts a hanging replay verifier at the stored identity deadline', async () => {
    const id = 'replay-verifier-deadline';
    const fixture = await start(id);
    const winner = await (await prepare(fixture, id)).exchange();
    if (winner.expiresAt === undefined) throw new Error('Expected a live run identity');
    const deadline = Date.parse(winner.expiresAt);
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    const verifying = Promise.withResolvers<AbortSignal>();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(fixture.deadline);
    const attempt = prepare(
      fixture,
      id,
      {},
      {
        kind: 'externally-visible',
        async verifyPlatform(_ref, signal) {
          verifying.resolve(signal);
          return new Promise(() => {});
        },
      },
    );
    const signal = await Promise.race([
      verifying.promise,
      attempt.then(() => {
        throw new Error('Preparation ended before platform verification');
      }),
    ]);
    await vi.advanceTimersByTimeAsync(deadline - Date.now());
    await expect(attempt.then((exchange) => exchange.exchange())).resolves.toEqual({ reject: 'rejected' });
    expect(signal.aborted).toBe(true);
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it('leaves both tables unchanged when managed proof rejects the allocation', async () => {
    const fixture = await start('managed-reject', 'managed');
    const dispatch = await fixture.readDispatch();
    const order = await fixture.owner.read();
    expect(dispatch).toMatchObject({ candidates: [], boundAllocation: null });
    const verifiedRefs: ProviderAllocationRef[] = [];
    const rejectedExchange = await prepare(
      fixture,
      'managed-reject',
      {},
      {
        kind: 'externally-visible',
        async verifyPlatform(ref) {
          verifiedRefs.push(ref);
          return undefined;
        },
      },
    );
    expect(verifiedRefs).toEqual([fixture.allocation]);
    await expect(rejectedExchange.exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
    await expect(fixture.owner.read()).resolves.toEqual(order);
  });

  it('records the managed provisioning observation without assigning the allocation', async () => {
    const fixture = await start('managed-observation', 'managed');
    await fixture.finishProvision();
    await expect(fixture.readDispatch()).resolves.toMatchObject({
      candidates: [fixture.allocation],
      boundAllocation: null,
      sendSettled: true,
    });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

  it('records durable managed supervision evidence without assigning the allocation', async () => {
    const fixture = await start('managed-supervision', 'managed');
    await expect(fixture.supervise()).resolves.toMatchObject({ lastAttachFailure: null });
    await expect(fixture.readDispatch()).resolves.toMatchObject({
      candidates: [fixture.allocation],
      boundAllocation: null,
      sendSettled: false,
    });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

  it('refuses prepared redemption at the bootstrap deadline', async () => {
    const fixture = await start('deadline-before-commit');
    const exchange = await prepare(fixture, 'deadline-before-commit');
    expectPrepared(exchange);
    vi.setSystemTime(fixture.deadline);
    await expect(exchange.exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

  it('refuses prepared redemption after revocation before commit', async () => {
    const fixture = await start('revoke-before-commit');
    const exchange = await prepare(fixture, 'revoke-before-commit');
    expectPrepared(exchange);
    await fixture.owner.revoke();
    await expect(exchange.exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', revoked: true, stored: null });
  });

  it('refuses replay after revocation while the run stays open', async () => {
    const fixture = await start('revoke-live');
    const winner = await (await prepare(fixture, 'revoke-live')).exchange();
    expect(winner).toHaveProperty('party');
    await fixture.owner.revoke();
    await expect((await prepare(fixture, 'revoke-live')).exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({
      state: 'redeemed',
      revoked: true,
      stored: { accepted: winner },
    });
  });

  it('refuses replay at the identity deadline while the run stays open', async () => {
    const fixture = await start('identity-deadline');
    const winner = await (await prepare(fixture, 'identity-deadline')).exchange();
    if (winner.expiresAt === undefined) throw new Error('Expected a live run identity');
    const before = await fixture.owner.read();
    vi.setSystemTime(Date.parse(winner.expiresAt));
    await expect((await prepare(fixture, 'identity-deadline')).exchange()).resolves.toEqual({ reject: 'rejected' });
    expect(before).toMatchObject({ state: 'redeemed', revoked: false });
    await expect(fixture.owner.read()).resolves.toEqual(before);
  });

  it('maps a thrown platform verifier error to generic rejection', async () => {
    const fixture = await start('proof-error');
    const exchange = await prepare(
      fixture,
      'proof-error',
      {},
      {
        kind: 'externally-visible',
        async verifyPlatform() {
          throw new Error('Sensitive verifier detail');
        },
      },
    );
    await expect(exchange.exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: null });
  });

  it('refuses a prepared commit invoked from a different anonymous connection', async () => {
    const fixture = await start('foreign-connection');
    const prepared = await prepare(fixture, 'foreign-connection');
    expectPrepared(prepared);
    const other = callFromReceive(
      { transportName: 'worker-test', connectionId: 'other-peer' },
      undefined,
      undefined,
      () => {},
    );
    await expect(prepared.exchange(other)).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });
});
