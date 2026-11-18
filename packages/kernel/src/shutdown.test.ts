import { describe, expect, it } from 'vitest';
import { createShutdownSequence, shutdownBudgetMs, type BoundedShutdownStep } from './shutdown.js';

/**
 * Build a stage.
 * @param run - What the stage does.
 * @param budgetMs - Window of the stage; generous by default, so only tests about windows see one close.
 * @param name - Name of the stage.
 * @returns The stage.
 */
function stage(run: () => Promise<void> | void, budgetMs = 5_000, name = 'stage'): BoundedShutdownStep {
  return { name, budgetMs: () => budgetMs, run };
}

/** Work that never settles. */
const never = (): Promise<void> => new Promise<void>(() => undefined);

describe('createShutdownSequence', () => {
  it('runs steps in declaration order', async () => {
    const order: number[] = [];

    const shutdown = createShutdownSequence([
      stage(() => {
        order.push(1);
      }),
      stage(() => {
        order.push(2);
      }),
      stage(() => {
        order.push(3);
      }),
    ]);

    await shutdown.run();

    expect(order).toEqual([1, 2, 3]);
  });

  it('runs subsequent steps even when an earlier step throws', async () => {
    const executed: string[] = [];
    const failure = new Error('step 2 failed');

    const shutdown = createShutdownSequence([
      stage(() => {
        executed.push('step-1');
      }),
      stage(() => {
        executed.push('step-2');
        throw failure;
      }),
      stage(() => {
        executed.push('step-3');
      }),
    ]);

    await expect(shutdown.run()).rejects.toBeInstanceOf(AggregateError);
    expect(executed).toEqual(['step-1', 'step-2', 'step-3']);
  });

  it('returns the same promise when called concurrently (idempotent)', async () => {
    let callCount = 0;

    const shutdown = createShutdownSequence([
      stage(() => {
        callCount++;
      }),
    ]);

    const first = shutdown.run();
    const second = shutdown.run();
    const third = shutdown.run();

    expect(first).toBe(second);
    expect(first).toBe(third);

    await first;

    // Steps execute exactly once regardless of concurrent calls
    expect(callCount).toBe(1);
  });

  it('joins a stage that calls run() again before it has returned, instead of starting a second sequence', async () => {
    const started: string[] = [];
    let nested: Promise<void> | undefined;
    const shutdown = createShutdownSequence([
      stage(() => {
        started.push('first');
        nested = shutdown.run();
      }),
      stage(() => void started.push('second')),
    ]);

    const outer = shutdown.run();
    await outer;

    expect(started).toEqual(['first', 'second']);
    expect(nested).toBe(outer);
  });

  it('returns the same promise on sequential calls after completion', async () => {
    const shutdown = createShutdownSequence([stage(() => {})]);

    const first = shutdown.run();
    await first;

    const second = shutdown.run();

    expect(second).toBe(first);
  });

  it('supports async steps', async () => {
    const order: string[] = [];

    const shutdown = createShutdownSequence([
      stage(async () => {
        await Promise.resolve();
        order.push('async-1');
      }),
      stage(async () => {
        await Promise.resolve();
        order.push('async-2');
      }),
    ]);

    await shutdown.run();

    expect(order).toEqual(['async-1', 'async-2']);
  });

  it('resolves immediately with an empty steps array', async () => {
    const shutdown = createShutdownSequence([]);

    await expect(shutdown.run()).resolves.toBeUndefined();
  });

  it('reports every failed step in one aggregate', async () => {
    const first = new Error('first cleanup failed');
    const second = new Error('second cleanup failed');

    const shutdown = createShutdownSequence([
      stage(() => {
        throw first;
      }),
      stage(() => {}),
      stage(() => {
        throw second;
      }),
    ]);

    const rejection = await shutdown.run().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([first, second]);
    expect((rejection as AggregateError).message).toBe('Shutdown completed with 2 of 3 steps failing');
  });

  it('rejects every caller of a failed sequence with the same aggregate', async () => {
    const shutdown = createShutdownSequence([
      stage(() => {
        throw new Error('cleanup failed');
      }),
    ]);

    const first = shutdown.run();
    const second = shutdown.run();
    const [firstError, secondError] = await Promise.all([
      first.catch((error: unknown) => error),
      second.catch((error: unknown) => error),
    ]);

    expect(firstError).toBeInstanceOf(AggregateError);
    expect(secondError).toBe(firstError);
  });

  it('names a step that does not settle inside its window and still runs the steps after it', async () => {
    const executed: string[] = [];

    const shutdown = createShutdownSequence([
      stage(never, 30, 'stuck'),
      stage(() => {
        executed.push('after');
      }),
    ]);

    const rejection = await shutdown.run().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(executed).toEqual(['after']);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors.map(String)).toEqual([
      'Error: Shutdown step "stuck" did not finish within 30 ms',
    ]);
  });

  it('gives every step a window of its own instead of one for the whole sequence', async () => {
    const shutdown = createShutdownSequence([
      stage(() => new Promise<void>((resolve) => setTimeout(resolve, 60)), 200),
      stage(() => new Promise<void>((resolve) => setTimeout(resolve, 60)), 200),
      stage(() => new Promise<void>((resolve) => setTimeout(resolve, 60)), 200),
    ]);

    await expect(shutdown.run()).resolves.toBeUndefined();
  });
});

describe('shutdownBudgetMs', () => {
  it('adds up the windows, read when asked for', () => {
    let late = 10;
    const steps = [stage(() => {}, 100), { name: 'late', budgetMs: () => late, run: () => {} }];

    expect(shutdownBudgetMs(steps)).toBe(110);
    late = 400;
    expect(shutdownBudgetMs(steps)).toBe(500);
    expect(createShutdownSequence(steps).budgetMs()).toBe(500);
  });
});
