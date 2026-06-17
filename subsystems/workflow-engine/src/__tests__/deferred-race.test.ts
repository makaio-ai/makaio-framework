import { describe, expect, it, vi } from 'vitest';
import { buildDeferred } from '../runtime/deferred.js';
import { raceDeferredResponse } from '../runtime/deferred-race.js';

describe('raceDeferredResponse', () => {
  it('resolves with the deferred value', async () => {
    const deferred = buildDeferred<string>();
    const pending = { value: true };
    const signal = new AbortController().signal;
    const resultPromise = raceDeferredResponse(deferred, pending, signal, null);

    pending.value = false;
    deferred.resolve('accepted');

    await expect(resultPromise).resolves.toEqual({ status: 'resolved', value: 'accepted' });
  });

  it('returns cancelled when the abort signal fires', async () => {
    const deferred = buildDeferred<string>();
    const pending = { value: true };
    const controller = new AbortController();
    const resultPromise = raceDeferredResponse(deferred, pending, controller.signal, null);

    controller.abort();

    await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
  });

  it('returns timed-out when the timeout expires first', async () => {
    vi.useFakeTimers();
    try {
      const deferred = buildDeferred<string>();
      const pending = { value: true };
      const signal = new AbortController().signal;
      const resultPromise = raceDeferredResponse(deferred, pending, signal, 1000);

      await vi.advanceTimersByTimeAsync(1001);

      await expect(resultPromise).resolves.toEqual({ status: 'timed-out' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates unexpected deferred rejections', async () => {
    const deferred = buildDeferred<string>();
    const pending = { value: true };
    const signal = new AbortController().signal;
    const resultPromise = raceDeferredResponse(deferred, pending, signal, null);

    deferred.reject('unexpected');

    await expect(resultPromise).rejects.toBe('unexpected');
  });
});
