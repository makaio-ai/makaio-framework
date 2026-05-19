import { describe, expect, it, jest, beforeEach, afterEach } from 'bun:test';
import { waitFor, advanceTimersByTimeAsync } from '../async-helpers.js';

describe('waitFor', () => {
  it('resolves immediately when the callback succeeds', async () => {
    await waitFor(() => {
      expect(1 + 1).toBe(2);
    });
  });

  it('retries until the callback succeeds', async () => {
    let count = 0;
    await waitFor(
      () => {
        count++;
        if (count < 3) throw new Error('not yet');
      },
      { interval: 5, timeout: 500 },
    );
    expect(count).toBe(3);
  });

  it('rejects with the last error when timeout elapses', async () => {
    await expect(
      waitFor(
        () => {
          throw new Error('still failing');
        },
        { timeout: 50, interval: 10 },
      ),
    ).rejects.toThrow('still failing');
  });

  it('works with async callbacks', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 20);

    await waitFor(
      async () => {
        expect(ready).toBe(true);
      },
      { timeout: 500, interval: 5 },
    );
  });
});

describe('advanceTimersByTimeAsync', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('advances fake timers and flushes microtasks', async () => {
    let resolved = false;
    setTimeout(() => {
      Promise.resolve().then(() => {
        resolved = true;
      });
    }, 100);

    await advanceTimersByTimeAsync(100);
    expect(resolved).toBe(true);
  });

  it('fires chained promise continuations', async () => {
    const order: string[] = [];

    setTimeout(() => {
      Promise.resolve()
        .then(() => order.push('first'))
        .then(() => order.push('second'));
    }, 50);

    await advanceTimersByTimeAsync(50);
    expect(order).toEqual(['first', 'second']);
  });
});
