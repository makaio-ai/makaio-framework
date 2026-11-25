import { createBusInstance } from '@makaio/bus-core';
import { PRE_REQUEST_REJECTION_CODE, type HostDatabase, type ProviderAllocationRef } from '@makaio/contracts';
import { runBoundedShutdownSteps, type BoundedShutdownStep, type KernelMakaioExtension } from '@makaio/kernel';
import {
  resolveStorageConformanceConfig,
  useJournalHostFixture,
  useSuiteDatabaseContext,
} from '@makaio/storage-conformance';
import { createHostDatabase } from '@makaio/storage-drizzle';
import type { OrderedWorkerProvider } from '@makaio/services-core/worker-provider';
import { stubExtensionIdentity } from '@makaio/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  call,
  controllableProvider,
  handleFor,
  installOrderFixture,
  orderSourceFixture,
  processBoundProvider,
  providerId,
} from '../../../../services/core/src/worker-provider/__tests__/ordered-worker-fixture.js';
import { readDispatch } from '../../../../services/core/src/worker-provider/dispatch-store.js';
import { resourceStepStopBudgetMs } from '../runtime-stop-budget.js';
import type { WorkerDispatchHostOptions } from '../boot-types.js';
import { bindWorkerDispatch } from '../worker-dispatch-host-binding.js';

const config = resolveStorageConformanceConfig();
if (config === null) throw new Error('MAKAIO_STORAGE_TEST_URL is required for PostgreSQL dispatch tests');
const signal = new AbortController().signal;
const allocationRef: ProviderAllocationRef = { version: 1, providerId, providerData: { allocation: 'local' } };

describe(`worker dispatch host binding (${config.dialect})`, () => {
  const getStorage = useSuiteDatabaseContext(config);
  const { makeContext } = useJournalHostFixture(getStorage);
  beforeAll(async () => installOrderFixture(getStorage()));

  /**
   * Activate a provider through the processor installed by the binding.
   * @param options - Configured order and scope inputs.
   * @param database - Database used by the dispatch host.
   * @param steps - Host teardown sequence.
   * @param provider - Provider supplied by the extension.
   * @param closeDatabase - Closes the probe's storage connection when supplied.
   * @returns The dispatch port and the deactivation step.
   */
  async function bindProbe(
    options: WorkerDispatchHostOptions,
    database: HostDatabase,
    steps: BoundedShutdownStep[],
    provider: OrderedWorkerProvider,
    closeDatabase = async () => {},
  ) {
    const binding = bindWorkerDispatch(options, database, steps, closeDatabase);
    if (binding === undefined) throw new Error('Worker dispatch unavailable');
    const extension: KernelMakaioExtension = {
      name: 'example',
      displayName: 'Example',
      version: '1.0.0',
      workerProviders: {
        createProviders: () => ({ key: 'primary', managedScopeConfirmed: true, providers: [provider] }),
      },
    };
    const ctx = makeContext(createBusInstance(), { identity: stubExtensionIdentity(extension.name) });
    await binding.contributionProcessor.processActivated(extension.name, extension, ctx);
    return {
      port: binding.capability,
      deactivate: () => binding.contributionProcessor.processStopped?.(extension.name),
    };
  }

  /**
   * Compose the same dispatch and database shutdown steps as the runtime.
   * @param jobRunId - Unique run used to exercise this host.
   * @param options - Allocation lifetime and optional transaction boundary.
   * @returns The bound port, controllable provider, and a reader on a separate connection.
   */
  async function boundProbe(
    jobRunId: string,
    options: {
      lifetime?: OrderedWorkerProvider['allocationLifetime'];
      wrap?: (database: HostDatabase) => HostDatabase;
      beforeClose?: () => Promise<void>;
      prepareProvider?: (provider: OrderedWorkerProvider) => void;
      executionId?: string;
    } = {},
  ) {
    const storage = getStorage();
    const connection = await storage.createSiblingClient();
    const database = createHostDatabase(connection.db);
    const reader = createHostDatabase(storage.db);
    const worker = controllableProvider();
    const provider =
      options.lifetime === 'provider-managed'
        ? worker.provider
        : {
            ...processBoundProvider(worker.provider),
            async proveLocalLive() {
              if (worker.sends.length === 0) return undefined;
              return { allocationRef, expiresAt: new Date(Date.now() + 60_000).toISOString() };
            },
          };
    options.prepareProvider?.(provider);
    const fixture = await orderSourceFixture(database, provider.allocationLifetime, jobRunId);
    const closed = Promise.withResolvers<void>();
    const steps: BoundedShutdownStep[] = [];
    const binding = await bindProbe(
      fixture.options,
      options.wrap?.(database) ?? database,
      steps,
      provider,
      async () => {
        await options.beforeClose?.();
        await connection.close();
        closed.resolve();
      },
    );
    await database.transaction(fixture.orderIn);
    const handle = handleFor(options.executionId ?? jobRunId);
    const terminate = vi.spyOn(handle, 'terminate');
    const release = vi.spyOn(handle, 'release');

    return {
      ...fixture,
      worker,
      ...binding,
      database,
      provider,
      reader,
      closed: closed.promise,
      terminate,
      release,
      reply: (reference = allocationRef) =>
        worker.answer.resolve({ kind: 'allocated', allocationRef: reference, handle }),
      stop: () => runBoundedShutdownSteps(steps.toReversed()),
    };
  }

  it.each([
    'claim transaction',
    'commit acknowledgment after the drain window',
  ])('settles a start interrupted during %s', async (phase) => {
    const reachedClaim = Promise.withResolvers<void>();
    const resumeClaim = Promise.withResolvers<void>();
    const expires = phase === 'commit acknowledgment after the drain window';
    const beforeClose = vi.fn(async () => {});
    let holdClaim = true;
    const { options, order, port, provider, reader, stop, worker, setState } = await boundProbe(
      `interrupted-start-${phase}`,
      {
        beforeClose,
        wrap: (database) => ({
          ...database,
          async transaction(body) {
            if (!holdClaim) return database.transaction(body);
            holdClaim = false;
            const result = await database.transaction(async (tx) => {
              const decision = await body(tx);
              if (!expires) {
                reachedClaim.resolve();
                await resumeClaim.promise;
              }
              return decision;
            });
            if (expires) {
              reachedClaim.resolve();
              await resumeClaim.promise;
            }
            return result;
          },
        }),
      },
    );
    const pending = port.startOrderedWorker(call, order, signal);
    await reachedClaim.promise;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const shutdown = stop();
    try {
      await vi.advanceTimersByTimeAsync(expires ? resourceStepStopBudgetMs() : 0);
      expect(beforeClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      resumeClaim.resolve();
      await Promise.allSettled([pending, shutdown]);
    }
    expect(await shutdown).toEqual(
      expires ? [expect.objectContaining({ message: 'Worker provisioning exceeded its shutdown window' })] : [],
    );
    expect(beforeClose).toHaveBeenCalledTimes(1);
    expect(worker.sends).toEqual([]);
    const evidence = expect.objectContaining({ code: PRE_REQUEST_REJECTION_CODE });
    await expect(pending).resolves.toEqual({ kind: 'confirmed-absent', evidence });
    await expect(reader.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      sendSettled: true,
      settled: evidence,
    });

    const steps: BoundedShutdownStep[] = [];
    const { port: restarted } = await bindProbe(options, reader, steps, provider);
    try {
      await reader.transaction((tx) => setState(tx, 'closed'));
      await expect(restarted.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual({
        kind: 'confirmed-absent',
        evidence,
      });
    } finally {
      expect(await runBoundedShutdownSteps(steps.toReversed())).toEqual([]);
    }
    expect(worker.sends).toEqual([]);
  });

  it('reads the completed cleanup duty under a new host incarnation', async () => {
    const { options, order, port, provider, reader, reply, setState, stop, terminate } =
      await boundProbe('restart-dispatch');
    reply();
    await expect(port.startOrderedWorker(call, order, signal)).resolves.toEqual({ kind: 'allocated', allocationRef });
    expect(await stop()).toEqual([]);
    expect(terminate).toHaveBeenCalledTimes(1);

    const steps: BoundedShutdownStep[] = [];
    const { port: restarted } = await bindProbe(options, reader, steps, provider);
    try {
      await reader.transaction((tx) => setState(tx, 'closed'));
      await expect(restarted.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual({
        kind: 'allocated',
        allocationRef,
      });
      await expect(reader.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
        sendSettled: true,
        settled: expect.objectContaining({ summary: 'Process-bound allocation terminated' }),
      });
    } finally {
      expect(await runBoundedShutdownSteps(steps.toReversed())).toEqual([]);
    }
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('closes storage and preserves the durable duty when termination fails', async () => {
    const { order, port, reader, closed, reply, stop, terminate } = await boundProbe('unconfirmed-teardown');
    const failure = new Error('Local termination was not confirmed');
    terminate.mockRejectedValueOnce(failure);
    reply();
    await port.startOrderedWorker(call, order, signal);

    expect(await stop()).toEqual([
      expect.objectContaining({ message: 'Local worker teardown failed', errors: [failure] }),
    ]);
    await closed;
    expect(terminate).toHaveBeenCalledTimes(1);
    await expect(reader.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      sendSettled: true,
      settled: null,
    });
  });

  it('records managed teardown when the binding commits before its acknowledgment', async () => {
    const committed = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    let holdAcknowledgment = false;
    const { options, order, port, provider, reader, reply, setState, stop, terminate, worker } = await boundProbe(
      'managed-binding-acknowledgment',
      {
        lifetime: 'provider-managed',
        wrap: (database) => ({
          ...database,
          async transaction(body) {
            const hold = holdAcknowledgment;
            holdAcknowledgment = false;
            const result = await database.transaction(body);
            if (hold) {
              committed.resolve();
              await acknowledge.promise;
            }
            return result;
          },
        }),
      },
    );
    const pending = port.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    holdAcknowledgment = true;
    reply();
    await committed.promise;
    const read = () => reader.transaction((tx) => readDispatch(tx, order.jobRunId));
    await expect(read()).resolves.toMatchObject({ boundAllocation: allocationRef, settled: null });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const shutdown = stop();
      await vi.advanceTimersByTimeAsync(resourceStepStopBudgetMs());
      expect(await shutdown).toEqual([
        expect.objectContaining({ message: 'Worker provisioning exceeded its shutdown window' }),
      ]);
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      acknowledge.resolve();
      await pending;
    }

    const steps: BoundedShutdownStep[] = [];
    const { port: restarted } = await bindProbe(options, reader, steps, provider);
    try {
      await reader.transaction((tx) => setState(tx, 'closed'));
      await expect(restarted.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual({
        kind: 'allocated',
        allocationRef,
      });
      await expect(read()).resolves.toMatchObject({
        boundAllocation: allocationRef,
        settled: expect.objectContaining({ summary: 'Managed allocation terminated during shutdown' }),
      });
    } finally {
      expect(await runBoundedShutdownSteps(steps.toReversed())).toEqual([]);
    }
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(worker.terminated).toEqual([]);
  });

  it.each([
    'acknowledged',
    'unrecorded',
  ])('keeps late managed cleanup durable after the drain closes (%s)', async (phase) => {
    const fails = phase === 'unrecorded';
    const closing = Promise.withResolvers<void>();
    const allowClose = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    const referenceCalls: ProviderAllocationRef[] = [];
    const failure = new Error('late teardown was not confirmed');
    let holdAcknowledgment = false;
    const { options, order, port, provider, reader, release, reply, stop, terminate, worker } = await boundProbe(
      `managed-late-after-drain-${phase}`,
      {
        lifetime: 'provider-managed',
        async beforeClose() {
          closing.resolve();
          await allowClose.promise;
        },
        prepareProvider(provider) {
          const recovery = provider.recovery;
          if (recovery === undefined) throw new Error('Provider recovery is required');
          const end = recovery.terminateAllocation;
          vi.spyOn(recovery, 'terminateAllocation').mockImplementation(async (...args) => {
            referenceCalls.push(args[2]);
            args[3].throwIfAborted();
            if (fails && referenceCalls.length === 1) throw failure;
            return end(...args);
          });
        },
        wrap: (database) => ({
          ...database,
          async transaction(body) {
            const result = await database.transaction(body);
            if (holdAcknowledgment) {
              holdAcknowledgment = false;
              committed.resolve();
              await acknowledge.promise;
            }
            return result;
          },
        }),
      },
    );
    const completed = port.startOrderedWorker(call, order, signal).catch(() => undefined);
    await worker.exposed.getPromise();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(order.bootstrapDeadlineAt));
    const absent = { kind: 'confirmed-absent', evidence: worker.evidence };
    const read = () => reader.transaction((tx) => readDispatch(tx, order.jobRunId));
    let shutdown: ReturnType<typeof stop> | undefined;
    try {
      worker.finishTermination();
      await expect(port.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual(absent);
      if (!fails) {
        holdAcknowledgment = true;
        reply();
        await committed.promise;
        await expect(read()).resolves.toMatchObject({
          boundAllocation: null,
          settled: { lateAllocation: { reference: allocationRef, state: 'pending' } },
        });
      }

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      shutdown = stop();
      await vi.advanceTimersByTimeAsync(resourceStepStopBudgetMs());
      await closing.promise;
      vi.useRealTimers();
      if (fails) reply();
      acknowledge.resolve();
      await completed;
      await expect(read()).resolves.toMatchObject({
        settled: { lateAllocation: { reference: allocationRef, state: fails ? 'pending' : 'ended' } },
      });
      await expect(completed).resolves.toEqual({ kind: 'unknown', reason: 'dispatch-unresolved' });
      expect(referenceCalls).toEqual([allocationRef]);
      expect(terminate).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      reply();
      acknowledge.resolve();
      allowClose.resolve();
      clock.mockRestore();
      await Promise.all([completed, shutdown]);
    }
    expect(await shutdown).toEqual([
      expect.objectContaining({ message: 'Worker provisioning exceeded its shutdown window' }),
    ]);

    const steps: BoundedShutdownStep[] = [];
    const { port: restarted } = await bindProbe(options, reader, steps, provider);
    try {
      await expect(restarted.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual(absent);
      await expect(read()).resolves.toMatchObject({ settled: { lateAllocation: { state: 'ended' } } });
      expect(referenceCalls).toEqual(fails ? [allocationRef, allocationRef] : [allocationRef]);
    } finally {
      expect(await runBoundedShutdownSteps(steps.toReversed())).toEqual([]);
    }
  });

  it('releases a late managed handle with an invalid reference after supervision settles', async () => {
    const { database, order, port, reader, release, reply, stop, terminate, worker } = await boundProbe(
      'managed-invalid-late-reference',
      { lifetime: 'provider-managed' },
    );
    const pending = port.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(order.bootstrapDeadlineAt));
    const absent = { kind: 'confirmed-absent', evidence: worker.evidence };
    try {
      worker.finishTermination();
      await expect(port.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual(absent);
      reply({ ...allocationRef, providerId: '' });
      await expect(pending).resolves.toEqual(absent);
      await expect(reader.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
        boundAllocation: null,
        settled: worker.evidence,
      });
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      reply({ ...allocationRef, providerId: '' });
      clock.mockRestore();
      await Promise.allSettled([pending]);
    }

    const transaction = vi.spyOn(database, 'transaction');
    const failures = await stop();
    // A retained handle would make shutdown open another teardown transaction.
    expect.soft(transaction).not.toHaveBeenCalled();
    expect.soft(failures).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('uses the withdrawn managed provider to complete an open cleanup obligation', async () => {
    const { deactivate, order, port, reader, setState, stop, worker } = await boundProbe('withdrawn-managed-provider', {
      lifetime: 'provider-managed',
    });
    try {
      const pending = port.startOrderedWorker(call, order, signal);
      await worker.exposed.getPromise();
      worker.answer.reject(new Error('Provider reply lost'));
      await pending;

      await deactivate();
      await reader.transaction((tx) => setState(tx, 'closed'));
      worker.allocations.push(allocationRef);
      worker.finishTermination();

      await port.superviseOrderedWorker(call, order.jobRunId, signal);
      expect(worker.terminated).toEqual([allocationRef]);
      await expect(reader.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
        settled: expect.objectContaining({ source: worker.evidence.source }),
      });
    } finally {
      expect(await stop()).toEqual([]);
    }
  });

  it.each([
    'open',
    'closed',
  ] as const)('terminates an early-bound reply after the drain with storage %s', async (storage) => {
    const closing = Promise.withResolvers<void>();
    const allowClose = Promise.withResolvers<void>();
    const { options, order, port, provider, database, reader, reply, stop, terminate, worker, setState } =
      await boundProbe(`early-binding-after-drain-${storage}`, {
        async beforeClose() {
          closing.resolve();
          await allowClose.promise;
        },
      });
    const pending = port.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    const binding = await port.prepareAllocationBinding(call, order.jobRunId, { kind: 'allocation-only' });
    if (binding === undefined) throw new Error('Expected an early allocation binding');
    await database.transaction(async (tx) => {
      await binding.bind(tx);
      await setState(tx, 'redeemed');
    });
    const read = () => reader.transaction((tx) => readDispatch(tx, order.jobRunId));
    await expect(read()).resolves.toMatchObject({ boundAllocation: allocationRef, settled: null });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const shutdown = stop();
    try {
      await vi.advanceTimersByTimeAsync(resourceStepStopBudgetMs());
      await closing.promise;
      vi.useRealTimers();
      if (storage === 'closed') {
        allowClose.resolve();
        await shutdown;
      }
      const transaction = vi.spyOn(database, 'transaction');
      reply();
      await pending;
      expect(terminate).toHaveBeenCalledTimes(1);
      if (storage === 'open') {
        await expect(read()).resolves.toMatchObject({
          settled: expect.objectContaining({ summary: 'Process-bound allocation terminated' }),
        });
      } else {
        expect(transaction).toHaveBeenCalledTimes(1);
        await expect(transaction.mock.results[0]?.value).rejects.toBeDefined();
      }
    } finally {
      vi.useRealTimers();
      reply();
      allowClose.resolve();
      expect(await shutdown).toEqual([
        expect.objectContaining({ message: 'Worker provisioning exceeded its shutdown window' }),
      ]);
      await pending;
    }

    const steps: BoundedShutdownStep[] = [];
    const { port: restarted } = await bindProbe(options, reader, steps, provider);
    try {
      await reader.transaction((tx) => setState(tx, 'closed'));
      await restarted.superviseOrderedWorker(call, order.jobRunId, signal);
      await expect(read()).resolves.toMatchObject({
        boundAllocation: allocationRef,
        sendSettled: storage === 'open',
        settled:
          storage === 'open' ? expect.objectContaining({ summary: 'Process-bound allocation terminated' }) : null,
      });
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      expect(await runBoundedShutdownSteps(steps.toReversed())).toEqual([]);
    }
  });

  it.each([
    'during',
    'after',
    'after with a foreign execution',
    'after with an invalid reference',
    'after storage closes',
  ] as const)('disposes of a provision response around shutdown (%s)', async (arrival) => {
    const closing = Promise.withResolvers<void>();
    const allowClose = Promise.withResolvers<void>();
    const foreign = arrival === 'after with a foreign execution';
    const storageClosed = arrival === 'after storage closes';
    const settled = !foreign && !storageClosed;
    const { options, order, port, provider, reader, release, reply, setState, stop, terminate, worker } =
      await boundProbe(`dispatch-${arrival}-drain`, {
        executionId: foreign ? 'foreign-run' : undefined,
        async beforeClose() {
          closing.resolve();
          await allowClose.promise;
        },
      });
    const pending = port.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    const read = () => reader.transaction((tx) => readDispatch(tx, order.jobRunId));
    await expect(read()).resolves.toMatchObject({ boundAllocation: null, sendSettled: false, settled: null });
    const operation = worker.sends[0]?.signal;
    if (operation === undefined) throw new Error('Provision did not receive its operation signal');
    const aborted = Promise.withResolvers<void>();
    operation.addEventListener('abort', () => aborted.resolve(), { once: true });

    if (arrival !== 'during') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const shutdown = stop();
    try {
      await aborted.promise;
      if (arrival !== 'during') {
        await vi.advanceTimersByTimeAsync(resourceStepStopBudgetMs());
        await closing.promise;
        vi.useRealTimers();
        if (storageClosed) {
          allowClose.resolve();
          await shutdown;
        }
      }
      reply(arrival === 'after with an invalid reference' ? { ...allocationRef, providerId: '' } : allocationRef);
      await pending;
    } finally {
      vi.useRealTimers();
      reply();
      allowClose.resolve();
      await shutdown;
    }
    expect(await shutdown).toEqual(
      arrival === 'during'
        ? []
        : [expect.objectContaining({ message: 'Worker provisioning exceeded its shutdown window' })],
    );
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    const evidence = expect.objectContaining({ summary: 'Process-bound allocation terminated' });
    await expect(read()).resolves.toMatchObject({
      boundAllocation: arrival === 'during' ? allocationRef : null,
      sendSettled: settled,
      settled: settled ? evidence : null,
    });

    const steps: BoundedShutdownStep[] = [];
    const { port: restarted } = await bindProbe(options, reader, steps, provider);
    try {
      await reader.transaction((tx) => setState(tx, 'closed'));
      const result =
        arrival === 'during'
          ? { kind: 'allocated', allocationRef }
          : settled
            ? { kind: 'confirmed-absent', evidence }
            : { kind: 'unknown', reason: 'dispatch-unresolved' };
      await expect(restarted.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual(result);
    } finally {
      expect(await runBoundedShutdownSteps(steps.toReversed())).toEqual([]);
    }
  });
});
