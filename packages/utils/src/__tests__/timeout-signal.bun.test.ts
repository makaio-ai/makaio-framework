import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { createTimeoutSignal } from '../timeout/signal.js';

describe('createTimeoutSignal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns a signal that is not aborted before the timeout elapses', () => {
    const timeout = createTimeoutSignal(1_000);

    expect(timeout.signal.aborted).toBe(false);

    timeout.clear();
  });

  it('aborts the signal after the timeout elapses', () => {
    const timeout = createTimeoutSignal(1_000);

    jest.advanceTimersByTime(1_000);

    expect(timeout.signal.aborted).toBe(true);
  });

  it('does not abort the signal after clear() is called before the timeout', () => {
    const timeout = createTimeoutSignal(1_000);

    timeout.clear();
    jest.advanceTimersByTime(2_000);

    expect(timeout.signal.aborted).toBe(false);
  });

  it('calling clear() after the timer already fired does not throw', () => {
    const timeout = createTimeoutSignal(500);

    jest.advanceTimersByTime(500);
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
