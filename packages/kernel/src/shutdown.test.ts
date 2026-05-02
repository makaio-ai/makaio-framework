import { describe, expect, it, vi } from 'vitest';
import { createShutdownSequence } from './shutdown.js';

describe('createShutdownSequence', () => {
  it('runs steps in declaration order', async () => {
    const order: number[] = [];

    const shutdown = createShutdownSequence([
      () => {
        order.push(1);
      },
      () => {
        order.push(2);
      },
      () => {
        order.push(3);
      },
    ]);

    await shutdown();

    expect(order).toEqual([1, 2, 3]);
  });

  it('runs subsequent steps even when an earlier step throws', async () => {
    const executed: string[] = [];

    const shutdown = createShutdownSequence([
      () => {
        executed.push('step-1');
      },
      () => {
        executed.push('step-2');
        throw new Error('step 2 failed');
      },
      () => {
        executed.push('step-3');
      },
    ]);

    await expect(shutdown()).resolves.toBeUndefined();
    expect(executed).toEqual(['step-1', 'step-2', 'step-3']);
  });

  it('returns the same promise when called concurrently (idempotent)', async () => {
    let callCount = 0;

    const shutdown = createShutdownSequence([
      () => {
        callCount++;
      },
    ]);

    const first = shutdown();
    const second = shutdown();
    const third = shutdown();

    expect(first).toBe(second);
    expect(first).toBe(third);

    await first;

    // Steps execute exactly once regardless of concurrent calls
    expect(callCount).toBe(1);
  });

  it('returns the same promise on sequential calls after completion', async () => {
    const shutdown = createShutdownSequence([() => {}]);

    const first = shutdown();
    await first;

    const second = shutdown();

    expect(second).toBe(first);
  });

  it('supports async steps', async () => {
    const order: string[] = [];

    const shutdown = createShutdownSequence([
      async () => {
        await Promise.resolve();
        order.push('async-1');
      },
      async () => {
        await Promise.resolve();
        order.push('async-2');
      },
    ]);

    await shutdown();

    expect(order).toEqual(['async-1', 'async-2']);
  });

  it('supports mixed sync and async steps', async () => {
    const order: string[] = [];

    const shutdown = createShutdownSequence([
      () => {
        order.push('sync-1');
      },
      async () => {
        await Promise.resolve();
        order.push('async-2');
      },
      () => {
        order.push('sync-3');
      },
    ]);

    await shutdown();

    expect(order).toEqual(['sync-1', 'async-2', 'sync-3']);
  });

  it('resolves immediately with an empty steps array', async () => {
    const shutdown = createShutdownSequence([]);

    await expect(shutdown()).resolves.toBeUndefined();
  });

  it('logs a warning for each failing step without rethrowing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const error = new Error('cleanup failed');
    const shutdown = createShutdownSequence([
      () => {
        throw error;
      },
    ]);

    await shutdown();

    expect(warnSpy).toHaveBeenCalledWith('[shutdown]', error);
    warnSpy.mockRestore();
  });
});
