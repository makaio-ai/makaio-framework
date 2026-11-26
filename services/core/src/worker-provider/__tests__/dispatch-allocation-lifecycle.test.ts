import { PRE_REQUEST_REJECTION_CODE, type ProviderAllocationRef } from '@makaio/contracts';
import { resolveStorageConformanceConfig, useSuiteDatabaseContext } from '@makaio/storage-conformance';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { DeferredPromise } from '@makaio/utils';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { insertDispatch, readDispatch, recordLateAllocation, updateDispatch } from '../dispatch-store.js';
import type { OrderedWorkerProvider } from '@makaio/contracts/extension';
import { finishLateProvisionHandle } from '../local-worker-control.js';
import { decideStart } from '../start-claim.js';
import { createWorkerDispatch } from '../start-ordered-worker.js';
import {
  call,
  controllableProvider,
  fixtureToken,
  handleFor,
  installOrderFixture,
  orderFixture,
  processBoundProvider,
  providerId,
} from './ordered-worker-fixture.js';
import { bookRedemptionOwner, migrateRedemptionOwner } from './redemption-owner-fixture.js';

const config = resolveStorageConformanceConfig();
if (config === null) throw new Error('MAKAIO_STORAGE_TEST_URL is required for PostgreSQL dispatch tests');
const signal = new AbortController().signal;
const allocationRef: ProviderAllocationRef = { version: 1, providerId, providerData: { allocation: 'worker' } };

describe(`ordered allocation lifecycle (${config.dialect})`, () => {
  const getContext = useSuiteDatabaseContext(config);
  beforeAll(async () => installOrderFixture(getContext()));
  beforeAll(async () => migrateRedemptionOwner(getContext()));

  it.each([false, true])('hands off a late allocation (termination fails: %s)', async (fails) => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const terminateByReference = vi.spyOn(worker.provider.recovery, 'terminateAllocation');
    const fixture = await orderFixture(database, worker.provider, `late-allocation-${fails}`);
    const { order, host } = fixture;
    await database.transaction(fixture.orderIn);
    const sender = createWorkerDispatch(host);
    const siblingDb = createHostDatabase((await getContext().createSiblingClient()).db);
    const observer = createWorkerDispatch({ ...host, database: siblingDb, processIncarnation: 'observer' });
    const handle = handleFor(order.jobRunId);
    const terminate = vi.spyOn(handle, 'terminate');
    const release = vi.spyOn(handle, 'release');
    const pending = sender.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(order.bootstrapDeadlineAt));
    const absent = { kind: 'confirmed-absent', evidence: worker.evidence };
    try {
      worker.finishTermination();
      await expect(observer.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual(absent);
      if (fails) terminateByReference.mockRejectedValueOnce(new Error('teardown unconfirmed'));
    } finally {
      worker.answer.resolve({ kind: 'allocated', allocationRef, handle });
      try {
        await pending;
      } finally {
        clock.mockRestore();
      }
    }
    expect(worker.sends).toHaveLength(1);
    expect(terminateByReference).toHaveBeenCalledTimes(1);
    expect(terminateByReference.mock.calls[0]?.[2]).toEqual(allocationRef);
    expect(terminate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    const read = () => siblingDb.transaction((tx) => readDispatch(tx, order.jobRunId));
    await expect(read()).resolves.toMatchObject({
      boundAllocation: null,
      settled: {
        ...worker.evidence,
        lateAllocation: { reference: allocationRef, state: fails ? 'pending' : 'ended' },
      },
    });
    await expect(pending).resolves.toEqual(absent);
    await expect(observer.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual(absent);
    expect(worker.terminated).toEqual([allocationRef]);
    await expect(read()).resolves.toMatchObject({ settled: { lateAllocation: { state: 'ended' } } });
  });

  it('cleans up a late atomic allocation under supervision without a credential reader', async () => {
    const { db, executor } = getContext();
    const database = createHostDatabase(db);
    const worker = controllableProvider();
    const { host, order } = await orderFixture(database, worker.provider, 'late-atomic-allocation');
    if (order.allocationLifetime !== 'provider-managed') throw new Error('Expected a managed allocation');
    const { kind, id } = call.caller;
    const owner = await bookRedemptionOwner(database, order, { kind, id }, fixtureToken, false);
    const source = owner.sourceFor(executor);
    const { jobRunId, allocationLifetime, allocationScope } = order;
    await database.transaction(async (tx) => {
      const locked = await source.lockOrder(tx, jobRunId);
      if (locked?.redemption === undefined) throw new Error('Expected an atomic booking');
      const claim = await insertDispatch(tx, {
        jobRunId,
        orderDigest: locked.orderDigest,
        binding: {
          jobRunId,
          providerId,
          allocationLifetime,
          allocationScope,
          provisioningStartedAt: new Date().toISOString(),
        },
      });
      if (claim === undefined) throw new Error('Dispatch already exists');
      const settled = await updateDispatch(tx, claim, { settled: worker.evidence });
      await recordLateAllocation(tx, settled, { reference: allocationRef, state: 'pending' });
    });

    Reflect.deleteProperty(source, 'readRedemptionCredentials');
    worker.finishTermination();
    const observer = createWorkerDispatch({ ...host, source });
    await expect(observer.superviseOrderedWorker(call, jobRunId, signal)).resolves.toEqual({
      kind: 'confirmed-absent',
      evidence: worker.evidence,
    });
    expect(worker.terminated).toEqual([allocationRef]);
    await expect(database.transaction((tx) => readDispatch(tx, jobRunId))).resolves.toMatchObject({
      settled: { lateAllocation: { reference: allocationRef, state: 'ended' } },
    });
  });

  it.each([
    'ended',
    'read-failure',
    'in-flight',
  ])('releases the sender handle with recovery at write acknowledgment (%s)', async (recoveryPhase) => {
    const database = createHostDatabase(getContext().db);
    const siblingDb = createHostDatabase((await getContext().createSiblingClient()).db);
    const worker = controllableProvider();
    const end = worker.provider.recovery.terminateAllocation;
    const terminateByReference = vi.spyOn(worker.provider.recovery, 'terminateAllocation');
    const { host, order, orderIn } = await orderFixture(
      database,
      worker.provider,
      `recovery-before-ack-${recoveryPhase}`,
    );
    const committed = new DeferredPromise<void>();
    const acknowledge = new DeferredPromise<void>();
    let delayAcknowledgment = false;
    let failRead = false;
    let readFailed = false;
    const delayed: typeof database = {
      ...database,
      async transaction(body) {
        const result = await database.transaction(async (tx) => {
          if (failRead && !readFailed) {
            readFailed = true;
            throw new Error('late allocation reread unavailable');
          }
          return body(tx);
        });
        if (delayAcknowledgment) {
          delayAcknowledgment = false;
          committed.resolve();
          await acknowledge.getPromise();
        }
        return result;
      },
    };
    const sender = createWorkerDispatch({ ...host, database: delayed });
    const observer = createWorkerDispatch({
      ...host,
      database: siblingDb,
      processIncarnation: 'observer',
      handles: new Map(),
    });
    const handle = handleFor(order.jobRunId);
    const terminate = vi.spyOn(handle, 'terminate');
    const release = vi.spyOn(handle, 'release');
    const enteredTermination = new DeferredPromise<void>();
    const resumeTermination = new DeferredPromise<void>();
    await database.transaction(orderIn);
    const pending = sender.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(order.bootstrapDeadlineAt));
    const absent = { kind: 'confirmed-absent', evidence: worker.evidence };
    let recovery: ReturnType<typeof observer.superviseOrderedWorker> | undefined;
    try {
      worker.finishTermination();
      await expect(observer.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual(absent);
      delayAcknowledgment = true;
      worker.answer.resolve({ kind: 'allocated', allocationRef, handle });
      await committed.getPromise();
      if (recoveryPhase === 'in-flight') {
        terminateByReference.mockImplementationOnce(async (...args) => {
          const result = await end(...args);
          enteredTermination.resolve();
          await resumeTermination.getPromise();
          return result;
        });
      }
      recovery = observer.superviseOrderedWorker(call, order.jobRunId, signal);
      if (recoveryPhase === 'in-flight') {
        await enteredTermination.getPromise();
      } else {
        await expect(recovery).resolves.toEqual(absent);
      }
      failRead = recoveryPhase === 'read-failure';
      acknowledge.resolve();
      await expect(pending).resolves.toEqual(absent);
    } finally {
      worker.answer.resolve({ kind: 'allocated', allocationRef, handle });
      acknowledge.resolve();
      resumeTermination.resolve();
      clock.mockRestore();
      await Promise.all([pending, recovery]);
    }
    expect(readFailed).toBe(recoveryPhase === 'read-failure');
    expect(terminate).not.toHaveBeenCalled();
    expect(worker.terminated).toEqual(recoveryPhase === 'in-flight' ? [allocationRef, allocationRef] : [allocationRef]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(host.handles.size).toBe(0);
    await expect(siblingDb.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      settled: { lateAllocation: { reference: allocationRef, state: 'ended' } },
    });
  });

  it.each([
    'open',
    'expired',
    'settled',
    'closed',
  ])('checks dispatch eligibility after claim commit (%s)', async (phase) => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const fixture = await orderFixture(database, worker.provider, `send-deadline-${phase}`);
    const { order, host } = fixture;
    await database.transaction(fixture.orderIn);
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle: handleFor(order.jobRunId) });
    worker.finishTermination();
    const clock = vi.spyOn(Date, 'now');
    const siblingDb = createHostDatabase((await getContext().createSiblingClient()).db);
    const observer = createWorkerDispatch({ ...host, database: siblingDb });
    const absent = { kind: 'confirmed-absent', evidence: worker.evidence };
    const transaction = database.transaction.bind(database);
    let claimAcknowledged = false;
    const delayedDatabase: typeof database = {
      ...database,
      async transaction(body) {
        const result = await transaction(body);
        if (claimAcknowledged) return result;
        claimAcknowledged = true;
        if (phase === 'expired' || phase === 'settled') clock.mockReturnValue(Date.parse(order.bootstrapDeadlineAt));
        if (phase === 'settled') {
          await expect(observer.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual(absent);
        }
        if (phase === 'closed') await siblingDb.transaction((tx) => fixture.setState(tx, 'closed'));
        return result;
      },
    };
    try {
      const dispatch = createWorkerDispatch({ ...host, database: delayedDatabase });
      const result = await dispatch.startOrderedWorker(call, order, signal);
      expect(worker.sends).toHaveLength(phase === 'open' ? 1 : 0);
      if (phase === 'closed') {
        expect(result).toMatchObject({ kind: 'confirmed-absent', evidence: { code: PRE_REQUEST_REJECTION_CODE } });
        await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
          sendSettled: true,
          settled: { code: PRE_REQUEST_REJECTION_CODE },
        });
      } else {
        expect(result).toEqual(phase === 'open' ? { kind: 'allocated', allocationRef } : absent);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    'managed-ended',
    'managed-ending',
    'process-bound',
  ])('cleans up an allocation returned after the order closes (%s)', async (mode) => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const processBound = mode === 'process-bound';
    const provider = processBound ? processBoundProvider(worker.provider) : worker.provider;
    const fixture = await orderFixture(database, provider, `closed-during-send-${mode}`);
    const { host, order } = fixture;
    await database.transaction(fixture.orderIn);
    const dispatch = createWorkerDispatch(host);
    const handle = handleFor(order.jobRunId);
    const terminate = vi.spyOn(handle, 'terminate');
    const release = vi.spyOn(handle, 'release');

    const pending = dispatch.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    await database.transaction((tx) => fixture.setState(tx, 'closed'));
    if (mode === 'managed-ended') {
      worker.allocations.push(allocationRef);
      worker.finishTermination();
    }
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle });
    await pending;

    expect(worker.sends).toHaveLength(1);
    expect(worker.terminated).toEqual(processBound ? [] : [allocationRef]);
    expect(terminate).toHaveBeenCalledTimes(processBound ? 1 : 0);
    expect(release).toHaveBeenCalledTimes(1);
    const claim = await database.transaction((tx) => readDispatch(tx, order.jobRunId));
    expect(claim).toMatchObject({ sendSettled: true, candidates: [allocationRef] });
    if (processBound) {
      expect(claim?.settled).toMatchObject({ summary: 'Process-bound allocation terminated' });
    } else {
      expect(claim?.settled).toEqual(mode === 'managed-ended' ? worker.evidence : null);
    }
  });

  it('returns the settlement recorded by another observer while listing allocations', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const listing = new DeferredPromise<void>();
    const resume = new DeferredPromise<void>();
    const listAllocations = vi.fn(worker.provider.recovery.listAllocations).mockImplementationOnce(async (...args) => {
      listing.resolve();
      await resume.getPromise();
      return worker.provider.recovery.listAllocations(...args);
    });
    const provider: OrderedWorkerProvider = {
      ...worker.provider,
      recovery: { ...worker.provider.recovery, listAllocations },
    };
    const fixture = await orderFixture(database, provider, 'racing-observers');
    const { order, host } = fixture;
    await database.transaction(fixture.orderIn);
    const sender = createWorkerDispatch(host);
    const siblingDb = createHostDatabase((await getContext().createSiblingClient()).db);
    const observer = createWorkerDispatch({ ...host, database: siblingDb });
    const started = sender.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    worker.answer.reject(new Error('provision reply was lost'));
    await expect(started).resolves.toEqual({ kind: 'unknown', reason: 'dispatch-unresolved' });
    worker.finishTermination();
    const absent = { kind: 'confirmed-absent', evidence: worker.evidence };
    const pending = sender.superviseOrderedWorker(call, order.jobRunId, signal);
    await listing.getPromise();
    try {
      await expect(observer.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toEqual(absent);
    } finally {
      resume.resolve();
    }
    await expect(pending).resolves.toEqual(absent);
  });

  it.each([
    'malformed-handle',
    'wrong-execution',
  ] as const)('keeps a managed reference for cleanup when provision returns %s', async (problem) => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const fixture = await orderFixture(database, worker.provider, problem);
    await database.transaction(fixture.orderIn);
    const { order, host } = fixture;
    const dispatch = createWorkerDispatch(host);
    const handle = handleFor(problem === 'wrong-execution' ? 'other-run' : order.jobRunId);
    if (problem === 'malformed-handle') Reflect.deleteProperty(handle, 'terminate');
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle });

    await expect(dispatch.startOrderedWorker(call, order, signal)).resolves.toEqual({
      kind: 'unknown',
      reason: 'dispatch-unresolved',
    });
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      boundAllocation: null,
      candidates: [allocationRef],
      sendSettled: true,
    });
    await database.transaction((tx) => fixture.setState(tx, 'closed'));
    worker.allocations.push(allocationRef);
    await dispatch.superviseOrderedWorker(call, order.jobRunId, signal);
    expect(worker.terminated).toEqual([allocationRef]);
  });

  it.each([false, true])('settles a process-bound teardown (mismatched execution: %s)', async (mismatched) => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const provider = processBoundProvider(worker.provider);
    const fixture = await orderFixture(database, provider, `process-${mismatched}`);
    const { order, host } = fixture;
    await database.transaction(fixture.orderIn);
    const dispatch = createWorkerDispatch(host);
    const handle = handleFor(mismatched ? 'other-run' : order.jobRunId);
    const terminate = vi.spyOn(handle, 'terminate');
    const release = vi.spyOn(handle, 'release');
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle });

    const started = await dispatch.startOrderedWorker(call, order, signal);
    expect(started.kind).toBe(mismatched ? 'unknown' : 'allocated');
    expect(terminate).toHaveBeenCalledTimes(mismatched ? 1 : 0);
    await database.transaction((tx) => fixture.setState(tx, 'closed'));
    await dispatch.superviseOrderedWorker(call, order.jobRunId, signal);
    await dispatch.superviseOrderedWorker(call, order.jobRunId, signal);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      candidates: [allocationRef],
      boundAllocation: mismatched ? null : allocationRef,
      settled: expect.objectContaining({ summary: 'Process-bound allocation terminated' }),
    });
  });

  it('terminates a managed handle returned after the provisioning drain closes', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const { host, order, orderIn } = await orderFixture(database, worker.provider, 'managed-after-drain');
    const drain = new AbortController();
    const operations = new AbortController();
    const dispatch = createWorkerDispatch({
      ...host,
      operationSignal: operations.signal,
      provisionDrain: { closed: drain.signal, track() {} },
    });
    const handle = handleFor(order.jobRunId);
    const terminate = vi.spyOn(handle, 'terminate');
    const release = vi.spyOn(handle, 'release');

    await database.transaction(orderIn);
    const pending = dispatch.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    operations.abort();
    drain.abort();
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle });

    await expect(pending).resolves.toEqual({ kind: 'unknown', reason: 'dispatch-unresolved' });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(host.handles.size).toBe(0);
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      sendSettled: false,
      settled: null,
    });
  });

  it('shares process control between two dispatch services of the same host', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const { host, order, orderIn, setState } = await orderFixture(
      database,
      processBoundProvider(worker.provider),
      'shared-process-control',
    );
    const sender = createWorkerDispatch(host);
    const observer = createWorkerDispatch({ ...host });
    const handle = handleFor(order.jobRunId);
    const terminate = vi.spyOn(handle, 'terminate');

    expect(sender).not.toBe(observer);
    await database.transaction(orderIn);
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle });
    await expect(sender.startOrderedWorker(call, order, signal)).resolves.toEqual({
      kind: 'allocated',
      allocationRef,
    });
    await database.transaction((tx) => setState(tx, 'closed'));

    const supervise = () => observer.superviseOrderedWorker(call, order.jobRunId, signal);
    await Promise.all([supervise(), supervise()]);
    expect(terminate).toHaveBeenCalledTimes(1);
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      settled: expect.objectContaining({ summary: 'Process-bound allocation terminated' }),
    });
  });

  it('retries recording process teardown without terminating the worker again', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const { host, order, orderIn, setState } = await orderFixture(
      database,
      processBoundProvider(worker.provider),
      'retry-process-settlement',
    );
    const handle = handleFor(order.jobRunId);
    const persistenceError = new Error('Settlement transaction failed');
    let failSettlement = false;
    const terminate = vi.spyOn(handle, 'terminate').mockImplementationOnce(async () => {
      failSettlement = true;
    });
    const dispatch = createWorkerDispatch({
      ...host,
      source: {
        ...host.source,
        async lockOrder(tx, id) {
          if (failSettlement) {
            failSettlement = false;
            throw persistenceError;
          }
          return host.source.lockOrder(tx, id);
        },
      },
    });

    await database.transaction(orderIn);
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle });
    await dispatch.startOrderedWorker(call, order, signal);
    await database.transaction((tx) => setState(tx, 'closed'));
    const supervise = () => dispatch.superviseOrderedWorker(call, order.jobRunId, signal);

    await expect(supervise()).rejects.toThrow(persistenceError);
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      settled: null,
    });
    await supervise();
    expect(terminate).toHaveBeenCalledTimes(1);
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      settled: expect.objectContaining({ summary: 'Process-bound allocation terminated' }),
    });
  });

  it('rejects a process-bound handle without terminate and retains its reference for diagnosis', async () => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const provider = processBoundProvider(worker.provider);
    const fixture = await orderFixture(database, provider, 'process-missing-terminate');
    const { order, host } = fixture;
    await database.transaction(fixture.orderIn);
    const handle = handleFor(order.jobRunId);
    const release = vi.spyOn(handle, 'release');
    Reflect.deleteProperty(handle, 'terminate');
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle });

    const dispatch = createWorkerDispatch(host);
    await expect(dispatch.startOrderedWorker(call, order, signal)).rejects.toThrow(TypeError);
    expect(release).not.toHaveBeenCalled();
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      boundAllocation: null,
      candidates: [allocationRef],
      sendSettled: true,
    });
  });

  it.each([
    'managed',
    'process-without-terminate',
  ])('releases an unretained %s handle on lost settlement acknowledgment', async (lifetime) => {
    const database = createHostDatabase(getContext().db);
    const worker = controllableProvider();
    const provider = lifetime === 'managed' ? worker.provider : processBoundProvider(worker.provider);
    const fixture = await orderFixture(database, provider, `lost-settlement-${lifetime}`);
    const { order, host } = fixture;
    await database.transaction(fixture.orderIn);
    const failure = new Error('settlement acknowledgment lost');
    const unreliable: typeof database = {
      ...database,
      async transaction(body) {
        const result = await database.transaction(body);
        if (worker.sends.length > 0) throw failure;
        return result;
      },
    };
    const handle = handleFor(order.jobRunId);
    const release = vi.spyOn(handle, 'release').mockRejectedValue(new Error('local cleanup failed'));
    if (lifetime !== 'managed') Reflect.deleteProperty(handle, 'terminate');
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle });

    const dispatch = createWorkerDispatch({ ...host, database: unreliable });
    await expect(dispatch.startOrderedWorker(call, order, signal)).rejects.toBe(failure);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      candidates: [allocationRef],
      sendSettled: true,
    });
  });

  it.each([
    'aborted',
    'connection-error',
    'provider-error',
  ])('records only proven pre-request failures as absent (%s)', async (failure) => {
    const database = createHostDatabase(getContext().db);
    const provider = processBoundProvider();
    const provision = vi.spyOn(provider, 'provision').mockRejectedValue(new Error('provision failed'));
    const fixture = await orderFixture(database, provider, `pre-request-${failure}`);
    const { order, host } = fixture;
    await database.transaction(fixture.orderIn);
    const dispatch = createWorkerDispatch({
      ...host,
      operationSignal: failure === 'aborted' ? AbortSignal.abort() : host.operationSignal,
      connection() {
        if (failure === 'connection-error') throw new Error('connection material unavailable');
        return host.connection();
      },
    });
    const result =
      failure === 'provider-error'
        ? { kind: 'unknown', reason: 'dispatch-unresolved' }
        : { kind: 'confirmed-absent', evidence: { code: PRE_REQUEST_REJECTION_CODE } };

    await expect(dispatch.startOrderedWorker(call, order, signal)).resolves.toMatchObject(result);
    expect(provision).toHaveBeenCalledTimes(failure === 'provider-error' ? 1 : 0);
    await expect(dispatch.superviseOrderedWorker(call, order.jobRunId, signal)).resolves.toMatchObject(result);
  });

  it('keeps the bootstrap token out of every column of both worker tables', async () => {
    const { db, executor } = getContext();
    const database = createHostDatabase(db);
    const worker = controllableProvider();
    const fixture = await orderFixture(database, worker.provider, 'volatile-token');
    const { order, host } = fixture;
    await database.transaction(fixture.orderIn);
    const dispatch = createWorkerDispatch(host);
    const read = () => database.transaction((tx) => readDispatch(tx, order.jobRunId));
    const containsToken = async () => {
      const scopeRows = await executor.all(sql`SELECT * FROM worker_allocation_scope_binding`);
      const dispatchRows = await executor.all(sql`SELECT * FROM worker_dispatch`);
      expect(scopeRows).toHaveLength(1);
      expect(dispatchRows).toContainEqual(expect.objectContaining({ job_run_id: order.jobRunId }));
      return JSON.stringify([scopeRows, dispatchRows]).includes(fixtureToken);
    };

    const pending = dispatch.startOrderedWorker(call, order, signal);
    await worker.exposed.getPromise();
    await expect(read()).resolves.toMatchObject({ sendSettled: false, settled: null });
    await expect(containsToken()).resolves.toBe(false);
    worker.allocations.push(allocationRef);
    worker.answer.resolve({ kind: 'allocated', allocationRef, handle: handleFor(order.jobRunId) });
    await expect(pending).resolves.toEqual({ kind: 'allocated', allocationRef });
    expect(worker.sends).toMatchObject([{ hasToken: true }]);
    await expect(containsToken()).resolves.toBe(false);
    await database.transaction((tx) => fixture.setState(tx, 'closed'));
    worker.finishTermination();
    await dispatch.superviseOrderedWorker(call, order.jobRunId, signal);
    await expect(read()).resolves.toMatchObject({ settled: worker.evidence });
    await expect(containsToken()).resolves.toBe(false);
    await executor.run(
      sql`UPDATE worker_dispatch SET order_digest = ${fixtureToken} WHERE job_run_id = ${order.jobRunId}`,
    );
    await expect(containsToken()).resolves.toBe(true);
  });

  it('leaves an unbound claim open when a late handle comes from another process incarnation', async () => {
    const database = createHostDatabase(getContext().db);
    const { host, order, orderIn } = await orderFixture(database, processBoundProvider(), 'late-from-old-process');
    await database.transaction(orderIn);
    await expect(decideStart(host, call, order)).resolves.toMatchObject({ kind: 'dispatch' });
    const handle = handleFor(order.jobRunId);
    const terminate = vi.spyOn(handle, 'terminate');
    const release = vi.spyOn(handle, 'release');

    await finishLateProvisionHandle({ ...host, processIncarnation: 'old-incarnation' }, order.jobRunId, handle, {
      managed: false,
      reference: allocationRef,
      matchesRun: true,
    });

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toMatchObject({
      boundAllocation: null,
      sendSettled: false,
      settled: null,
    });
  });
});
