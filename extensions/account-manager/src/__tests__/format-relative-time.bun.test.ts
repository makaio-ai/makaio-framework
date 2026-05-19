import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { formatRelativeTime } from '../utils/format-relative-time.js';

describe('formatRelativeTime', () => {
  const NOW = new Date('2026-04-18T12:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('clamps future timestamps to just now', () => {
    expect(formatRelativeTime(NOW.getTime() + 30_000)).toBe('just now');
  });

  it('falls back to unknown for invalid timestamps', () => {
    expect(formatRelativeTime(Number.NaN)).toBe('unknown');
    expect(formatRelativeTime(Number.POSITIVE_INFINITY)).toBe('unknown');
  });

  it('formats past timestamps by minute, hour, and day buckets', () => {
    expect(formatRelativeTime(NOW.getTime() - 30_000)).toBe('just now');
    expect(formatRelativeTime(NOW.getTime() - 5 * 60_000)).toBe('5m ago');
    expect(formatRelativeTime(NOW.getTime() - 2 * 3_600_000)).toBe('2h ago');
    expect(formatRelativeTime(NOW.getTime() - 3 * 86_400_000)).toBe('3d ago');
  });
});
