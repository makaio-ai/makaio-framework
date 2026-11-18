import { describe, expect, it } from 'vitest';
import { createReverseShutdownRunner } from '../reverse-shutdown-runner.js';

describe('createReverseShutdownRunner', () => {
  it('runs the steps newest first, once, for every caller', async () => {
    const order: string[] = [];
    const shutdown = createReverseShutdownRunner([() => void order.push('first'), () => void order.push('second')]);

    await Promise.all([shutdown(), shutdown()]);
    await shutdown();

    expect(order).toEqual(['second', 'first']);
  });

  it('joins the run when the step that starts it calls the runner again', async () => {
    const order: string[] = [];
    let nested: Promise<void> | undefined;
    const shutdown = createReverseShutdownRunner([
      () => void order.push('first'),
      // Runs first, in the synchronous prefix of the run, before any await.
      () => {
        order.push('second');
        nested = shutdown();
      },
    ]);

    const outer = shutdown();
    await outer;

    expect(nested).toBe(outer);
    expect(order).toEqual(['second', 'first']);
  });

  it('reports a failing step after the remaining steps ran', async () => {
    const order: string[] = [];
    const failure = new Error('step failed');
    const shutdown = createReverseShutdownRunner([
      () => void order.push('first'),
      () => {
        throw failure;
      },
    ]);

    await expect(shutdown()).rejects.toBe(failure);
    expect(order).toEqual(['first']);
  });
});
