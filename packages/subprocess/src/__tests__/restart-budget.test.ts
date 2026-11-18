import { describe, expect, it } from 'vitest';
import { createRestartBudget } from '../restart-budget.js';

/**
 * A clock the test moves by hand.
 * @returns The clock and a function that advances it.
 */
function manualClock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

describe('createRestartBudget', () => {
  it('doubles the delay for every restart in the window, up to the maximum', () => {
    const budget = createRestartBudget({ maxRestarts: 5, initialDelayMs: 100, maxDelayMs: 500 });

    expect([budget.claim(), budget.claim(), budget.claim(), budget.claim()]).toEqual([
      { kind: 'granted', delayMs: 100 },
      { kind: 'granted', delayMs: 200 },
      { kind: 'granted', delayMs: 400 },
      { kind: 'granted', delayMs: 500 },
    ]);
  });

  it('refuses restarts once the window holds the maximum, until the oldest left it', () => {
    const clock = manualClock();
    const budget = createRestartBudget({ maxRestarts: 2, windowMs: 1_000, initialDelayMs: 10 }, clock.now);

    expect(budget.claim()).toEqual({ kind: 'granted', delayMs: 10 });
    clock.advance(400);
    expect(budget.claim()).toEqual({ kind: 'granted', delayMs: 20 });
    expect(budget.claim()).toEqual({ kind: 'exhausted' });

    // The first restart leaves the window; the second still counts.
    clock.advance(600);
    expect(budget.claim()).toEqual({ kind: 'granted', delayMs: 20 });
    expect(budget.claim()).toEqual({ kind: 'exhausted' });

    // Both remaining restarts leave the window: the backoff starts over.
    clock.advance(1_000);
    expect(budget.claim()).toEqual({ kind: 'granted', delayMs: 10 });
  });

  it('refuses every restart with a maximum of zero', () => {
    expect(createRestartBudget({ maxRestarts: 0 }).claim()).toEqual({ kind: 'exhausted' });
  });

  it('applies the defaults: five restarts per minute, starting at 500 ms', () => {
    const budget = createRestartBudget();

    expect(budget.maxRestarts).toBe(5);
    expect(budget.windowMs).toBe(60_000);
    expect(budget.claim()).toEqual({ kind: 'granted', delayMs: 500 });
  });

  it('rejects invalid limits', () => {
    expect(() => createRestartBudget({ maxRestarts: -1 })).toThrow(RangeError);
    expect(() => createRestartBudget({ maxRestarts: 1.5 })).toThrow('maxRestarts must be an integer');
    expect(() => createRestartBudget({ windowMs: Number.NaN })).toThrow(RangeError);
    expect(() => createRestartBudget({ initialDelayMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
