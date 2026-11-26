import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { createBusInstance } from '@makaio/bus-core';
import { callFromReceive } from '@makaio/bus-core/kernel-api';
import { ConnectionExchangeConfigurationError } from '@makaio/bus-transport-websocket';
import type { HostDatabase, ProviderAllocationRef } from '@makaio/contracts';
import {
  type ConnectionExchangeAccepted,
  type ConnectionExchangeCommit,
  type ConnectionExchangeRejected,
  type WorkerExchangeRequest,
  type WorkerRunIdentityRequest,
  WORKER_REDEMPTION_EXCHANGE,
  WorkerRunIdentityReplySchema,
} from '@makaio/contracts/boundary';
import { AllocationBindingRequiresRedemptionError, type StartValueVisibility } from '@makaio/contracts/capabilities';
import type { OrderedWorkerProvider } from '@makaio/contracts/extension';
import { CorePartyKind, type CallContext } from '@makaio/core';
import { ExtensionCoordinator, type ExtensionContextBase } from '@makaio/kernel';
import { createHostDatabase, getHostTransactionQueryContext, type RawSqlExecutor } from '@makaio/storage-drizzle';
import {
  resolveStorageConformanceConfig,
  useJournalHostFixture,
  useSuiteDatabaseContext,
} from '@makaio/storage-conformance';
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, expectTypeOf, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { createWorkerConnectionExchange } from '../../../../../runtimes/node/src/worker-connection-exchange.js';
import {
  prepareWorkerRedemption,
  WorkerRedemptionError,
  type WorkerRedemptionHost,
} from '../../internal/worker-provider-host-binding.js';
import { AllocationObservationSignal, type ObservationWatch } from '../allocation-observation-signal.js';
import { digestWorkerBootstrapToken, digestWorkerRuntimeSecret } from '../credential-digest.js';
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

/** Observe the real subscription lifecycle and the checkpoint after proof preparation. */
class ObservedAllocationSignal extends AllocationObservationSignal {
  public readonly checked = Promise.withResolvers<void>();
  public subscriptions = 0;

  /**
   * Track active registrations without changing notification delivery.
   * @param jobRunId - Run being checked.
   * @returns Instrumented subscription.
   */
  public override watch(jobRunId: string): ObservationWatch {
    const watch = super.watch(jobRunId);
    this.subscriptions++;
    let captured = false;
    return {
      changed: () => {
        if (captured) this.checked.resolve();
        captured = true;
        return watch.changed();
      },
      dispose: () => {
        watch.dispose();
        this.subscriptions--;
      },
    };
  }
}

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
  const observations = new ObservedAllocationSignal();
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
          allocationObservation: observations,
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
    observations,
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

type MarkRedemptionPhase = (
  phase: 'rival started' | 'prepared' | 'write-locked' | 'winner committed' | 'rival completed',
) => void;

interface RedemptionRival {
  readonly entered: Promise<void>;
  /**
   * Observe the rival and request its transaction once the winner holds its write lock.
   * @param written - The winning transaction has written or failed.
   * @param winner - The winning transaction, including its commit.
   */
  begin(written: Promise<void | ExchangeOutcome>, winner: Promise<ExchangeOutcome>): Promise<ExchangeOutcome>;
}

/**
 * Prepare an independently connected rival that reports SQLite write contention.
 * @param executor - The SQLite conformance database's raw executor.
 * @param input - Booked run and local provider fixture shared with the rival.
 * @param mark - Optional test phase recorder.
 */
async function startSqliteRival(
  executor: RawSqlExecutor,
  input: Omit<SqliteContenderInput, 'databaseUrl'>,
  mark?: MarkRedemptionPhase,
): Promise<RedemptionRival> {
  const files = await executor.all<{ name: string; file: string }>(sql`PRAGMA database_list`);
  const file = files.find(({ name }) => name === 'main')?.file;
  if (!file) throw new Error('Expected a file-backed SQLite conformance database');
  const worker = new Worker(new URL('./sqlite-redemption-contender.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
    workerData: { ...input, databaseUrl: pathToFileURL(file).href } satisfies SqliteContenderInput,
  });
  mark?.('rival started');
  onTestFinished(async () => {
    await worker.terminate();
  });
  const prepared = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<ExchangeOutcome>();
  worker.on('message', (message: SqliteContenderMessage) => {
    if (message.kind === 'prepared') {
      mark?.('prepared');
      prepared.resolve();
    } else if (message.kind === 'write-locked') {
      mark?.('write-locked');
      entered.resolve();
    } else {
      mark?.('rival completed');
      completed.resolve(message.result);
    }
  });
  worker.once('error', (cause) => completed.reject(new Error('SQLite rival thread failed', { cause })));
  worker.once('exit', (code) =>
    completed.reject(new Error(`SQLite rival thread exited before completion (code ${code})`)),
  );
  await Promise.race([prepared.promise, completed.promise]);
  return {
    entered: entered.promise,
    begin(written, winner) {
      void written
        .then(() => worker.postMessage('commit'))
        .then(() => winner)
        .then(() => worker.postMessage('winner-committed'))
        .catch(completed.reject);
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
 * @param connectionDeadline - Trusted setup deadline for this attempt.
 */
async function prepare(
  fixture: Fixture,
  jobRunId: string,
  credentials: { token?: string; secret?: string } = {},
  policy: StartValueVisibility = localPolicy,
  connectionDeadline = Date.now() + 120_000,
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
    connectionDeadline,
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
 * Exercise the protected setup handler against the same persisted owner and dispatch.
 * @param fixture - Booked run with real storage and allocation verification.
 * @param jobRunId - Run belonging to the test owner.
 * @returns The original bootstrap and identity-only presentations.
 */
function protectedPresentations(fixture: Fixture, jobRunId: string) {
  const exchange = createWorkerConnectionExchange(fixture.host, {
    maxPendingExchanges: 1,
    async withRunPromotion() {
      // These presentations exercise the stored acceptance without publishing a socket.
    },
    async verifyProof(_proof, allocation) {
      return isDeepStrictEqual(allocation, fixture.allocation) ? new Date(fixture.deadline).toISOString() : undefined;
    },
  });
  /** Create the trusted setup context for a connection. */
  function context() {
    return {
      connectionId: 'protected-peer',
      deadline: fixture.deadline,
      signal: fixture.host.operationSignal,
      markProofVerified: () => {},
    };
  }

  const bootstrap: WorkerExchangeRequest = {
    type: 'connection-exchange',
    exchange: WORKER_REDEMPTION_EXCHANGE,
    presented: { jobRunId, oneTimeToken: fixtureToken, runtimeSecret, proof: null },
  };
  const identity: WorkerRunIdentityRequest = { kind: 'job-run', jobRunId, runtimeSecret };
  return {
    bootstrap: () => exchange.admit(JSON.stringify(bootstrap), context()),
    reconnect: () => exchange.admit(JSON.stringify(identity), context()),
  };
}

/**
 * Require a pending storage callback for the test's pre-commit assertions.
 * @param value - Prepared exchange.
 */
function expectPrepared(value: { prepared: { commit?: ConnectionExchangeCommit['commit'] } }) {
  expect(value.prepared.commit).toBeTypeOf('function');
}

/**
 * Require a post-proof correlation check before provoking a wakeup or timeout.
 * @param fixture - Run whose real observation subscription is armed.
 * @param pending - Preparation that must still be in progress.
 */
async function expectWaiting(fixture: Fixture, pending: ReturnType<typeof prepare>): Promise<void> {
  await Promise.race([
    fixture.observations.checked.promise,
    pending.then(() => {
      throw new Error('Preparation ended before checking for an allocation observation');
    }),
  ]);
  expect(fixture.observations.subscriptions).toBe(1);
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

  it('fails at binding with a classified error if the host signal is missing', async () => {
    const { host } = await start('missing-host-signal');
    const binding = { ...host };
    Reflect.deleteProperty(binding, 'operationSignal');
    expect(() =>
      createWorkerConnectionExchange(binding, {
        maxPendingExchanges: 1,
        withRunPromotion: async () => {},
        verifyProof: async () => undefined,
      }),
    ).toThrow(
      expect.toSatisfy(
        (error: unknown) =>
          error instanceof ConnectionExchangeConfigurationError && error.code === 'WS_INVALID_EXCHANGE_HOST_SIGNAL',
      ),
    );
  });

  it('refuses to bind the worker exchange without an owner promotion boundary', async () => {
    const { host, owner } = await start('missing-owner-promotion');
    const options = {
      maxPendingExchanges: 1,
      withRunPromotion: async () => {},
      verifyProof: async () => undefined,
    };
    Reflect.deleteProperty(options, 'withRunPromotion');
    expect(() => createWorkerConnectionExchange(host, options)).toThrow(
      expect.toSatisfy(
        (error: unknown) =>
          error instanceof ConnectionExchangeConfigurationError && error.code === 'WS_MISSING_WORKER_PROMOTION',
      ),
    );
    await expect(owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
  });

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
   * @param mark - Optional test phase recorder.
   */
  async function prepareRival(
    fixture: Fixture,
    jobRunId: string,
    runtimeSecret: string,
    mark?: MarkRedemptionPhase,
  ): Promise<RedemptionRival> {
    const context = getContext();
    if (context.dialect === 'sqlite') {
      return startSqliteRival(
        context.executor,
        {
          jobRunId,
          runtimeSecret,
          allocation: fixture.allocation,
          deadline: fixture.deadline,
          processIncarnation: fixture.host.processIncarnation,
        },
        mark,
      );
    }
    const second = await prepare(await siblingFixture(fixture), jobRunId, { secret: runtimeSecret });
    expectPrepared(second);
    const entered = Promise.withResolvers<void>();
    return {
      entered: entered.promise,
      begin: (written) => written.then(() => second.exchange(undefined, { enter: entered.resolve })),
    };
  }

  /**
   * Hold the winner's real write transaction while comparing two setup attempts.
   * @param fixture - Booked run.
   * @param id - Run presented by both runtimes.
   * @param secondSecret - Runtime secret used by the competing connection.
   * @param mark - Optional test phase recorder.
   */
  async function compete(fixture: Fixture, id: string, secondSecret: string, mark?: MarkRedemptionPhase) {
    const first = await prepare(fixture, id);
    expectPrepared(first);
    const contender = await prepareRival(fixture, id, secondSecret, mark);
    const written = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const winner = first
      .exchange(undefined, {
        async beforeRelease(result) {
          expect(result).toHaveProperty('party');
          written.resolve();
          await release.promise;
        },
      })
      .then((result) => {
        mark?.('winner committed');
        return result;
      });
    const rival = contender.begin(Promise.race([written.promise, winner]), winner);
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
    expect(row.tokenDigest).toBe(digestWorkerBootstrapToken(fixtureToken));
    expect(row.stored.runtimeDigest).toBe(digestWorkerRuntimeSecret(runtimeSecret));
    await expect(fixture.host.database.transaction((tx) => readDispatch(tx, 'first-valid'))).resolves.toMatchObject({
      boundAllocation: fixture.allocation,
    });
  });

  it('preserves direct atomic redemption without an issuer key and refuses protected replay', async () => {
    const id = 'direct-without-issuer-key';
    const fixture = await start(id);
    await fixture.owner.setIssuerIdentityKey(undefined);
    const result = await (await prepare(fixture, id)).exchange();
    expect(result.revocationKey === `worker-run:${id}`).toBe(true);
    const before = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    expect(before?.state).toBe('redeemed');
    expect(dispatch?.boundAllocation != null).toBe(true);

    const protectedExchange = protectedPresentations(fixture, id);
    expect((await protectedExchange.bootstrap()) === undefined).toBe(true);
    expect((await protectedExchange.reconnect()) === undefined).toBe(true);
    expect(isDeepStrictEqual(await fixture.owner.read(), before)).toBe(true);
    expect(isDeepStrictEqual(await fixture.readDispatch(), dispatch)).toBe(true);
  });

  it('leaves a fresh booking without an issuer key unconsumed and unbound', async () => {
    const id = 'protected-without-issuer-key';
    const fixture = await start(id);
    await fixture.finishProvision();
    await fixture.owner.setIssuerIdentityKey(undefined);
    const before = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();

    expect((await protectedPresentations(fixture, id).bootstrap()) === undefined).toBe(true);
    expect(before?.state).toBe('ordered');
    expect(before?.stored === null).toBe(true);
    expect(dispatch?.boundAllocation === null).toBe(true);
    expect(isDeepStrictEqual(await fixture.owner.read(), before)).toBe(true);
    expect(isDeepStrictEqual(await fixture.readDispatch(), dispatch)).toBe(true);
  });

  it('requires the same persisted opaque issuer key for protected bootstrap replay and reconnect', async () => {
    const id = 'protected-issuer-key';
    const fixture = await start(id);
    await fixture.finishProvision();
    const protectedExchange = protectedPresentations(fixture, id);
    const first = await protectedExchange.bootstrap();
    if (first === undefined) throw new Error('Protected first use refused');
    const before = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    const replay = await protectedExchange.bootstrap();
    const identity = await protectedExchange.reconnect();
    const identityReply = WorkerRunIdentityReplySchema.safeParse(JSON.parse(identity?.reply ?? 'null'));
    expect(before?.state).toBe('redeemed');
    expect(dispatch?.boundAllocation != null).toBe(true);
    expect(first.revocationKey === before?.booking.identityRevocationKey).toBe(true);
    expect(first.revocationKey === before?.stored?.accepted.revocationKey).toBe(true);
    expect(replay?.reply === first.reply).toBe(true);
    expect(identity?.revocationKey === first.revocationKey).toBe(true);
    expect(identityReply.success).toBe(true);
    expect(identityReply.data?.identity).toEqual({ jobRunId: id, expiresAt: first.expiresAt });
    expect(Date.parse(first.expiresAt ?? '') > Date.now()).toBe(true);

    await fixture.owner.setIssuerIdentityKey('replacement-issuer-key');
    expect((await protectedExchange.bootstrap()) === undefined).toBe(true);
    expect((await protectedExchange.reconnect()) === undefined).toBe(true);
    const after = await fixture.owner.read();
    expect(after?.state).toBe('redeemed');
    expect(after?.booking.identityRevocationKey !== before?.booking.identityRevocationKey).toBe(true);
    expect(isDeepStrictEqual(after?.stored, before?.stored)).toBe(true);
    expect(isDeepStrictEqual(await fixture.readDispatch(), dispatch)).toBe(true);
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

  it('refuses the old untagged token digest without changing the booking or dispatch', async () => {
    const id = 'untagged-token';
    const fixture = await start(id);
    await fixture.owner.storeUntaggedToken();
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();

    await expect((await prepare(fixture, id)).exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it('wakes a waiting redemption after the sender commits its reference', async () => {
    const id = 'pending-sender';
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async listAllocations() {
        return { observations: [], completeness: { kind: 'complete' } };
      },
    }));
    const pending = prepare(fixture, id);
    await expectWaiting(fixture, pending);
    await expect(fixture.readDispatch()).resolves.toMatchObject({ candidates: [], boundAllocation: null });
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });

    await fixture.finishProvision();
    const exchange = await pending;
    expect(fixture.observations.subscriptions).toBe(0);
    expectPrepared(exchange);
    await expect(fixture.readDispatch()).resolves.toMatchObject({
      senderReference: fixture.allocation,
      boundAllocation: null,
    });
    await expect(exchange.exchange()).resolves.toHaveProperty('party.id', id);
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: fixture.allocation });
  });

  it('wakes a waiting redemption after managed supervision commits its observation', async () => {
    const id = 'pending-supervision';
    let visible = false;
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async listAllocations(call, request, signal) {
        if (visible) return recovery.listAllocations(call, request, signal);
        return { observations: [], completeness: { kind: 'complete' } };
      },
    }));
    const pending = prepare(fixture, id);
    await expectWaiting(fixture, pending);
    await expect(fixture.readDispatch()).resolves.toMatchObject({ candidates: [], sendSettled: false });

    visible = true;
    await fixture.supervise();
    const exchange = await pending;
    expect(fixture.observations.subscriptions).toBe(0);
    expectPrepared(exchange);
    await expect(exchange.exchange()).resolves.toHaveProperty('party.id', id);
    await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: fixture.allocation });
  });

  it.each([
    'matching reference',
    'no usable reference',
    'deadline',
  ] as const)('waits after an incomplete listing until %s', async (ending) => {
    const id = `incomplete-before-sender-${ending.replaceAll(' ', '-')}`;
    let attachments = 0;
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async listAllocations(call, request, signal) {
        if (request.cursor !== undefined) return { observations: [], nextCursor: request.cursor };
        const { observations } = await recovery.listAllocations(call, request, signal);
        return { observations, nextCursor: 'incomplete' };
      },
      async attach(call, binding, ref, signal) {
        attachments++;
        return recovery.attach(call, binding, ref, signal);
      },
    }));
    const order = await fixture.owner.read();
    const before = await fixture.readDispatch();
    if (ending === 'deadline') vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const pending = prepare(fixture, id);
    await expectWaiting(fixture, pending);
    await expect(fixture.readDispatch()).resolves.toMatchObject({ sendSettled: false, boundAllocation: null });
    expect(fixture.observations.subscriptions).toBe(1);
    expect(attachments).toBe(0);

    if (ending === 'matching reference') {
      await fixture.finishProvision();
    } else if (ending === 'no usable reference') {
      await fixture.finishProvision({ ...fixture.allocation, providerId: 'example.worker:other' });
    } else {
      await vi.advanceTimersByTimeAsync(fixture.deadline - Date.now());
    }
    const dispatch = await fixture.readDispatch();
    expect(dispatch).toMatchObject({ sendSettled: ending !== 'deadline', boundAllocation: null });
    const exchange = await pending;
    expect(fixture.observations.subscriptions).toBe(0);
    if (ending === 'matching reference') {
      expectPrepared(exchange);
      expect(dispatch?.senderReference).toEqual(fixture.allocation);
      expect(attachments).toBe(1);
      await expect(exchange.exchange()).resolves.toHaveProperty('party.id', id);
      await expect(fixture.readDispatch()).resolves.toMatchObject({ boundAllocation: fixture.allocation });
    } else {
      await expect(exchange.exchange()).resolves.toEqual({ reject: 'rejected' });
      expect(attachments).toBe(0);
      if (ending === 'deadline') expect(dispatch).toEqual(before);
      await expect(fixture.owner.read()).resolves.toEqual(order);
      await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
    }
  });

  it('rereads after the sender commits during an incomplete listing', async () => {
    const id = 'sender-during-listing';
    const listing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let exchangeLists = 0;
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async listAllocations(call, request, signal) {
        if (call.caller.kind !== CorePartyKind.host || ++exchangeLists === 1) {
          return { observations: [], completeness: { kind: 'complete' } };
        }
        if (request.cursor !== undefined) return { observations: [], nextCursor: request.cursor };
        if (exchangeLists === 2) {
          listing.resolve();
          await release.promise;
        }
        const { observations } = await recovery.listAllocations(call, request, signal);
        return { observations, nextCursor: 'incomplete' };
      },
    }));
    const pending = prepare(fixture, id);
    try {
      await expectWaiting(fixture, pending);
      await fixture.supervise();
      await Promise.race([
        listing.promise,
        pending.then(() => {
          throw new Error('Preparation ended before the second listing');
        }),
      ]);
      await expect(fixture.readDispatch()).resolves.not.toHaveProperty('senderReference');
      await fixture.finishProvision();
      await expect(fixture.readDispatch()).resolves.toHaveProperty('senderReference', fixture.allocation);
    } finally {
      release.resolve();
    }

    const exchange = await pending;
    expectPrepared(exchange);
    await expect(exchange.exchange()).resolves.toHaveProperty('party.id', id);
  });

  it('refuses to bind when a supervision wakeup supplies only an incomplete listing', async () => {
    const id = 'pending-incomplete';
    let visible = false;
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async listAllocations(call, request, signal) {
        if (!visible) {
          return { observations: [], completeness: { kind: 'complete' } };
        }
        const { observations } = await recovery.listAllocations(call, request, signal);
        return { observations, nextCursor: 'incomplete' };
      },
    }));
    await fixture.finishProvision({ ...fixture.allocation, providerId: 'example.worker:other' });
    const order = await fixture.owner.read();
    let credentialReads = 0;
    let platformChecks = 0;
    const owner = fixture.owner.sourceFor(getContext().executor);
    const source: AtomicRedemptionWorkerOrderSource = {
      ...owner,
      readRedemptionCredentials(jobRunId, signal) {
        credentialReads++;
        return owner.readRedemptionCredentials(jobRunId, signal);
      },
    };
    const pending = prepare(
      { ...fixture, host: { ...fixture.host, source } },
      id,
      {},
      {
        kind: 'externally-visible',
        async verifyPlatform() {
          platformChecks++;
          return new Date(fixture.deadline).toISOString();
        },
      },
    );
    await expectWaiting(fixture, pending);
    expect(credentialReads).toBe(2);
    await expect(fixture.readDispatch()).resolves.toMatchObject({ candidates: [], sendSettled: true });

    visible = true;
    await fixture.supervise();
    const dispatch = await fixture.readDispatch();
    expect(dispatch).toMatchObject({
      candidates: [fixture.allocation],
      boundAllocation: null,
    });
    expect(dispatch?.senderReference).toBeUndefined();
    await expect((await pending).exchange()).resolves.toEqual({ reject: 'rejected' });
    expect(fixture.observations.subscriptions).toBe(0);
    expect(credentialReads).toBe(4);
    expect(platformChecks).toBe(0);
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it('ends a pending observation at the bootstrap deadline without changing storage or retaining a handle', async () => {
    const id = 'pending-deadline';
    let attachments = 0;
    const fixture = await start(id, 'managed', (recovery) => ({
      ...recovery,
      async listAllocations() {
        return { observations: [], completeness: { kind: 'complete' } };
      },
      async attach(call, binding, ref, signal) {
        attachments++;
        return recovery.attach(call, binding, ref, signal);
      },
    }));
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const pending = prepare(fixture, id);
    await expectWaiting(fixture, pending);
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await vi.advanceTimersByTimeAsync(fixture.deadline - Date.now() - 1);
    expect(fixture.observations.subscriptions).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect((await pending).exchange()).resolves.toEqual({ reject: 'rejected' });
    expect(fixture.observations.subscriptions).toBe(0);
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
    expect(attachments).toBe(0);
    expect(fixture.host.handles.size).toBe(0);
  });

  it.each(['deadline', 'host abort'] as const)('bounds the first credential read by %s', async (end) => {
    const id = `stalled-read-${end}`;
    const fixture = await start(id);
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    const operations = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const source = fixture.owner.sourceFor(getContext().executor);
    const reader: AtomicRedemptionWorkerOrderSource = {
      ...source,
      async readRedemptionCredentials(jobRunId, signal) {
        entered.resolve();
        await release.promise;
        return source.readRedemptionCredentials(jobRunId, signal);
      },
    };
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const host = { ...fixture.host, source: reader, operationSignal: operations.signal };
    const pending = prepare({ ...fixture, host }, id, {}, localPolicy, fixture.deadline);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('Preparation ended before reading credentials');
        }),
      ]);
      expect(fixture.observations.subscriptions).toBe(1);
      if (end === 'deadline') await vi.advanceTimersByTimeAsync(fixture.deadline - Date.now());
      else operations.abort();
      await expect((await pending).exchange()).resolves.toEqual({ reject: 'rejected' });
      expect(fixture.observations.subscriptions).toBe(0);
    } finally {
      release.resolve();
    }
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it.each([
    ['bootstrap-as-runtime', fixtureToken, digestWorkerBootstrapToken(fixtureToken)],
    ['untagged-runtime', runtimeSecret, createHash('sha256').update(runtimeSecret).digest('hex')],
  ])('refuses replay with a %s digest in the runtime slot', async (id, secret, digest) => {
    const fixture = await start(id);
    await expect((await prepare(fixture, id)).exchange()).resolves.toHaveProperty('party.id', id);
    await fixture.owner.replaceRuntimeDigest(digest);
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();

    const replay = await prepare(fixture, id, { secret });
    await expect(replay.exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
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

  it('returns the same refusal for a credential lookup failure and an unknown token', async () => {
    const id = 'credential-lookup-failure';
    const fixture = await start(id);
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    const owner = fixture.owner.sourceFor(getContext().executor);
    const malformedId = 'malformed run id';
    const source: AtomicRedemptionWorkerOrderSource = {
      ...owner,
      async readRedemptionCredentials(jobRunId, signal) {
        if (jobRunId === malformedId) throw new Error('Malformed identifier');
        return owner.readRedemptionCredentials(jobRunId, signal);
      },
    };
    const peer = { ...fixture, host: { ...fixture.host, source } };
    const unknown = await (await prepare(peer, id, { token: 'unknown' })).exchange();
    expect(unknown).toStrictEqual({ reject: 'rejected' });
    expect((await prepare(peer, malformedId)).prepared).toStrictEqual(unknown);
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it.each([
    'before',
    'after',
  ] as const)('handles a second read failure %s expiry after allocation proof', async (when) => {
    const id = `second-read-${when}-expiry`;
    const fixture = await start(id);
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    const owner = fixture.owner.sourceFor(getContext().executor);
    const connectionDeadline = fixture.deadline - 1;
    let reads = 0;
    let platformChecks = 0;
    const source: AtomicRedemptionWorkerOrderSource = {
      ...owner,
      async readRedemptionCredentials(jobRunId, signal) {
        if (++reads === 2) {
          expect(platformChecks).toBe(1);
          if (when === 'after') vi.setSystemTime(connectionDeadline);
          throw new Error('Unexpected credential reread failure');
        }
        return owner.readRedemptionCredentials(jobRunId, signal);
      },
    };
    const policy: StartValueVisibility = {
      kind: 'externally-visible',
      async verifyPlatform() {
        platformChecks++;
        return new Date(fixture.deadline).toISOString();
      },
    };
    const peer = { ...fixture, host: { ...fixture.host, source } };
    // Only move the clock. The expiration timer must still be pending.
    vi.useFakeTimers({ toFake: ['Date'] });
    const pending = prepare(peer, id, {}, policy, connectionDeadline);
    if (when === 'after') {
      await expect(pending).resolves.toHaveProperty('prepared', { reject: 'rejected' });
    } else {
      await expect(pending).rejects.toMatchObject({
        name: 'WorkerRedemptionError',
        code: 'retryable',
        message: 'Run redemption storage read failed',
      });
    }
    vi.useRealTimers();
    expect(reads).toBe(2);
    expect(platformChecks).toBe(1);
    expect(fixture.observations.subscriptions).toBe(0);
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
    await expect((await prepare(peer, id, {}, policy)).exchange()).resolves.toHaveProperty('party.id', id);
  });

  it('invalidates replay proof when the persisted runtime digest changes', async () => {
    const id = 'changed-replay-digest';
    const fixture = await start(id);
    await expect((await prepare(fixture, id)).exchange()).resolves.toHaveProperty('party.id', id);
    const dispatch = await fixture.readDispatch();
    const digest = digestWorkerRuntimeSecret('replacement-runtime-secret');
    const policy: StartValueVisibility = {
      kind: 'externally-visible',
      async verifyPlatform() {
        await fixture.owner.replaceRuntimeDigest(digest);
        return new Date(fixture.deadline).toISOString();
      },
    };
    await expect(prepare(fixture, id, {}, policy)).resolves.toHaveProperty('prepared', { reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({ stored: { runtimeDigest: digest } });
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it.each(['before', 'during'] as const)('refuses a runtime digest removed %s the confirming read', async (when) => {
    const id = `removed-runtime-digest-${when}`;
    const fixture = await start(id);
    await expect((await prepare(fixture, id)).exchange()).resolves.toHaveProperty('party.id', id);
    const dispatch = await fixture.readDispatch();
    const { executor } = getContext();
    const owner = fixture.owner.sourceFor(executor);
    const removeStored = async () => {
      await executor.run(sql`UPDATE redemption_test_order SET state = 'ordered', stored = NULL WHERE id = ${id}`);
    };
    let reads = 0;
    let locks = 0;
    const source: AtomicRedemptionWorkerOrderSource = {
      ...owner,
      async readRedemptionCredentials(jobRunId, signal) {
        const credentials = await owner.readRedemptionCredentials(jobRunId, signal);
        if (++reads === 2 && when === 'during') await removeStored();
        return credentials;
      },
      async lockOrder(tx, jobRunId, signal) {
        locks++;
        return owner.lockOrder(tx, jobRunId, signal);
      },
    };
    const policy: StartValueVisibility = {
      kind: 'externally-visible',
      async verifyPlatform() {
        if (when === 'before') await removeStored();
        return new Date(fixture.deadline).toISOString();
      },
    };
    const peer = { ...fixture, host: { ...fixture.host, source } };
    await expect(prepare(peer, id, {}, policy)).resolves.toHaveProperty('prepared', { reject: 'rejected' });
    expect(reads).toBe(2);
    expect(locks).toBe(when === 'before' ? 1 : 2);
    await expect(fixture.owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it('returns a generic rejection when credential rereading fails before independent proof', async () => {
    const id = 'unproved-credential-reread';
    const fixture = await start(id);
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    const owner = fixture.owner.sourceFor(getContext().executor);
    let reads = 0;
    const source: AtomicRedemptionWorkerOrderSource = {
      ...owner,
      async readRedemptionCredentials(jobRunId, signal) {
        if (++reads === 2) throw new Error('Unexpected credential reread failure');
        return owner.readRedemptionCredentials(jobRunId, signal);
      },
    };
    const peer = { ...fixture, host: { ...fixture.host, source } };
    const policy: StartValueVisibility = {
      kind: 'externally-visible',
      async verifyPlatform() {
        throw new Error('Independent proof unavailable');
      },
    };
    await expect(prepare(peer, id, {}, policy)).resolves.toHaveProperty('prepared', { reject: 'rejected' });
    expect(reads).toBe(2);
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

  it('reports an unexpected owner write failure after proof as retryable and rolls back', async () => {
    const id = 'unexpected-owner-write-failure';
    const fixture = await start(id);
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    const owner = fixture.owner.sourceFor(getContext().executor);
    const source: AtomicRedemptionWorkerOrderSource = {
      ...owner,
      async lockOrder(tx, jobRunId) {
        const locked = await owner.lockOrder(tx, jobRunId);
        if (locked?.redemption === undefined) return locked;
        return {
          ...locked,
          redemption: {
            ...locked.redemption,
            async accept() {
              throw new Error('Unexpected owner write failure');
            },
          },
        };
      },
    };
    const peer = { ...fixture, host: { ...fixture.host, source } };
    const prepared = await prepare(peer, id);
    expectPrepared(prepared);
    await expect(prepared.exchange()).rejects.toMatchObject({
      name: 'WorkerRedemptionError',
      code: 'retryable',
      message: 'Run redemption commit failed',
    });
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
    const retry = await (await prepare(fixture, id)).exchange();
    expect(retry).toHaveProperty('party.id', id);
  });

  it.each([
    'callback-entry',
    'owner-lock',
    'owner-write',
  ] as const)('rolls back redemption when the connection deadline elapses at %s', async (phase) => {
    const id = `commit-deadline-${phase}`;
    const fixture = await start(id);
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    const owner = fixture.owner.sourceFor(getContext().executor);
    const deadline = fixture.deadline - 1;
    const lockRequested = Promise.withResolvers<void>();
    const resumeLock = Promise.withResolvers<void>();
    let committing = false;
    let wroteOwner = false;
    const source: AtomicRedemptionWorkerOrderSource = {
      ...owner,
      async lockOrder(tx, jobRunId, signal) {
        if (committing && phase === 'owner-lock') {
          lockRequested.resolve();
          await resumeLock.promise;
        }
        const locked = await owner.lockOrder(tx, jobRunId, signal);
        if (locked?.redemption === undefined || !committing) return locked;
        const { redemption } = locked;
        return {
          ...locked,
          redemption: {
            ...redemption,
            async accept(commitTx, result) {
              const saved = await redemption.accept(commitTx, result);
              wroteOwner = saved !== undefined;
              if (phase === 'owner-write') vi.setSystemTime(deadline);
              return saved;
            },
          },
        };
      },
    };
    const peer = { ...fixture, host: { ...fixture.host, source } };
    const prepared = await prepare(peer, id, {}, localPolicy, deadline);
    expectPrepared(prepared);
    committing = true;
    if (phase === 'callback-entry') vi.setSystemTime(deadline);
    const pending = prepared.exchange();
    const refusal = expect(pending).rejects.toMatchObject({
      name: 'WorkerRedemptionError',
      code: 'rejected',
      message: 'Run redemption commit failed',
    });
    if (phase === 'owner-lock') {
      try {
        await Promise.race([lockRequested.promise, pending]);
        vi.setSystemTime(deadline);
      } finally {
        resumeLock.resolve();
      }
    }
    await refusal;
    expect(wroteOwner).toBe(phase === 'owner-write');
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it.each([-1, 0, 1])('classifies a typed commit failure at deadline %+i ms and rolls back', async (offset) => {
    const id = `typed-host-transaction-failure-${offset}`;
    const fixture = await start(id);
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    const owner = fixture.owner.sourceFor(getContext().executor);
    const foreign = createHostDatabase(getContext().db);
    const connectionDeadline = fixture.deadline - 1;
    const source: AtomicRedemptionWorkerOrderSource = {
      ...owner,
      async lockOrder(tx, jobRunId) {
        const locked = await owner.lockOrder(tx, jobRunId);
        if (locked?.redemption === undefined) return locked;
        const { redemption } = locked;
        return {
          ...locked,
          redemption: {
            ...redemption,
            async accept(commitTx, result) {
              vi.setSystemTime(connectionDeadline + offset);
              getHostTransactionQueryContext(foreign, commitTx);
              return redemption.accept(commitTx, result);
            },
          },
        };
      },
    };
    const peer = { ...fixture, host: { ...fixture.host, source } };
    vi.useFakeTimers({ toFake: ['Date'] });
    const prepared = await prepare(peer, id, {}, localPolicy, connectionDeadline);
    expectPrepared(prepared);
    await expect(prepared.exchange()).rejects.toMatchObject({
      name: 'WorkerRedemptionError',
      code: offset < 0 ? 'retryable' : 'rejected',
      message: 'Run redemption commit failed',
    });
    vi.useRealTimers();
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
    await expect((await prepare(fixture, id)).exchange()).resolves.toHaveProperty('party.id', id);
  });

  if (config.dialect === 'postgres') {
    it('rejects a PostgreSQL data exception when writing the proved reply', async () => {
      const id = 'reply-data-exception';
      const fixture = await start(id);
      const order = await fixture.owner.read();
      const dispatch = await fixture.readDispatch();
      const owner = fixture.owner.sourceFor(getContext().executor);
      const source: AtomicRedemptionWorkerOrderSource = {
        ...owner,
        async lockOrder(tx, jobRunId) {
          const locked = await owner.lockOrder(tx, jobRunId);
          if (locked?.redemption === undefined) return locked;
          const { redemption } = locked;
          return {
            ...locked,
            redemption: {
              ...redemption,
              async accept(commitTx, result) {
                // PostgreSQL jsonb cannot represent a NUL character (SQLSTATE 22P05).
                return await redemption.accept(commitTx, {
                  ...result,
                  accepted: { ...result.accepted, payload: { value: '\u0000' } },
                });
              },
            },
          };
        },
      };
      const peer = { ...fixture, host: { ...fixture.host, source } };
      const prepared = await prepare(peer, id);
      expectPrepared(prepared);
      await expect(prepared.exchange()).rejects.toMatchObject({
        name: 'WorkerRedemptionError',
        code: 'rejected',
        message: 'Run redemption commit failed',
      });
      await expect(fixture.owner.read()).resolves.toEqual(order);
      await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
    });
  }

  it('refuses unreadable dispatch candidates without modifying the owner or evidence', async () => {
    const id = 'unreadable-candidates';
    const fixture = await start(id);
    await fixture.finishProvision();
    const { executor, dialect } = getContext();
    const malformed = '{}';
    const candidates = dialect === 'postgres' ? sql`cast(${malformed} as jsonb)` : sql`${malformed}`;
    await executor.run(sql`UPDATE worker_dispatch SET candidates = ${candidates} WHERE job_run_id = ${id}`);
    const order = await fixture.owner.read();

    await expect((await prepare(fixture, id)).exchange()).resolves.toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(
      executor.all(sql`
      SELECT cast(candidates as text) AS candidates FROM worker_dispatch WHERE job_run_id = ${id}
    `),
    ).resolves.toEqual([{ candidates: malformed }]);
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

  // The SQLite worker thread and SQLITE_BUSY retry took up to 2,181 ms locally and need headroom on two-core hosted runners.
  it('returns the first committed reply to a separately prepared same-secret exchange', async ({ signal }) => {
    const started = performance.now();
    const phases: string[] = [];
    const mark: MarkRedemptionPhase = (phase) => {
      if (!signal.aborted) phases.push(`${phase} +${Math.round(performance.now() - started)} ms`);
    };
    onTestFailed(() => {
      throw new Error(`Redemption phases: ${phases.join(' → ') || 'none reached'}`);
    });
    const fixture = await start('same-secret');
    const [winner, rival] = await compete(fixture, 'same-secret', runtimeSecret, mark);
    expect(rival).toEqual(winner);
  }, 15_000);

  it('refuses a separately prepared competitor with a different runtime secret', async () => {
    const fixture = await start('competing-secret');
    const [winner, rival] = await compete(fixture, 'competing-secret', 'different-secret');
    expect(rival).toEqual({ reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toMatchObject({ stored: { accepted: winner } });
  });

  it.each([
    'same',
    'different',
  ] as const)('checks a %s secret when a competing exchange commits during proof', async (secret) => {
    const id = `commit-during-proof-${secret}`;
    const fixture = await start(id);
    const first = await prepare(fixture, id);
    expectPrepared(first);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let checks = 0;
    const policy: StartValueVisibility = {
      kind: 'externally-visible',
      async verifyPlatform(ref) {
        expect(ref).toEqual(fixture.allocation);
        if (++checks === 1) {
          entered.resolve();
          await resume.promise;
        }
        return new Date(fixture.deadline).toISOString();
      },
    };
    const pending = prepare(fixture, id, { secret: secret === 'same' ? runtimeSecret : 'different-secret' }, policy);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('Rival preparation did not reach allocation proof');
        }),
      ]);
      const winner = await first.exchange();
      expect(winner).toHaveProperty('party.id', id);
      fixture.loseLiveProof();
      resume.resolve();
      const rival = await pending;
      if (secret === 'same') {
        expectPrepared(rival);
        await expect(rival.exchange()).resolves.toEqual(winner);
        expect(checks).toBe(2);
      } else {
        expect(rival.prepared).toEqual({ reject: 'rejected' });
        expect(checks).toBe(1);
      }
      await expect(fixture.owner.read()).resolves.toMatchObject({ stored: { accepted: winner } });
    } finally {
      resume.resolve();
      await Promise.allSettled([pending]);
    }
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
    await expect(exchange.exchange()).rejects.toMatchObject({ name: 'WorkerRedemptionError', code: 'rejected' });
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

  it('refuses an anonymous exchange when a JavaScript host omits its required signal', async () => {
    const id = 'missing-operation-signal';
    const fixture = await start(id);
    const order = await fixture.owner.read();
    const dispatch = await fixture.readDispatch();
    const host = { ...fixture.host };
    expect(Reflect.deleteProperty(host, 'operationSignal')).toBe(true);

    await expect(prepare({ ...fixture, host }, id)).resolves.toHaveProperty('prepared', { reject: 'rejected' });
    await expect(fixture.owner.read()).resolves.toEqual(order);
    await expect(fixture.readDispatch()).resolves.toEqual(dispatch);
  });

  it('refuses an untyped verifier failure without exposing its details', async () => {
    const fixture = await start('proof-error');
    const before = await fixture.owner.read();
    const { prepared: refusal } = await prepare(fixture, 'proof-error', { token: 'unknown' });
    let verifications = 0;
    const verification = prepare(
      fixture,
      'proof-error',
      {},
      {
        kind: 'externally-visible',
        async verifyPlatform() {
          verifications += 1;
          throw new Error('Sensitive verifier detail');
        },
      },
    );
    expect(refusal).toStrictEqual({ reject: 'rejected' });
    expect((await verification).prepared).toStrictEqual(refusal);
    expect(verifications).toBe(1);
    await expect(fixture.owner.read()).resolves.toEqual(before);
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
