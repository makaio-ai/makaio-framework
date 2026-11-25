import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { HostDatabase } from '@makaio/contracts';
import { createHostDatabase, getTransactionQueryContext } from '@makaio/storage-drizzle';
import { resolveStorageConformanceConfig, useSuiteDatabaseContext } from '@makaio/storage-conformance';
import { beforeAll } from 'vitest';
import { readDispatch } from '../dispatch-store.js';
import { prepareAllocationBinding } from '../redemption-binding.js';
import { decideStart } from '../start-claim.js';
import { createWorkerDispatch } from '../start-ordered-worker.js';
import {
  call,
  controllableProvider,
  handleFor,
  installOrderFixture,
  orderFixture,
  processBoundProvider,
} from './ordered-worker-fixture.js';
import {
  type AllocationListingRequest,
  type AllocationObservation,
  type AllocationObservationPage,
  type ExtensionOperatorConfigEntry,
} from '@makaio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { type AllocationCorrelationTarget, correlateAllocation } from '../allocation-correlation.js';
import { readAllocationScopeSetting } from '../allocation-scope-source.js';
import { decideAllocationScope } from '../scope-decision.js';

const providerId = 'example.worker:primary';
const jobRunId = 'job-run';
const setting = readAllocationScopeSetting(
  new Map<string, ExtensionOperatorConfigEntry>([
    ['example.owner', { kind: 'config', source: 'operator', config: { allocationScope: 'confirmed-scope' } }],
  ]),
  'example.owner',
);
const binding = decideAllocationScope(setting, 'confirmed-scope');
if (binding.kind !== 'bound') throw new Error('Expected a confirmed allocation scope');

const target: AllocationCorrelationTarget = { jobRunId, providerId, scope: binding.scope };
const request: AllocationListingRequest = { jobRunId, allocationScope: binding.scope.value };
const observed: AllocationObservation = {
  jobRunId,
  state: 'running',
  allocationRef: { version: 1, providerId, providerData: { allocation: 'first', generation: 1 } },
};
const sibling: AllocationObservation = {
  ...observed,
  allocationRef: { ...observed.allocationRef, providerData: { allocation: 'second' } },
};
const complete = { kind: 'complete' } as const;
const incomplete = {
  kind: 'unknown',
  evidence: {
    source: providerId,
    summary: 'Listing did not complete',
    observedAt: '2026-01-01T00:00:00Z',
  },
} as const;

describe('worker allocation correlation', () => {
  it('correlates a single complete, scoped observation and preserves its terminal state', () => {
    const terminal = { ...observed, state: 'terminal' } satisfies AllocationObservation;
    expect(
      correlateAllocation(target, { providerId, request, page: { observations: [terminal], completeness: complete } }),
    ).toEqual({ kind: 'observed', observation: terminal });
  });

  it.each([
    { observations: [], completeness: complete },
    { observations: [observed, sibling], completeness: complete },
    { observations: [observed], completeness: incomplete },
    { observations: [observed], nextCursor: 'next-page' },
  ] satisfies AllocationObservationPage[])('leaves unproven uniqueness open (%j)', (page) => {
    expect(correlateAllocation(target, { providerId, request, page })).toEqual({ kind: 'unknown' });
  });

  it('leaves uniqueness open when the final page follows earlier pages', () => {
    const page: AllocationObservationPage = { observations: [observed], completeness: complete };
    expect(correlateAllocation(target, { providerId, request: { ...request, cursor: 'next-page' }, page })).toEqual({
      kind: 'unknown',
    });
  });

  it.each([
    { providerId: 'example.worker:other', request, observations: [observed] },
    { providerId, request: { ...request, allocationScope: 'foreign-scope' }, observations: [observed] },
    { providerId, request: { ...request, jobRunId: 'other-job-run' }, observations: [observed] },
    { providerId, request, observations: [{ ...observed, jobRunId: 'other-job-run' }] },
    {
      providerId,
      request,
      observations: [{ ...observed, allocationRef: { ...observed.allocationRef, providerId: 'example.worker:other' } }],
    },
  ])('refuses a listing with a mismatched identity (%j)', ({ providerId: source, request: query, observations }) => {
    expect(
      correlateAllocation(target, {
        providerId: source,
        request: query,
        page: { observations, completeness: complete },
      }),
    ).toEqual({ kind: 'unknown' });
  });

  it('matches the recorded allocation on an incomplete page regardless of JSON property order', () => {
    const pinned = { ...target, allocationRef: observed.allocationRef };
    const reordered: AllocationObservation = {
      ...observed,
      allocationRef: { ...observed.allocationRef, providerData: { generation: 1, allocation: 'first' } },
    };
    const page: AllocationObservationPage = { observations: [sibling, reordered], completeness: incomplete };
    expect(correlateAllocation(pinned, { providerId, request, page })).toEqual({
      kind: 'observed',
      observation: reordered,
    });
  });

  it('keeps a recorded allocation open when only a different reference is observed', () => {
    const pinned = { ...target, allocationRef: observed.allocationRef };
    const page: AllocationObservationPage = { observations: [sibling], completeness: complete };
    expect(correlateAllocation(pinned, { providerId, request, page })).toEqual({ kind: 'unknown' });
  });

  it('keeps contradictory observations of a recorded reference open', () => {
    const pinned = { ...target, allocationRef: observed.allocationRef };
    const page: AllocationObservationPage = {
      observations: [observed, { ...observed, state: 'absent' }],
      completeness: complete,
    };
    expect(correlateAllocation(pinned, { providerId, request, page })).toEqual({ kind: 'unknown' });
  });

  it('keeps a malformed page open', () => {
    const page = { observations: [observed], completeness: complete, nextCursor: 'next-page' };
    expect(correlateAllocation(target, { providerId, request, page })).toEqual({ kind: 'unknown' });
  });
});

const config = resolveStorageConformanceConfig();
if (config === null) throw new Error('MAKAIO_STORAGE_TEST_URL is required for PostgreSQL dispatch tests');

describe(`ordered worker dispatch through the host database (${config.dialect})`, () => {
  const getContext = useSuiteDatabaseContext(config);
  beforeAll(async () => installOrderFixture(getContext()));

  const signal = new AbortController().signal;

  it('settles an open managed allocation through the next activation of its provider', async () => {
    const database = createHostDatabase(getContext().db);
    const first = controllableProvider();
    const next = controllableProvider();
    const { host, order, orderIn, setState } = await orderFixture(database, first.provider, 'provider-reactivation');
    await database.transaction(orderIn);
    const dispatch = createWorkerDispatch(host);
    const pending = dispatch.startOrderedWorker(call, order, signal);
    await first.exposed.getPromise();
    first.allocations.push(observed.allocationRef);
    const read = () => database.transaction((tx) => readDispatch(tx, order.jobRunId));
    await expect(read()).resolves.toMatchObject({ sendSettled: false, settled: null });

    // Both generations can find the allocation created in the same backend.
    next.allocations.push(...first.allocations);
    next.finishTermination();
    await host.providers.replace(
      call,
      { owner: 'example', key: 'primary', managedScopeConfirmed: true, providers: [next.provider] },
      signal,
    );
    first.answer.reject(new Error('Provider reply lost'));
    await pending;
    await expect(read()).resolves.toMatchObject({ sendSettled: true, settled: null });

    await database.transaction((tx) => setState(tx, 'closed'));
    await dispatch.superviseOrderedWorker(call, order.jobRunId, signal);
    expect(first.sends).toHaveLength(1);
    expect(next.sends).toEqual([]);
    expect(first.terminated).toEqual([]);
    expect(next.terminated).toEqual([observed.allocationRef]);
    await expect(read()).resolves.toMatchObject({ settled: next.evidence });
  });

  it('dispatches once after commit and isolates the winning operation from caller abort', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const fixture = await orderFixture(database, worker.provider, 'parallel-run');
    await expect(database.transaction(async (tx) => getTransactionQueryContext(tx).dialect)).resolves.toBe(
      config.dialect,
    );
    await database.transaction(fixture.orderIn);
    const rival =
      config.dialect === 'postgres' ? createHostDatabase((await getContext().createSiblingClient()).db) : database;
    const start = createWorkerDispatch(fixture.host).startOrderedWorker;
    const restart = createWorkerDispatch({
      ...fixture.host,
      database: rival,
      processIncarnation: 'rival',
    }).startOrderedWorker;
    const interrupt = new AbortController();
    const first = start(call, fixture.order, interrupt.signal);
    await worker.exposed.getPromise();
    const second = restart(call, fixture.order, signal);
    await expect(second).resolves.toEqual({ kind: 'unknown', reason: 'dispatch-unresolved' });
    interrupt.abort(new Error('caller left'));
    const allocationRef = observed.allocationRef;
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle: handleFor(fixture.order.jobRunId) });
    await expect(first).rejects.toThrow('caller left');
    expect(worker.sends).toEqual([
      { deadline: fixture.order.bootstrapDeadlineAt, signal: fixture.host.operationSignal, hasToken: true },
    ]);
    expect(fixture.host.operationSignal.aborted).toBe(false);
    await expect
      .poll(() => database.transaction((tx) => readDispatch(tx, fixture.order.jobRunId)))
      .toMatchObject({ boundAllocation: allocationRef });
    await expect(restart(call, fixture.order, signal)).resolves.toMatchObject({ kind: 'allocated', allocationRef });
  });

  it('admits at most one contender from independent port instances', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const fixture = await orderFixture(database, worker.provider, 'concurrent-run');
    await database.transaction(fixture.orderIn);
    // SQLite exercises two port instances serialized by one database object.
    // The separate PostgreSQL pool exercises contenders on independent connections.
    const other =
      config.dialect === 'postgres' ? createHostDatabase((await getContext().createSiblingClient()).db) : database;
    const starts = [
      createWorkerDispatch(fixture.host).startOrderedWorker(call, fixture.order, signal),
      createWorkerDispatch({ ...fixture.host, database: other }).startOrderedWorker(call, fixture.order, signal),
    ];
    await worker.exposed.getPromise();
    await expect(Promise.race(starts)).resolves.toEqual({ kind: 'unknown', reason: 'dispatch-unresolved' });
    expect(worker.sends).toHaveLength(1);
    worker.answer.resolve({
      kind: 'confirmed-absent',
      evidence: { ...worker.evidence, code: 'pre-request-rejection' },
    });
    await expect(Promise.all(starts)).resolves.toContainEqual({
      kind: 'confirmed-absent',
      evidence: { ...worker.evidence, code: 'pre-request-rejection' },
    });
    expect(worker.sends).toHaveLength(1);
  });

  it('retires a provider from selection atomically while keeping it resolvable', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const { host } = await orderFixture(database, worker.provider, 'provider-retention');
    const activation = { owner: 'example', key: 'primary', managedScopeConfirmed: true };
    const providers = host.providers;
    const previous = providers.selectForProvisioning(providerId);
    await expect(
      providers.replace(
        call,
        { ...activation, providers: [worker.provider, { ...worker.provider, id: 'other.worker:primary' }] },
        signal,
      ),
    ).rejects.toThrow('identity does not match');
    expect(providers.listSelectable()).toEqual([previous]);
    await providers.replace(call, { ...activation, providers: [] }, signal);
    expect(providers.selectForProvisioning(providerId)).toBeUndefined();
    expect(providers.get(providerId)).toBe(previous);
  });

  it('refuses rolled-back orders, lost volatile tokens and Cancel before the claim', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const fixture = await orderFixture(database, worker.provider, 'rollback-order');
    const start = createWorkerDispatch(fixture.host).startOrderedWorker;
    await expect(
      database.transaction(async (tx) => {
        await fixture.orderIn(tx);
        throw new Error('order rolled back');
      }),
    ).rejects.toThrow('order rolled back');
    await expect(start(call, fixture.order, signal)).resolves.toEqual({ kind: 'refused', reason: 'not-committed' });
    await database.transaction(fixture.orderIn);
    fixture.loseToken();
    await expect(start(call, fixture.order, signal)).resolves.toEqual({
      kind: 'refused',
      reason: 'start-material-unavailable',
    });
    await database.transaction((tx) => fixture.setState(tx, 'closed'));
    await expect(start(call, fixture.order, signal)).resolves.toEqual({ kind: 'refused', reason: 'run-closed' });
    expect(worker.sends).toHaveLength(0);
  });

  it('rolls back a failed claim and observes an acknowledged database write whose acknowledgment was lost', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const { order, host, orderIn } = await orderFixture(database, worker.provider, 'commit-boundary');
    await database.transaction(orderIn);
    const rollsBack: HostDatabase = {
      transaction: (action) =>
        database.transaction(async (tx) => {
          await action(tx);
          throw new Error('claim rolled back');
        }),
    };
    const losesReply: HostDatabase = {
      async transaction(action) {
        await database.transaction(action);
        throw new Error('claim acknowledgment lost');
      },
    };
    await expect(
      createWorkerDispatch({ ...host, database: rollsBack }).startOrderedWorker(call, order, signal),
    ).rejects.toThrow('claim rolled back');
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toBeUndefined();
    await expect(
      createWorkerDispatch({ ...host, database: losesReply }).startOrderedWorker(call, order, signal),
    ).rejects.toThrow('claim acknowledgment lost');
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      sendSettled: false,
    });
    const sibling = createHostDatabase((await getContext().createSiblingClient()).db);
    await expect(
      createWorkerDispatch({ ...host, database: sibling, processIncarnation: 'restarted' }).startOrderedWorker(
        call,
        order,
        signal,
      ),
    ).resolves.toEqual({ kind: 'unknown', reason: 'dispatch-unresolved' });
    expect(worker.sends).toHaveLength(0);
  });

  it.each(['absent', 'allocated'] as const)('resumes an unsent claim after the deadline (%s)', async (outcome) => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const fixture = await orderFixture(database, worker.provider, `unsent-${outcome}`);
    const { host, order } = fixture;
    await database.transaction(fixture.orderIn);
    await expect(decideStart(host, call, order)).resolves.toMatchObject({ kind: 'dispatch' });
    fixture.loseToken();
    const sibling = createHostDatabase((await getContext().createSiblingClient()).db);
    const restarted = createWorkerDispatch({ ...host, database: sibling, processIncarnation: 'restarted' });
    const supervise = () => restarted.superviseOrderedWorker(call, order.jobRunId, signal);
    const read = () => sibling.transaction((tx) => readDispatch(tx, order.jobRunId));
    const unresolved = { kind: 'unknown', reason: 'dispatch-unresolved' };
    if (outcome === 'allocated') worker.allocations.push(observed.allocationRef);
    await expect(supervise()).resolves.toEqual(unresolved);

    vi.setSystemTime(new Date(order.bootstrapDeadlineAt));
    try {
      await expect(supervise()).resolves.toEqual(unresolved);
      if (outcome === 'allocated') {
        worker.proveUniqueness();
        await expect(supervise()).resolves.toMatchObject({ kind: 'allocated', allocationRef: observed.allocationRef });
      }
      await sibling.transaction((tx) => fixture.setState(tx, 'closed'));
      worker.finishTermination();
      await expect(supervise()).resolves.toEqual(
        outcome === 'absent'
          ? { kind: 'confirmed-absent', evidence: worker.evidence }
          : { kind: 'allocated', allocationRef: observed.allocationRef },
      );
      await expect(read()).resolves.toMatchObject({ sendSettled: false, settled: worker.evidence });
      expect(worker.terminated).toEqual(worker.allocations);
      expect(worker.sends).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the stored provisioning search boundary on every listing page', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const list = vi.spyOn(worker.provider.recovery, 'listAllocations');
    list.mockResolvedValueOnce({ observations: [], nextCursor: 'next-page' });
    const fixture = await orderFixture(database, worker.provider, 'bounded-listing');
    const { host, order } = fixture;
    await database.transaction(fixture.orderIn);
    const decision = await decideStart(host, call, order);
    if (decision.kind !== 'dispatch') throw new Error('Expected a winning claim');
    const { provisioningStartedAt } = decision.claim.binding;
    await createWorkerDispatch(host).superviseOrderedWorker(call, order.jobRunId, signal);
    const filter = { allocationScope: order.allocationScope?.value, jobRunId: order.jobRunId, provisioningStartedAt };
    expect(list.mock.calls.map(([, request]) => request)).toEqual([filter, { ...filter, cursor: 'next-page' }]);
  });

  it('requires a live independent proof and binds it with redemption under the same lock', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider('externally-visible');
    const handle = handleFor('early-redeem');
    const release = vi.spyOn(handle, 'release').mockRejectedValue(new Error('local cleanup failed'));
    vi.spyOn(worker.provider.recovery, 'attach').mockResolvedValue(handle);
    const fixture = await orderFixture(database, worker.provider, 'early-redeem');
    await database.transaction(fixture.orderIn);
    const start = createWorkerDispatch(fixture.host).startOrderedWorker;
    const pending = start(call, fixture.order, signal);
    await worker.exposed.getPromise();
    worker.allocations.push(observed.allocationRef);
    const prepare = () =>
      prepareAllocationBinding(fixture.host, call, fixture.order.jobRunId, {
        kind: 'externally-visible',
        verifyPlatform: async (ref) =>
          ref.providerData['allocation'] === 'first' ? new Date(Date.now() + 60_000).toISOString() : undefined,
      });
    await expect(prepare()).resolves.toBeUndefined();
    worker.proveUniqueness();
    await expect(
      prepareAllocationBinding(fixture.host, call, fixture.order.jobRunId, {
        kind: 'allocation-only',
      }),
    ).resolves.toBeUndefined();
    await expect(
      prepareAllocationBinding(fixture.host, call, fixture.order.jobRunId, {
        kind: 'externally-visible',
        verifyPlatform: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    const binding = await prepare();
    if (binding === undefined) throw new Error('Expected a prepared binding');
    expect(release).toHaveBeenCalled();
    await expect(
      database.transaction(async (tx) => {
        await binding.bind(tx);
        await fixture.setState(tx, 'redeemed');
        throw new Error('redemption failure');
      }),
    ).rejects.toThrow('redemption failure');
    await expect(database.transaction((tx) => readDispatch(tx, fixture.order.jobRunId))).resolves.toMatchObject({
      boundAllocation: null,
    });
    await database.transaction(async (tx) => {
      await binding.bind(tx);
      await fixture.setState(tx, 'redeemed');
    });
    await start(call, fixture.order, signal);
    expect(worker.terminated).toEqual([]);
    worker.answer.resolve({
      kind: 'allocated',
      allocationRef: binding.allocationRef,
      handle: handleFor(fixture.order.jobRunId),
    });
    await expect(pending).resolves.toEqual({ kind: 'allocated', allocationRef: binding.allocationRef });
  });

  it.each([
    'wrong-execution',
    'missing-cancel',
  ])('records late teardown after process-bound redemption with %s', async (problem) => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const { allocationRef } = observed;
    const provider = {
      ...processBoundProvider(worker.provider),
      async proveLocalLive() {
        return { allocationRef, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
    };
    const fixture = await orderFixture(database, provider, `late-redeemed-${problem}`);
    const { order } = fixture;
    const operations = new AbortController();
    const drain = new AbortController();
    const host = {
      ...fixture.host,
      operationSignal: operations.signal,
      provisionDrain: { closed: drain.signal, track() {} },
    };
    const { startOrderedWorker } = createWorkerDispatch(host);
    await database.transaction(fixture.orderIn);
    const pending = startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    const prepared = await prepareAllocationBinding(host, call, order.jobRunId, { kind: 'allocation-only' });
    if (prepared === undefined) throw new Error('Expected a prepared binding');
    await database.transaction(async (tx) => {
      await prepared.bind(tx);
      await fixture.setState(tx, 'redeemed');
    });

    operations.abort();
    drain.abort();
    const handle = handleFor(problem === 'wrong-execution' ? 'other-run' : order.jobRunId);
    if (problem === 'missing-cancel') Reflect.deleteProperty(handle, 'cancel');
    const terminate = vi.spyOn(handle, 'terminate');
    const release = vi.spyOn(handle, 'release');
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle });

    await expect(pending).resolves.toEqual({ kind: 'unknown', reason: 'dispatch-unresolved' });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      boundAllocation: allocationRef,
      sendSettled: true,
      settled: { summary: 'Process-bound allocation terminated' },
    });
  });

  it('treats a refined inspection reference as a conflict (known limitation)', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const { allocationRef } = observed;
    const refined = { ...allocationRef, providerData: { ...allocationRef.providerData, runId: 'provider-run' } };
    vi.spyOn(worker.provider.recovery, 'inspect').mockResolvedValueOnce({ state: 'running', allocationRef: refined });
    const fixture = await orderFixture(database, worker.provider, 'inspection-reference');
    const { host, order } = fixture;
    await database.transaction(fixture.orderIn);
    worker.allocations.push(allocationRef);
    worker.proveUniqueness();
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle: handleFor(order.jobRunId) });
    await createWorkerDispatch(host).startOrderedWorker(call, order, signal);

    const prepare = () => prepareAllocationBinding(host, call, order.jobRunId, { kind: 'allocation-only' });
    await expect(prepare()).resolves.toBeUndefined();
    await expect(prepare()).resolves.toMatchObject({ allocationRef });
  });

  it('reports an attach failure safely, retries, and then stops the allocation it recovered', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    const exited = once(child, 'close');
    try {
      await once(child, 'spawn');
      let attachReady = false;
      let foreign = true;
      const provider = {
        ...worker.provider,
        recovery: {
          ...worker.provider.recovery,
          async listAllocations(
            call: Parameters<typeof worker.provider.recovery.listAllocations>[0],
            request: AllocationListingRequest,
            signal: AbortSignal,
          ) {
            if (!foreign) return worker.provider.recovery.listAllocations(call, request, signal);
            return {
              observations: [{ ...sibling, jobRunId: 'different-order' }],
              completeness: complete,
            };
          },
          async attach() {
            if (!attachReady) throw new Error('Internal provider detail');
            return handleFor('supervised-child');
          },
          async terminateAllocation() {
            child.kill();
            await exited;
            return { state: 'ended' as const, evidence: worker.evidence };
          },
        },
      };
      const { host, order, orderIn, setState } = await orderFixture(database, provider, 'supervised-child');
      await database.transaction(orderIn);
      const dispatch = createWorkerDispatch(host);
      const started = dispatch.startOrderedWorker(call, order, signal);
      await worker.exposed.getPromise();
      worker.answer.reject(new Error('Provision reply lost'));
      await started;
      const supervise = () => dispatch.superviseOrderedWorker(call, order.jobRunId, signal);
      await expect(supervise()).resolves.toEqual({
        kind: 'unknown',
        reason: 'allocation-conflict',
        cleanupRequired: true,
      });
      expect(child.exitCode).toBeNull();
      foreign = false;
      worker.allocations.push(observed.allocationRef);
      worker.proveUniqueness();
      await expect(supervise()).resolves.toEqual({
        kind: 'unknown',
        reason: 'dispatch-unresolved',
        lastAttachFailure: { observedAt: expect.any(String), reason: 'attach-failed' },
      });
      attachReady = true;
      await expect(supervise()).resolves.toEqual({
        kind: 'allocated',
        allocationRef: observed.allocationRef,
        lastAttachFailure: null,
      });
      await database.transaction((tx) => setState(tx, 'closed'));
      foreign = true;
      await expect(supervise()).resolves.toMatchObject({ kind: 'unknown', cleanupRequired: true });
      expect(child.signalCode).toBe('SIGTERM');
      await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
        settled: null,
      });
      foreign = false;
      worker.finishTermination();
      await expect(supervise()).resolves.toEqual({ kind: 'allocated', allocationRef: observed.allocationRef });
      expect(child.signalCode).toBe('SIGTERM');
    } finally {
      child.kill();
      await exited;
    }
  });

  it.each([
    'foreign',
    'unmarked',
  ])('cleans proven candidates and retains the duty with a %s discovery', async (kind) => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const list = worker.provider.recovery.listAllocations;
    vi.spyOn(worker.provider.recovery, 'listAllocations').mockImplementation(async (...args) => {
      const page = await list(...args);
      const foreign = {
        ...observed,
        jobRunId: 'different-order',
        allocationRef: {
          ...observed.allocationRef,
          providerData: { allocation: 'foreign' },
        },
      };
      if (kind === 'unmarked') Reflect.deleteProperty(foreign, 'jobRunId');
      return { ...page, observations: [...page.observations, foreign] };
    });
    const { host, order, orderIn, setState } = await orderFixture(database, worker.provider, `mixed-${kind}`);
    await database.transaction(orderIn);
    const dispatch = createWorkerDispatch(host);
    const pending = dispatch.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    worker.answer.reject(new Error('Provision reply lost'));
    await pending;
    await database.transaction((tx) => setState(tx, 'closed'));
    worker.allocations.push(observed.allocationRef, sibling.allocationRef);
    worker.finishTermination();

    await expect(dispatch.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual({
      kind: 'unknown',
      reason: 'allocation-conflict',
      cleanupRequired: true,
    });
    expect(worker.terminated).toEqual(worker.allocations);
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      candidates: worker.allocations,
      settled: null,
    });
  });

  it('keeps late conflicting allocations open across restart and cleans each confirmed candidate', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const fixture = await orderFixture(database, worker.provider, 'late-conflict');
    await database.transaction(fixture.orderIn);
    const pending = createWorkerDispatch(fixture.host).startOrderedWorker(call, fixture.order, signal);
    await worker.exposed.getPromise();
    worker.allocations.push(observed.allocationRef);
    worker.proveUniqueness();
    const prepared = await prepareAllocationBinding(fixture.host, call, fixture.order.jobRunId, {
      kind: 'allocation-only',
    });
    if (prepared === undefined) throw new Error('Expected a prepared binding before cancellation');
    await database.transaction((tx) => fixture.setState(tx, 'closed'));
    await expect(database.transaction(prepared.bind)).rejects.toThrow('Allocation binding is no longer valid');
    const siblingDb = createHostDatabase((await getContext().createSiblingClient()).db);
    const resumed = createWorkerDispatch({
      ...fixture.host,
      database: siblingDb,
      processIncarnation: 'restarted',
    }).superviseOrderedWorker;
    worker.allocations.push(sibling.allocationRef);
    await expect(resumed(call, fixture.order.jobRunId, signal)).resolves.toEqual({
      kind: 'unknown',
      reason: 'allocation-conflict',
    });
    expect(worker.terminated).toEqual(worker.allocations);
    worker.answer.reject(new Error('provider reply lost'));
    await expect(pending).resolves.toEqual({ kind: 'unknown', reason: 'allocation-conflict' });
    await expect(siblingDb.transaction((tx) => readDispatch(tx, fixture.order.jobRunId))).resolves.toMatchObject({
      settled: null,
    });
    worker.finishTermination();
    await resumed(call, fixture.order.jobRunId, signal);
    await expect(siblingDb.transaction((tx) => readDispatch(tx, fixture.order.jobRunId))).resolves.toMatchObject({
      settled: worker.evidence,
    });
    expect(worker.terminated).toEqual([...worker.allocations, ...worker.allocations]);
  });
});
