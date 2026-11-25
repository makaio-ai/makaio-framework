import type { ProviderAllocationRef, WorkerHandle } from '@makaio/contracts';
import {
  resolveStorageConformanceConfig,
  useSuiteDatabaseContext,
  type StorageDatabaseContext,
} from '@makaio/storage-conformance';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { DeferredPromise } from '@makaio/utils';
import { beforeAll, describe, expect, it } from 'vitest';
import { readDispatch } from '../dispatch-store.js';
import { finishLocalAllocation } from '../local-worker-control.js';
import { WorkerProviderRegistry } from '../provider-registry.js';
import { confirmAllocationScope } from '../scope-confirmation.js';
import { decideAllocationScope } from '../scope-decision.js';
import { createWorkerDispatch } from '../start-ordered-worker.js';
import type { StartOrder, WorkerStartOptions } from '../start-order.js';
import { call, controllableProvider, fixtureToken, setting } from './ordered-worker-fixture.js';
import { bookRedemptionOwner, migrateRedemptionOwner } from './redemption-owner-fixture.js';

const config = resolveStorageConformanceConfig();
if (config === null) throw new Error('MAKAIO_STORAGE_TEST_URL is required for worker shutdown tests');

interface HandoffHooks {
  readonly onListed: () => void;
  readonly beforeTermination: () => Promise<void>;
}

/**
 * Book a real managed run and hold the sender after it records its reference.
 * @param context - Isolated database for the current dialect.
 * @param jobRunId - Unique run under test.
 * @param hooks - Optional barriers for provider observation and teardown.
 */
async function managedHandoff(context: StorageDatabaseContext, jobRunId: string, hooks?: HandoffHooks) {
  const { onListed, beforeTermination } = hooks ?? {};
  const { db, executor } = context;
  const database = createHostDatabase(db);
  const worker = controllableProvider();
  const providers = new WorkerProviderRegistry();
  const operations = new AbortController();
  const drained = new AbortController();
  const scope = decideAllocationScope(setting, 'example-scope');
  if (scope.kind !== 'bound') throw new Error('Missing test allocation scope');
  const order: StartOrder = {
    jobRunId,
    workerProviderId: worker.provider.id,
    allocationLifetime: 'provider-managed',
    allocationScope: scope.scope,
    bootstrapDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const allocation: ProviderAllocationRef = {
    version: 1,
    providerId: worker.provider.id,
    providerData: { allocation: order.jobRunId },
  };
  await confirmAllocationScope(database, setting, scope.scope.value, call);
  const provider = {
    ...worker.provider,
    recovery: {
      ...worker.provider.recovery,
      async listAllocations(...args: Parameters<typeof worker.provider.recovery.listAllocations>) {
        const page = await worker.provider.recovery.listAllocations(...args);
        onListed?.();
        return page;
      },
      async terminateAllocation(...args: Parameters<typeof worker.provider.recovery.terminateAllocation>) {
        await beforeTermination?.();
        return worker.provider.recovery.terminateAllocation(...args);
      },
    },
  };
  await providers.replace(
    call,
    { owner: 'example', key: 'primary', managedScopeConfirmed: true, providers: [provider] },
    operations.signal,
  );
  const { kind, id } = call.caller;
  const owner = await bookRedemptionOwner(database, order, { kind, id }, fixtureToken, false);
  const senderCommitted = new DeferredPromise<void>();
  const acknowledge = new DeferredPromise<void>();
  let holdReceipt = false;
  const host: WorkerStartOptions = {
    database: {
      ...database,
      async transaction(body) {
        const result = await database.transaction(body);
        if (holdReceipt) {
          holdReceipt = false;
          senderCommitted.resolve();
          await acknowledge.getPromise();
        }
        return result;
      },
    },
    source: owner.sourceFor(executor),
    providers,
    scopeSetting: setting,
    connection: () => ({ busAuth: { kind: 'none' } }),
    operationSignal: operations.signal,
    provisionDrain: { closed: drained.signal, track() {} },
    processIncarnation: 'initial-incarnation',
    handles: new Map(),
  };
  const effects: string[] = [];
  const handle: WorkerHandle = {
    executionId: order.jobRunId,
    async cancel() {},
    async terminate() {
      effects.push('terminate');
    },
    async release() {
      effects.push('release');
    },
  };
  const pending = createWorkerDispatch(host).startOrderedWorker(call, order, operations.signal);
  const unexpectedCompletion = pending.then(() => {
    throw new Error('Sender completed before the shutdown barrier');
  });
  return {
    allocation,
    database,
    effects,
    host,
    operations,
    order,
    owner,
    worker,
    read: () => database.transaction((tx) => readDispatch(tx, order.jobRunId)),
    async waitForSender() {
      await Promise.race([worker.exposed.getPromise(), unexpectedCompletion]);
      holdReceipt = true;
      worker.answer.resolve({ kind: 'allocated', allocationRef: allocation, handle });
      await Promise.race([senderCommitted.getPromise(), unexpectedCompletion]);
    },
    async finishSender() {
      drained.abort();
      worker.answer.resolve({ kind: 'allocated', allocationRef: allocation, handle });
      acknowledge.resolve();
      await pending;
    },
  };
}

describe(`managed redemption shutdown (${config.dialect})`, () => {
  const getContext = useSuiteDatabaseContext(config);
  beforeAll(async () => migrateRedemptionOwner(getContext()));

  it('records confirmed teardown during sender handoff without assigning the allocation', async () => {
    const fixture = await managedHandoff(getContext(), 'managed-shutdown-before-redemption');
    const { allocation, effects, host, order, owner, read } = fixture;
    try {
      await fixture.waitForSender();
      await expect(read()).resolves.toMatchObject({
        boundAllocation: null,
        candidates: [allocation],
        sendSettled: true,
        settled: null,
      });

      await expect(finishLocalAllocation(host, order.jobRunId)).resolves.toBe(true);

      await expect(read()).resolves.toMatchObject({
        boundAllocation: null,
        candidates: [allocation],
        shutdownEnded: [allocation],
        settled: null,
      });
      await expect(owner.read()).resolves.toMatchObject({ state: 'ordered', stored: null });
    } finally {
      await fixture.finishSender();
    }
    expect(host.handles.size).toBe(0);
    expect(effects).toEqual(['terminate', 'release']);
  });

  it('retains and terminates a distinct observation that records after local shutdown', async () => {
    let awaitingObservation = false;
    const ending = new DeferredPromise<void>();
    const allowTermination = new DeferredPromise<void>();
    const fixture = await managedHandoff(getContext(), 'managed-shutdown-observation', {
      onListed() {
        awaitingObservation = true;
      },
      async beforeTermination() {
        ending.resolve();
        await allowTermination.getPromise();
      },
    });
    const { allocation, database, host, operations, order, read, worker } = fixture;
    const other = { ...allocation, providerData: { allocation: 'observed-allocation' } };
    const tryingToRecord = new DeferredPromise<void>();
    const allowRecord = new DeferredPromise<void>();
    const observer = createWorkerDispatch({
      ...host,
      database: {
        ...database,
        async transaction(body) {
          if (awaitingObservation) {
            awaitingObservation = false;
            tryingToRecord.resolve();
            await allowRecord.getPromise();
          }
          return database.transaction(body);
        },
      },
    });
    let observation: ReturnType<typeof observer.startOrderedWorker> | undefined;
    try {
      await fixture.waitForSender();
      worker.allocations.push(allocation, other);
      worker.finishTermination();
      worker.allocations.shift();
      observation = observer.startOrderedWorker(call, order, operations.signal);
      const unexpectedCompletion = observation.then(() => {
        throw new Error('Observation finished before the expected barrier');
      });
      await Promise.race([tryingToRecord.getPromise(), unexpectedCompletion]);

      await expect(finishLocalAllocation(host, order.jobRunId)).resolves.toBe(true);
      await expect(read()).resolves.toMatchObject({
        candidates: [allocation],
        shutdownEnded: [allocation],
        settled: null,
      });

      allowRecord.resolve();
      await Promise.race([ending.getPromise(), unexpectedCompletion]);
      await expect(read()).resolves.toMatchObject({
        candidates: [allocation, other],
        shutdownEnded: [allocation],
        settled: null,
      });
      allowTermination.resolve();
      await expect(observation).resolves.toMatchObject({ kind: 'unknown', reason: 'allocation-conflict' });
      expect(worker.terminated).toEqual([other]);
      await expect(read()).resolves.toMatchObject({
        boundAllocation: null,
        candidates: [allocation, other],
        shutdownEnded: [allocation, other],
        settled: worker.evidence,
      });
    } finally {
      allowRecord.resolve();
      allowTermination.resolve();
      try {
        await observation;
      } finally {
        await fixture.finishSender();
      }
    }
  });
});
