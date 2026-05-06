import { describe, expect, it } from 'vitest';
import { parseCliOptions } from './pr-comment-options.js';

describe('parseCliOptions', () => {
  it('rejects flags passed as state-file values', () => {
    expect(() =>
      parseCliOptions(['--new', '--state-file', '--watch', 'https://github.com/makaio-ai/makaio-framework/pull/1']),
    ).toThrow('--state-file requires a file path.');
  });

  it('rejects single-dash flag-like tokens passed as state-file values', () => {
    expect(() =>
      parseCliOptions(['--new', '--state-file', '-watch', 'https://github.com/makaio-ai/makaio-framework/pull/1']),
    ).toThrow('--state-file requires a file path.');
  });

  it('rejects unknown flags instead of silently dropping them', () => {
    expect(() =>
      parseCliOptions(['--new', '--resovled', 'https://github.com/makaio-ai/makaio-framework/pull/1']),
    ).toThrow('Unknown option: --resovled');
  });
});
