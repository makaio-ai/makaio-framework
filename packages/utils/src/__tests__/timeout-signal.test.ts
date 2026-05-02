import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTimeoutSignal } from '../timeout/signal.js';

describe('createTimeoutSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a signal that is not aborted before the timeout elapses', () => {
    const timeout = createTimeoutSignal(1_000);

    expect(timeout.signal.aborted).toBe(false);

    timeout.clear();
  });

  it('aborts the signal after the timeout elapses', () => {
    const timeout = createTimeoutSignal(1_000);

    vi.advanceTimersByTime(1_000);

    expect(timeout.signal.aborted).toBe(true);
  });

  it('does not abort the signal after clear() is called before the timeout', () => {
    const timeout = createTimeoutSignal(1_000);

    timeout.clear();
    vi.advanceTimersByTime(2_000);

    expect(timeout.signal.aborted).toBe(false);
  });

  it('calling clear() after the timer already fired does not throw', () => {
    const timeout = createTimeoutSignal(500);

    vi.advanceTimersByTime(500);
    expect(() => timeout.clear()).not.toThrow();
  });

  it('returns an AbortSignal instance', () => {
    const timeout = createTimeoutSignal(1_000);

    expect(timeout.signal).toBeInstanceOf(AbortSignal);

    timeout.clear();
  });

  it('exposes a clear function', () => {
    const timeout = createTimeoutSignal(1_000);

    expect(typeof timeout.clear).toBe('function');

    timeout.clear();
  });
});
