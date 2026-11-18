import { describe, expect, it } from 'vitest';
import {
  abortableWait,
  boundedWait,
  boundedWaitReread,
  OUTER_BOUND_HEADROOM_MS,
  outerBoundMs,
} from '../bounded-wait.js';

/**
 * Settle after a delay.
 * @param ms - Delay in milliseconds.
 * @param value - Value to resolve with.
 * @returns Promise that resolves with `value`.
 */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('boundedWait', () => {
  it('returns the value of work that settles inside the window', async () => {
    await expect(boundedWait(after(10, 'done'), 1_000)).resolves.toEqual({ settled: true, value: 'done' });
  });

  it('reports that the window closed first and leaves the work running', async () => {
    let finished = false;
    const work = after(60, 'late').then((value) => {
      finished = true;
      return value;
    });

    await expect(boundedWait(work, 15)).resolves.toEqual({ settled: false });
    expect(finished).toBe(false);
    await work;
    expect(finished).toBe(true);
  });

  it('rejects with the rejection of work that fails inside the window', async () => {
    await expect(boundedWait(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom');
  });

  it('discards the rejection of work that fails after the window closed', async () => {
    const work = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('late failure')), 40));

    await expect(boundedWait(work, 10)).resolves.toEqual({ settled: false });
    // Waiting past the failure surfaces no unhandled rejection.
    await after(80, undefined);
  });
});

describe('abortableWait', () => {
  it('returns the value of work that settles before the signal aborts, and detaches its listener', async () => {
    const controller = new AbortController();

    await expect(abortableWait(after(10, 'done'), controller.signal)).resolves.toBe('done');
    // A late abort no longer touches the finished wait.
    controller.abort(new Error('late'));
  });

  it('rejects with the signal reason as soon as it aborts, while the work is still running', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');

    const wait = abortableWait(after(5_000, 'never'), controller.signal);
    controller.abort(reason);

    await expect(wait).rejects.toBe(reason);
  });

  it('rejects without waiting when the signal is already aborted', async () => {
    const reason = new Error('already');

    await expect(abortableWait(after(5_000, 'never'), AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  it('waits for the work alone without a signal', async () => {
    await expect(abortableWait(after(10, 'done'), undefined)).resolves.toBe('done');
  });
});

describe('outerBoundMs', () => {
  it('adds the scheduling headroom to what the wrapped bounds add up to', () => {
    expect(outerBoundMs(250)).toBe(250 + OUTER_BOUND_HEADROOM_MS);
  });
});

describe('boundedWaitReread', () => {
  it('returns the value of work that settles inside the first window', async () => {
    await expect(
      boundedWaitReread(
        () => after(5, 'done'),
        () => 1_000,
      ),
    ).resolves.toEqual({
      settled: true,
      value: 'done',
    });
  });

  it('reads the window before it starts the work', async () => {
    const order: string[] = [];
    await boundedWaitReread(
      async () => void order.push('work'),
      () => (order.push('window'), 100),
    );

    expect(order).toEqual(['window', 'work']);
  });

  it('ends at the window it started with when a second read finds no more', async () => {
    const outcome = await boundedWaitReread(
      () => after(500, 'late'),
      () => 20,
    );

    expect(outcome).toEqual({ settled: false, windowMs: 20 });
  });

  it('keeps waiting for the difference when the window has grown by the time it closes', async () => {
    let window = 20;
    const outcome = await boundedWaitReread(
      () => after(60, 'registered cleanup done'),
      () => {
        const current = window;
        window = 120;
        return current;
      },
    );

    expect(outcome).toEqual({ settled: true, value: 'registered cleanup done' });
  });

  it('reports the grown window when even that closes first', async () => {
    let reads = 0;
    const outcome = await boundedWaitReread(
      () => after(500, 'late'),
      () => (reads++ === 0 ? 15 : 40),
    );

    expect(outcome).toEqual({ settled: false, windowMs: 40 });
  });

  it('rejects with the rejection of work that fails after the window grew', async () => {
    let reads = 0;
    const work = () => new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('boom')), 40));

    await expect(boundedWaitReread(work, () => (reads++ === 0 ? 10 : 200))).rejects.toThrow('boom');
  });
});
