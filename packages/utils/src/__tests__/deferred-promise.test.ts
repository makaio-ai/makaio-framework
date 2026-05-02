import { describe, expect, it } from 'vitest';
import { DeferredPromise } from '../deferred-promise.js';

describe('DeferredPromise', () => {
  it('resolves with the provided value when getPromise was called first', async () => {
    const deferred = new DeferredPromise<string>();
    const promise = deferred.getPromise();

    deferred.resolve('hello');

    await expect(promise).resolves.toBe('hello');
  });

  it('rejects with the provided error when getPromise was called first', async () => {
    const deferred = new DeferredPromise<string>();
    const promise = deferred.getPromise();

    deferred.reject(new Error('boom'));

    await expect(promise).rejects.toThrow('boom');
  });

  it('is pending until resolve or reject is called', async () => {
    const deferred = new DeferredPromise<number>();
    const promise = deferred.getPromise();

    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // Yield to microtask queue - should still be pending
    await Promise.resolve();
    expect(settled).toBe(false);

    deferred.resolve(42);
    await promise;
    expect(settled).toBe(true);
  });

  it('silently discards reject when getPromise was never called', () => {
    const deferred = new DeferredPromise<string>();
    // Should not throw even though there is no listener
    expect(() => deferred.reject(new Error('unheard'))).not.toThrow();
  });

  it('silently discards reject after the promise is already resolved', async () => {
    const deferred = new DeferredPromise<string>();
    const promise = deferred.getPromise();

    deferred.resolve('first');
    // Once settled, subsequent resolve/reject calls are silently ignored.
    // Consumers observe the first settled value.
    await expect(promise).resolves.toBe('first');

    // A subsequent reject on a tracked-but-settled deferred should not throw
    expect(() => deferred.reject(new Error('too late'))).not.toThrow();
  });

  it('resolves with complex object types', async () => {
    const deferred = new DeferredPromise<{ id: number; label: string }>();
    const promise = deferred.getPromise();

    deferred.resolve({ id: 1, label: 'test' });

    await expect(promise).resolves.toEqual({ id: 1, label: 'test' });
  });
});
