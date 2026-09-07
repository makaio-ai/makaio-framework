import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { createInMemoryAttemptRepository } from '../testing/in-memory-attempt-repository.js';
import {
  driveTestAttemptToAllocated,
  beginTestProvisioning,
  makeEvidence,
  makeTestAllocationRef,
  makeTestInstruction,
  workflowRunResultOutcomeCodec,
} from '../testing/attempt-fixtures.js';

/**
 * Build a real repository and immutable-budget Authority.
 * @param bootstrapTimeoutMs - Explicit creation-time budget for the test Authority.
 */
async function fixture(bootstrapTimeoutMs = 60_000) {
  const repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);
  const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs });
  const record = await authority.createAttempt('owner', makeTestInstruction());
  const identity = { executionId: 'owner', executionAttemptId: record.executionAttemptId };
  return { repository, authority, record, identity };
}

/**
 * Current request deadline, independent of the durable creation budget.
 * @param duration - Remaining duration of this request in milliseconds.
 */
function options(duration = 35_000) {
  return { signal: new AbortController().signal, deadline: Date.now() + duration };
}

describe('durable bootstrap start authorization', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    0,
    -1,
    0.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid host budget %s', (bootstrapTimeoutMs) => {
    expect(
      () =>
        new ExecutionAttemptAuthority(createInMemoryAttemptRepository(workflowRunResultOutcomeCodec), {
          bootstrapTimeoutMs,
        }),
    ).toThrow('bootstrapTimeoutMs');
  });

  it('freezes the configured budget before callers can mutate their options', async () => {
    const repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);
    const config = { bootstrapTimeoutMs: 5_000 };
    const authority = new ExecutionAttemptAuthority(repository, config);
    config.bootstrapTimeoutMs = 1;
    const record = await authority.createAttempt('owner', makeTestInstruction());
    expect(Date.parse(record.bootstrapDeadlineAt!) - Date.parse(record.createdAt)).toBe(5_000);
  });

  it('observes delayed allocation without registration or notifications', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const wait = f.authority.awaitBootstrapStart(f.identity, options());
    await vi.advanceTimersByTimeAsync(12_000);
    await driveTestAttemptToAllocated(f.authority, f.identity.executionAttemptId, 'owner');
    await vi.advanceTimersByTimeAsync(100);
    await expect(wait).resolves.toEqual({ status: 'permitted' });
    expect((await f.authority.getAttemptControlState(f.identity.executionAttemptId))?.runtimeGeneration).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns pending at 30 seconds, rereads at expiry, then renews from durable state', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const reads = vi.spyOn(f.repository, 'readBootstrapStartState');
    const first = f.authority.awaitBootstrapStart(f.identity, options());
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toEqual({ status: 'pending' });
    expect(reads).toHaveBeenCalledTimes(301);
    expect(vi.getTimerCount()).toBe(0);
    await driveTestAttemptToAllocated(f.authority, f.identity.executionAttemptId, 'owner');
    await expect(f.authority.awaitBootstrapStart(f.identity, options())).resolves.toEqual({ status: 'permitted' });
  });

  it('refuses when the immutable total budget expires inside a lease', async () => {
    vi.useFakeTimers();
    const f = await fixture(500);
    const wait = f.authority.awaitBootstrapStart(f.identity, options());
    await vi.advanceTimersByTimeAsync(500);
    await expect(wait).resolves.toEqual({ status: 'refused', reason: 'bootstrap-expired' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a request margin and performs no sleep when no lease remains', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await expect(f.authority.awaitBootstrapStart(f.identity, options(1_000))).resolves.toEqual({ status: 'pending' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels promptly during polling and releases timers', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const controller = new AbortController();
    const wait = f.authority.awaitBootstrapStart(f.identity, { ...options(), signal: controller.signal });
    const rejected = expect(wait).rejects.toThrow('caller stopped');
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('caller stopped'));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks caller cancellation before observing storage', async () => {
    const f = await fixture();
    const reads = vi.spyOn(f.repository, 'readBootstrapStartState');
    await expect(
      f.authority.awaitBootstrapStart(f.identity, { ...options(), signal: AbortSignal.abort(new Error('stopped')) }),
    ).rejects.toThrow('stopped');
    expect(reads).not.toHaveBeenCalled();
  });

  it('refuses wrong owners and missing attempts', async () => {
    const f = await fixture();
    for (const identity of [
      { ...f.identity, executionId: 'wrong' },
      { ...f.identity, executionAttemptId: 'missing' },
    ]) {
      await expect(f.authority.awaitBootstrapStart(identity, options())).resolves.toEqual({
        status: 'refused',
        reason: 'not-found',
      });
    }
  });

  it('gives settlement and fencing priority over closed gates and legacy deadlines', async () => {
    const f = await fixture();
    f.repository.attempts.set(f.record.executionAttemptId, { ...f.record, bootstrapDeadlineAt: null });
    await expect(f.authority.awaitBootstrapStart(f.identity, options())).resolves.toEqual({
      status: 'refused',
      reason: 'bootstrap-expired',
    });
    await f.authority.createAttempt('owner', makeTestInstruction());
    await expect(f.authority.awaitBootstrapStart(f.identity, options())).resolves.toEqual({
      status: 'refused',
      reason: 'fenced',
    });
    f.repository.attempts.set(f.record.executionAttemptId, {
      ...f.record,
      status: 'settled',
      settlementKind: 'abandoned',
      bootstrapDeadlineAt: null,
    });
    await expect(f.authority.awaitBootstrapStart(f.identity, options())).resolves.toEqual({
      status: 'refused',
      reason: 'resolved',
    });
  });

  it('reads a reconstructed Authority against the same durable state', async () => {
    const f = await fixture();
    await driveTestAttemptToAllocated(f.authority, f.identity.executionAttemptId, 'owner');
    const restarted = new ExecutionAttemptAuthority(
      createInMemoryAttemptRepository(workflowRunResultOutcomeCodec, f.repository),
      { bootstrapTimeoutMs: 1 },
    );
    await expect(restarted.awaitBootstrapStart(f.identity, options())).resolves.toEqual({ status: 'permitted' });
  });

  it('prioritizes terminated allocation over closed gate and expiry', async () => {
    const f = await fixture();
    const claim = await beginTestProvisioning(f.authority, f.identity.executionAttemptId, 'owner');
    await f.authority.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
    await f.authority.recordAllocationTerminated({ claim, evidence: makeEvidence() });
    const stored = f.repository.attempts.get(f.record.executionAttemptId)!;
    f.repository.attempts.set(f.record.executionAttemptId, {
      ...stored,
      operationStartGate: 'closed',
      bootstrapDeadlineAt: null,
    });
    await expect(f.authority.awaitBootstrapStart(f.identity, options())).resolves.toEqual({
      status: 'refused',
      reason: 'allocation-terminated',
    });
  });

  it('prioritizes a closed gate over an expired or invalid deadline', async () => {
    const f = await fixture();
    f.repository.attempts.set(f.record.executionAttemptId, {
      ...f.record,
      operationStartGate: 'closed',
      bootstrapDeadlineAt: 'invalid',
    });
    await expect(f.authority.awaitBootstrapStart(f.identity, options())).resolves.toEqual({
      status: 'refused',
      reason: 'gate-closed',
    });
    f.repository.attempts.set(f.record.executionAttemptId, { ...f.record, bootstrapDeadlineAt: 'invalid' });
    await expect(f.authority.awaitBootstrapStart(f.identity, options())).resolves.toEqual({
      status: 'refused',
      reason: 'bootstrap-expired',
    });
  });

  it('bounds a stalled repository observation and observes its late rejection', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    let rejectRead: (error: Error) => void = () => {};
    const stalled = new Promise<never>((_resolve, reject) => {
      rejectRead = reject;
    });
    const read = f.repository.readBootstrapStartState;
    const authority = new ExecutionAttemptAuthority(
      {
        ...f.repository,
        readBootstrapStartState: async (identity) => {
          await read(identity);
          return stalled;
        },
      },
      { bootstrapTimeoutMs: 60_000 },
    );
    const wait = authority.awaitBootstrapStart(f.identity, options(2_000));
    const rejected = expect(wait).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    rejectRead(new Error('late storage failure'));
    await Promise.resolve();
  });

  it('caps a later stalled read to the known durable deadline and final-read margin', async () => {
    vi.useFakeTimers();
    const f = await fixture(500);
    const read = f.repository.readBootstrapStartState;
    let reads = 0;
    const authority = new ExecutionAttemptAuthority(
      {
        ...f.repository,
        readBootstrapStartState: async (identity) => {
          const state = await read(identity);
          reads += 1;
          return reads === 1 ? state : new Promise<never>(() => {});
        },
      },
      { bootstrapTimeoutMs: 60_000 },
    );
    const wait = authority.awaitBootstrapStart(f.identity, options());
    const rejected = expect(wait).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1_500);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
