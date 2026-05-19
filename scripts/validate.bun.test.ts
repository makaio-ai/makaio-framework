import { describe, expect, it } from 'bun:test';
import { parseCliArgs } from './validate.js';

describe('parseCliArgs', () => {
  it('defaults to fix mode', () => {
    expect(parseCliArgs([]).flags.fix).toBe(true);
  });

  it('supports opting out of fixes explicitly', () => {
    expect(parseCliArgs(['--no-fix']).flags.fix).toBe(false);
  });

  it('enables validator caches by default', () => {
    expect(parseCliArgs([]).flags.cache).toBe(true);
  });

  it('supports opting out of validator caches explicitly', () => {
    expect(parseCliArgs(['--no-cache']).flags.cache).toBe(false);
  });

  it('lets the last cache flag win', () => {
    expect(parseCliArgs(['--no-cache', '--cache']).flags.cache).toBe(true);
    expect(parseCliArgs(['--cache', '--no-cache']).flags.cache).toBe(false);
  });

  it('accepts both profile syntaxes for valid values', () => {
    expect(parseCliArgs(['--profile', 'full-workspace']).profile).toBe('full-workspace');
    expect(parseCliArgs(['--profile=standalone']).profile).toBe('standalone');
  });

  it('accepts a single validation tool', () => {
    expect(parseCliArgs(['--tool', 'biome']).tools).toEqual(['biome']);
    expect(parseCliArgs(['--tool', 'typescript']).tools).toEqual(['typescript']);
    expect(parseCliArgs(['--tool=eslint']).tools).toEqual(['eslint']);
  });

  it('accepts comma-separated validation tools', () => {
    expect(parseCliArgs(['--tools', 'biome,stylelint']).tools).toEqual(['biome', 'stylelint']);
    expect(parseCliArgs(['--tools=eslint,typescript']).tools).toEqual(['eslint', 'typescript']);
  });

  it('fails fast for invalid profile values', () => {
    expect(() => parseCliArgs(['--profile', 'invalid'])).toThrow(
      'Invalid value for --profile. Use "standalone" or "full-workspace".',
    );
    expect(() => parseCliArgs(['--profile=invalid'])).toThrow(
      'Invalid value for --profile. Use "standalone" or "full-workspace".',
    );
  });

  it('fails fast for invalid tool values', () => {
    expect(() => parseCliArgs(['--tool', 'unknown'])).toThrow(
      'Invalid value for --tool. Use one of: biome, prettier, eslint, stylelint, typescript.',
    );
    expect(() => parseCliArgs(['--tools=eslint,unknown'])).toThrow(
      'Invalid value for --tool. Use one of: biome, prettier, eslint, stylelint, typescript.',
    );
  });
});
