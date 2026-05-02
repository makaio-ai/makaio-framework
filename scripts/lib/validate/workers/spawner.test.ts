import { describe, expect, it } from 'vitest';
import { getWorkerKillTarget, mergeNodeOptions, stripImportFlags } from './spawner.js';

describe('mergeNodeOptions', () => {
  it.each<{ input: string | undefined; minMB: number; expected: string; label: string }>([
    {
      label: 'adds a heap limit when none exists',
      input: undefined,
      minMB: 6144,
      expected: '--max-old-space-size=6144',
    },
    {
      label: 'preserves unrelated flags while adding the heap limit',
      input: '--trace-warnings',
      minMB: 6144,
      expected: '--trace-warnings --max-old-space-size=6144',
    },
    {
      label: 'keeps a larger caller-provided heap size',
      input: '--max-old-space-size=8192 --trace-warnings',
      minMB: 6144,
      expected: '--trace-warnings --max-old-space-size=8192',
    },
    {
      label: 'raises a smaller caller-provided heap size to the required minimum',
      input: '--trace-warnings --max-old-space-size=4096',
      minMB: 6144,
      expected: '--trace-warnings --max-old-space-size=6144',
    },
    {
      label: 'preserves quoted option values with spaces',
      input: '--require "./path with spaces/register.js"',
      minMB: 6144,
      expected: '--require "./path with spaces/register.js" --max-old-space-size=6144',
    },
    {
      label: 'normalizes the spaced heap flag form without duplicating it',
      input: '--trace-warnings --max-old-space-size 8192',
      minMB: 6144,
      expected: '--trace-warnings --max-old-space-size=8192',
    },
  ])('$label', ({ input, minMB, expected }) => {
    expect(mergeNodeOptions(input, minMB)).toBe(expected);
  });
});

describe('stripImportFlags', () => {
  it.each<{ input: string | undefined; expected: string | undefined; label: string }>([
    { label: 'returns undefined for undefined input', input: undefined, expected: undefined },
    { label: 'returns undefined for an import-only value', input: '--import tsx/esm', expected: undefined },
    {
      label: 'strips --import <value> pairs while preserving other flags',
      input: '--trace-warnings --import tsx/esm --max-old-space-size=4096',
      expected: '--trace-warnings --max-old-space-size=4096',
    },
    { label: 'strips --import=<value> form', input: '--import=tsx/esm --trace-warnings', expected: '--trace-warnings' },
    {
      label: 'passes through when no --import flags exist',
      input: '--trace-warnings --max-old-space-size=2048',
      expected: '--trace-warnings --max-old-space-size=2048',
    },
    {
      label: 'strips multiple --import flags',
      input: '--import a --import b --trace-warnings',
      expected: '--trace-warnings',
    },
    {
      label: 'strips mixed --import and --import= forms',
      input: '--import a --import=b --trace-warnings',
      expected: '--trace-warnings',
    },
    { label: 'returns the empty string unchanged', input: '', expected: '' },
  ])('$label', ({ input, expected }) => {
    if (expected === undefined) {
      expect(stripImportFlags(input)).toBeUndefined();
    } else {
      expect(stripImportFlags(input)).toBe(expected);
    }
  });
});

describe('getWorkerKillTarget', () => {
  it('targets the process group on POSIX so wrapper descendants are terminated', () => {
    expect(getWorkerKillTarget(123, 'linux')).toBe(-123);
    expect(getWorkerKillTarget(123, 'darwin')).toBe(-123);
  });

  it('targets the child process on Windows where negative process groups are unsupported', () => {
    expect(getWorkerKillTarget(123, 'win32')).toBe(123);
  });
});
