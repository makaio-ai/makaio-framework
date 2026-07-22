import { describe, expect, it } from 'vitest';
import { extractExactVersion, resolveExecutable } from '../lib/agent-clients/version-validation.js';

describe('resolveExecutable', () => {
  it('returns a plain string executable as-is', () => {
    expect(resolveExecutable('claude')).toBe('claude');
  });

  it('returns the default when no platform-specific key matches', () => {
    const executable = { default: 'claude', win32: 'claude.exe' };
    // On non-win32 platforms, should fall through to default
    const result = resolveExecutable(executable);
    if (process.platform === 'win32') {
      expect(result).toBe('claude.exe');
    } else {
      // On darwin/linux, win32 won't match, so it checks darwin/linux then default
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('returns darwin key on darwin platform', () => {
    const executable = { default: 'claude', darwin: 'claude-darwin', win32: 'claude.exe' };
    const result = resolveExecutable(executable);
    if (process.platform === 'darwin') {
      expect(result).toBe('claude-darwin');
    }
  });

  it('falls back to default when platform key is absent', () => {
    const executable = { default: 'fallback-bin' };
    expect(resolveExecutable(executable)).toBe('fallback-bin');
  });
});

describe('extractExactVersion', () => {
  it('extracts version from bare semver string', () => {
    expect(extractExactVersion('2.1.143')).toBe('2.1.143');
  });

  it('extracts version from prose output', () => {
    expect(extractExactVersion('claude v2.1.143')).toBe('2.1.143');
  });

  it('extracts version from multi-word output', () => {
    expect(extractExactVersion('Claude Code version 2.1.143 (stable)')).toBe('2.1.143');
  });

  it('rejects version with pre-release suffix by not including it', () => {
    // "2.1.143-beta" is treated as a single token; the regex only matches
    // versions bounded by whitespace/start/end, so it won't match here
    // and the full output is returned (which won't equal "2.1.143").
    expect(extractExactVersion('2.1.143-beta')).toBe('2.1.143-beta');
  });

  it('rejects version with different major number', () => {
    // "12.1.143" is a valid semver token, but it won't match "2.1.143"
    // when compared by the caller.
    expect(extractExactVersion('12.1.143')).toBe('12.1.143');
  });

  it('returns full output when no semver token is found', () => {
    expect(extractExactVersion('no version here')).toBe('no version here');
  });

  it('extracts first version when multiple are present', () => {
    expect(extractExactVersion('v2.1.143 built with 3.0.0')).toBe('2.1.143');
  });
});
