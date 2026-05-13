import { describe, expect, it } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { FILE_ACCESS_RULES_KEY, type FileAccessRules } from '../../types.js';
import { getFileAccessRules } from '../file-access-rules.js';

/**
 * Helper to build a MakaioContext with the given constraint value.
 * @param value - Value to inject at the FILE_ACCESS_RULES_KEY constraint slot
 * @returns A MakaioContext with `constraints[FILE_ACCESS_RULES_KEY]` set to `value`
 */
function contextWith(value: unknown): ReturnType<typeof createMakaioContext> {
  return createMakaioContext({
    cwd: '/test',
    constraints: { [FILE_ACCESS_RULES_KEY]: value },
  });
}

describe('getFileAccessRules', () => {
  const denyAll: FileAccessRules['isDenied'] = () => true;
  const allowAll: FileAccessRules['isDenied'] = () => false;

  it('returns well-formed rules unchanged', () => {
    const rules: FileAccessRules = {
      allowedDirectories: ['/a', '/b'],
      isDenied: denyAll,
    };
    const result = getFileAccessRules(contextWith(rules));

    expect(result).toBeDefined();
    expect(result!.isDenied).toBe(denyAll);
    expect(result!.allowedDirectories).toEqual(['/a', '/b']);
  });

  it('returns rules when allowedDirectories is undefined (unrestricted)', () => {
    const rules: FileAccessRules = { isDenied: allowAll };
    const result = getFileAccessRules(contextWith(rules));

    expect(result).toBeDefined();
    expect(result!.isDenied).toBe(allowAll);
    expect(result!.allowedDirectories).toBeUndefined();
  });

  it('returns rules when allowedDirectories is an empty array (deny-all directories)', () => {
    const rules: FileAccessRules = {
      allowedDirectories: [],
      isDenied: allowAll,
    };
    const result = getFileAccessRules(contextWith(rules));

    expect(result).toBeDefined();
    expect(result!.allowedDirectories).toEqual([]);
    expect(result!.isDenied).toBe(allowAll);
  });

  it('sanitizes malformed allowedDirectories while preserving isDenied', () => {
    const rules = {
      allowedDirectories: [123, null, 'valid'],
      isDenied: denyAll,
    };
    const result = getFileAccessRules(contextWith(rules));

    expect(result).toBeDefined();
    expect(result!.isDenied).toBe(denyAll);
    // Malformed allowedDirectories stripped → treated as unrestricted
    expect(result!.allowedDirectories).toBeUndefined();
  });

  it('sanitizes non-array allowedDirectories while preserving isDenied', () => {
    const rules = {
      allowedDirectories: 'not-an-array',
      isDenied: allowAll,
    };
    const result = getFileAccessRules(contextWith(rules));

    expect(result).toBeDefined();
    expect(result!.isDenied).toBe(allowAll);
    expect(result!.allowedDirectories).toBeUndefined();
  });

  it('returns undefined when isDenied is missing', () => {
    const rules = { allowedDirectories: ['/a'] };
    const result = getFileAccessRules(contextWith(rules));
    expect(result).toBeUndefined();
  });

  it('returns undefined when isDenied is not a function', () => {
    const rules = { isDenied: 'not-a-function', allowedDirectories: ['/a'] };
    const result = getFileAccessRules(contextWith(rules));
    expect(result).toBeUndefined();
  });

  it('returns undefined for null constraint', () => {
    const result = getFileAccessRules(contextWith(null));
    expect(result).toBeUndefined();
  });

  it('returns undefined when constraint slot exists but value is undefined', () => {
    const result = getFileAccessRules(contextWith(undefined));
    expect(result).toBeUndefined();
  });

  it('returns undefined for primitive constraint', () => {
    const result = getFileAccessRules(contextWith(42));
    expect(result).toBeUndefined();
  });

  it('returns undefined when no constraints are set', () => {
    const ctx = createMakaioContext({ cwd: '/test' });
    const result = getFileAccessRules(ctx);
    expect(result).toBeUndefined();
  });
});
