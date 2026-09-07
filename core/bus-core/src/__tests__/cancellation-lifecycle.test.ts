import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError as DeadlineError } from 'p-timeout';
import pDefer from 'p-defer';
import { BusAbortError, CorrelationTracker, isRequestCancellation, TimeoutError } from '../index.js';
import { awaitWithTimeoutAndSignal } from '../methods/request/await-with-timeout-and-signal.js';

afterEach(() => vi.useRealTimers());

describe.each([0, 100])('shared request wait timeout=%s', (timeout) => {
  it.each(['success', 'failure', 'cancel'] as const)('cleans listeners and timers on %s', async (outcome) => {
    vi.useFakeTimers();
    const operation = pDefer<string>();
    const controller = new AbortController();
    const failure = new Error('independent operation failure');
    const result = awaitWithTimeoutAndSignal(operation.promise, timeout, controller.signal).catch((e: unknown) => e);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    if (outcome === 'success') operation.resolve('done');
    if (outcome === 'failure') operation.reject(failure);
    if (outcome === 'cancel') controller.abort('shutdown');
    const value = await result;
    if (outcome === 'success') expect(value).toBe('done');
    if (outcome === 'failure') expect(value).toBe(failure);
    if (outcome === 'cancel') expect(isRequestCancellation(value, controller.signal)).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    // The already-returned cancellation must still observe this losing rejection.
    operation.reject(new Error('late operation failure'));
    await Promise.resolve();
  });

  it('observes an already rejected operation when the signal is pre-aborted', async () => {
    vi.useFakeTimers();
    const signal = AbortSignal.abort({ owner: 'caller' });
    const operation = Promise.reject(new Error('independent losing rejection'));
    const error = await awaitWithTimeoutAndSignal(operation, timeout, signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BusAbortError);
    expect(isRequestCancellation(error, signal)).toBe(true);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await Promise.resolve();
  });

  it.each([
    { name: 'Error', failure: new Error('unrelated failure') },
    { name: 'matching string', failure: 'shutdown' },
    { name: 'matching object', failure: { source: 'shutdown' } },
  ])('does not relabel a $name operation rejection after the signal later aborts', async ({ failure }) => {
    const controller = new AbortController();
    const result = awaitWithTimeoutAndSignal(Promise.reject(failure), timeout, controller.signal).catch(
      (e: unknown) => e,
    );
    queueMicrotask(() => controller.abort(failure instanceof Error ? 'shutdown' : failure));
    expect(await result).toBe(failure);
    expect(isRequestCancellation(await result, controller.signal)).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('deadline ownership', () => {
  describe.each([-1, Number.NaN])('invalid timeout=%s', (timeout) => {
    it.each([
      'pre-aborted',
      'late failure',
      'no signal',
    ] as const)('keeps validation errors and observes losing rejection with %s', async (phase) => {
      vi.useFakeTimers();
      const operation = pDefer<void>();
      const controller = new AbortController();
      if (phase === 'pre-aborted') controller.abort('shutdown');
      const signal = phase === 'no signal' ? undefined : controller.signal;
      await expect(awaitWithTimeoutAndSignal(operation.promise, timeout, signal)).rejects.toBeInstanceOf(TypeError);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      operation.reject(new Error('failure after invalid timeout'));
      // Allow the losing operation and intermediate promise to settle completely.
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it('removes its listener on timeout even when the operation never settles', async () => {
    vi.useFakeTimers();
    const operation = pDefer<void>();
    const controller = new AbortController();
    const result = awaitWithTimeoutAndSignal(operation.promise, 20, controller.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBeInstanceOf(DeadlineError);
    expect(isRequestCancellation(await result, controller.signal)).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    operation.reject(new Error('rejection after deadline'));
    await Promise.resolve();
  });

  it('does not remap an Error reason that happens to be a deadline error', async () => {
    const reason = new DeadlineError('caller-owned timeout');
    const signal = AbortSignal.abort(reason);
    await expect(awaitWithTimeoutAndSignal(Promise.resolve('unused'), 100, signal)).rejects.toBe(reason);
  });
});

describe.each([0, 100])('correlation tracker timeout=%s', (timeout) => {
  it.each([
    { name: 'default', reason: undefined },
    { name: 'string', reason: 'shutdown' },
    { name: 'Error', reason: new Error('shutdown') },
    { name: 'object', reason: { owner: 'caller' } },
  ])('uses the shared $name cancellation representation and releases resources', async ({ reason }) => {
    vi.useFakeTimers();
    const tracker = new CorrelationTracker();
    const controller = new AbortController();
    const result = tracker.track('pending', timeout, controller.signal).catch((e: unknown) => e);
    controller.abort(reason);
    const error = await result;
    expect(isRequestCancellation(error, controller.signal)).toBe(true);
    if (controller.signal.reason instanceof Error) expect(error).toBe(controller.signal.reason);
    else expect(error instanceof BusAbortError && error.cause).toBe(controller.signal.reason);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    // A fresh correlation with the same ID cannot be affected by the cancelled entry.
    const next = tracker.track('pending', timeout);
    tracker.resolve('pending', 'replacement');
    await expect(next).resolves.toBe('replacement');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject', 'rejectAll', 'cleanup'] as const)('cleans up after %s', async (outcome) => {
    vi.useFakeTimers();
    const tracker = new CorrelationTracker();
    const controller = new AbortController();
    const result = tracker.track('pending', timeout, controller.signal).catch((e: unknown) => e);
    if (outcome === 'resolve') tracker.resolve('pending', 'done');
    if (outcome === 'reject') tracker.reject('pending', new Error('failed'));
    if (outcome === 'rejectAll') tracker.rejectAll(new Error('disconnected'));
    if (outcome === 'cleanup') tracker.cleanup();
    await result;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('correlation expiry remains a TimeoutError and removes its listener', async () => {
  vi.useFakeTimers();
  const tracker = new CorrelationTracker();
  const controller = new AbortController();
  const result = tracker.track('expired', 10, controller.signal).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toBeInstanceOf(TimeoutError);
  expect(isRequestCancellation(await result, controller.signal)).toBe(false);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
