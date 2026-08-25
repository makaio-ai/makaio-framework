import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_EXECUTION_ABORT_REASONS } from '@makaio/contracts';
import { createEffectiveExecutionSignal, type EffectiveExecutionSignal } from '../execution-signal.js';

/** Largest delay `setTimeout` accepts before clamping; mirrors the module's cap. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

describe('createEffectiveExecutionSignal', () => {
  /** Signals created by the case under test, released after it finishes. */
  let created: EffectiveExecutionSignal[] = [];

  /**
   * Create a signal that the current case's teardown will release.
   * @param options - Arguments forwarded to the signal factory.
   * @returns The created effective execution signal.
   */
  function create(options: Parameters<typeof createEffectiveExecutionSignal>[0]): EffectiveExecutionSignal {
    const signal = createEffectiveExecutionSignal(options);
    created.push(signal);
    return signal;
  }

  beforeEach(() => {
    created = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    try {
      for (const signal of created) signal.release();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('effective deadline', () => {
    it('anchors the request budget at creation time', () => {
      const signal = create({ timeoutMs: 5_000 });
      expect(signal.context.deadlineEpochMs).toBe(Date.now() + 5_000);
    });

    it('lets an earlier inherited request deadline pull the budget in', () => {
      const signal = create({ timeoutMs: 5_000, requestDeadlineEpochMs: Date.now() + 1_000 });
      expect(signal.context.deadlineEpochMs).toBe(Date.now() + 1_000);
    });

    it('never lets a later inherited request deadline extend the budget', () => {
      const signal = create({ timeoutMs: 5_000, requestDeadlineEpochMs: Date.now() + 50_000 });
      expect(signal.context.deadlineEpochMs).toBe(Date.now() + 5_000);
    });

    it.each([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ])('ignores the non-finite inherited deadline %p', (requestDeadlineEpochMs) => {
      const signal = create({ timeoutMs: 5_000, requestDeadlineEpochMs });
      expect(signal.context.deadlineEpochMs).toBe(Date.now() + 5_000);
      expect(signal.abortReason).toBeUndefined();
    });

    // An inherited deadline may be ignored because the budget still bounds the
    // execution. An unusable budget has nothing to fall back on: `NaN` in
    // particular yields a deadline that never compares as elapsed, so the timer
    // would re-arm at the platform minimum for as long as the host lives.
    it.each([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
    ])('rejects the unusable budget %p instead of arming a timer that never settles', (timeoutMs) => {
      expect(() => create({ timeoutMs })).toThrow(TypeError);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('accepts an exhausted budget of zero and settles it as a timeout', async () => {
      const signal = create({ timeoutMs: 0 });

      expect(signal.abortReason).toBe('timeout');
      await expect(signal.aborted).resolves.toBe('timeout');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('settlement', () => {
    it('starts live, with an unaborted signal', () => {
      const signal = create({ timeoutMs: 1_000 });
      expect(signal.abortReason).toBeUndefined();
      expect(signal.context.signal.aborted).toBe(false);
    });

    it('aborts as a timeout once the effective deadline elapses', async () => {
      const signal = create({ timeoutMs: 1_000 });

      await vi.advanceTimersByTimeAsync(999);
      expect(signal.abortReason).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      expect(signal.abortReason).toBe('timeout');
      expect(signal.context.signal.aborted).toBe(true);
      await expect(signal.aborted).resolves.toBe('timeout');
    });

    it.each<['timeout' | 'cancellation', () => EffectiveExecutionSignal]>([
      [
        'timeout',
        () => {
          const signal = create({ timeoutMs: 1_000, requestDeadlineEpochMs: Date.now() - 1 });
          return signal;
        },
      ],
      [
        'cancellation',
        () => {
          const caller = new AbortController();
          const signal = create({ timeoutMs: 60_000, callerSignal: caller.signal });
          caller.abort(new Error('caller went away'));
          return signal;
        },
      ],
    ])('carries %p on the aborted signal so observers never re-derive it from a clock', (expected, settle) => {
      // Providers classify the abort from `signal.reason`. Comparing the
      // current time against the deadline would race the settlement, so the
      // reason has to be the classification itself, not a prose message.
      const signal = settle();

      expect(signal.abortReason).toBe(expected);
      expect(signal.context.signal.reason).toBe(expected);
      expect(CODE_EXECUTION_ABORT_REASONS).toContain(signal.context.signal.reason);
    });

    it('aborts as a timeout at an inherited deadline earlier than the budget', async () => {
      const signal = create({ timeoutMs: 60_000, requestDeadlineEpochMs: Date.now() + 100 });

      await vi.advanceTimersByTimeAsync(100);

      expect(signal.abortReason).toBe('timeout');
    });

    it('aborts as a cancellation when the caller signal fires', async () => {
      const caller = new AbortController();
      const signal = create({ timeoutMs: 60_000, callerSignal: caller.signal });

      caller.abort(new Error('caller went away'));

      expect(signal.abortReason).toBe('cancellation');
      expect(signal.context.signal.aborted).toBe(true);
      await expect(signal.aborted).resolves.toBe('cancellation');
    });

    it('settles immediately as a cancellation for an already aborted caller signal', async () => {
      const caller = new AbortController();
      caller.abort(new Error('cancelled before dispatch'));

      const signal = create({ timeoutMs: 60_000, callerSignal: caller.signal });

      expect(signal.abortReason).toBe('cancellation');
      await expect(signal.aborted).resolves.toBe('cancellation');
      // No deadline was armed: an execution that never started cannot time out.
      expect(vi.getTimerCount()).toBe(0);
    });

    it('settles immediately as a timeout when the inherited deadline has already passed', async () => {
      const signal = create({ timeoutMs: 60_000, requestDeadlineEpochMs: Date.now() - 1 });

      expect(signal.abortReason).toBe('timeout');
      await expect(signal.aborted).resolves.toBe('timeout');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('records only the first source, keeping cancellation over a later deadline', async () => {
      const caller = new AbortController();
      const signal = create({ timeoutMs: 1_000, callerSignal: caller.signal });

      caller.abort(new Error('caller went away'));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(signal.abortReason).toBe('cancellation');
      await expect(signal.aborted).resolves.toBe('cancellation');
    });

    it('does not fire early for a budget beyond the platform timer cap', async () => {
      const signal = create({ timeoutMs: MAX_TIMER_DELAY_MS + 10_000 });

      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
      expect(signal.abortReason).toBeUndefined();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(signal.abortReason).toBe('timeout');
    });
  });

  describe('release', () => {
    it('clears the deadline timer so a completed execution cannot time out later', async () => {
      const signal = create({ timeoutMs: 1_000 });

      signal.release();

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(signal.abortReason).toBeUndefined();
      expect(signal.context.signal.aborted).toBe(false);
    });

    it('detaches the caller listener so a later caller abort is not observed', () => {
      const caller = new AbortController();
      const signal = create({ timeoutMs: 60_000, callerSignal: caller.signal });

      signal.release();
      caller.abort(new Error('caller went away after completion'));

      expect(signal.abortReason).toBeUndefined();
      expect(signal.context.signal.aborted).toBe(false);
    });

    it('is idempotent across repeated calls, including after an abort', async () => {
      const signal = create({ timeoutMs: 1_000 });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(signal.abortReason).toBe('timeout');

      expect(() => {
        signal.release();
        signal.release();
      }).not.toThrow();
      expect(signal.abortReason).toBe('timeout');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer behind once an abort has settled', async () => {
      const caller = new AbortController();
      const signal = create({ timeoutMs: 60_000, callerSignal: caller.signal });
      expect(vi.getTimerCount()).toBe(1);

      caller.abort(new Error('caller went away'));

      expect(vi.getTimerCount()).toBe(0);
      expect(signal.abortReason).toBe('cancellation');
    });
  });
});
