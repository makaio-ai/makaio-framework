import { describe, expect, it } from 'vitest';
import { formatDuration } from '../utils/format-duration.js';

describe('formatDuration', () => {
  it('falls back to 0m for non-finite input', () => {
    expect(formatDuration(Number.NaN)).toBe('0m');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0m');
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe('0m');
  });

  it('clamps zero and negative finite durations to 0m', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(-1)).toBe('0m');
    expect(formatDuration(-45 * 60_000)).toBe('0m');
  });

  it('formats finite durations as before', () => {
    expect(formatDuration(45 * 60_000)).toBe('45m');
    expect(formatDuration((3 * 60 + 12) * 60_000)).toBe('3h 12m');
    expect(formatDuration((2 * 24 * 60 + 5 * 60 + 3) * 60_000)).toBe('2d 5h 3m');
  });
});
