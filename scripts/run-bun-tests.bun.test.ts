import { describe, expect, it } from 'bun:test';
import { relative } from 'node:path';
import { resolveBunTestFiles, splitBunTestArguments } from './run-bun-tests.js';

describe('Bun test runner', () => {
  it('discovers only explicit Bun-owned framework test files', async () => {
    const files = await resolveBunTestFiles([]);
    const relativeFiles = files.map((filePath) => relative(import.meta.dir, filePath));

    expect(relativeFiles).toContain('lib/vitest-categories.bun.test.ts');
    expect(relativeFiles).toContain('lib/ci-shard-coverage.bun.test.ts');
    expect(relativeFiles).not.toContain('lib/test-runner-contract.ts');
    expect(relativeFiles).toEqual([...relativeFiles].sort());
  });

  it('accepts checkout-relative Bun files and rejects a Vitest-owned path', async () => {
    await expect(resolveBunTestFiles(['framework/scripts/lib/vitest-categories.bun.test.ts'])).resolves.toHaveLength(1);
    await expect(resolveBunTestFiles(['scripts/lib/test-runner-integration.test.ts'])).rejects.toThrow(
      'Bun runner accepts only *.bun.test.ts(x) files',
    );
  });

  it('preserves Bun CLI options while selecting only test-file arguments', () => {
    expect(
      splitBunTestArguments(['--test-name-pattern', 'runner', 'framework/scripts/lib/vitest-categories.bun.test.ts']),
    ).toEqual({
      options: ['--test-name-pattern', 'runner'],
      files: ['framework/scripts/lib/vitest-categories.bun.test.ts'],
    });
  });

  it('supports Bun bail flags with and without a value', () => {
    expect(splitBunTestArguments(['--bail', 'framework/scripts/lib/vitest-categories.bun.test.ts'])).toEqual({
      options: ['--bail'],
      files: ['framework/scripts/lib/vitest-categories.bun.test.ts'],
    });
    expect(splitBunTestArguments(['--bail', '2', 'framework/scripts/lib/vitest-categories.bun.test.ts'])).toEqual({
      options: ['--bail', '2'],
      files: ['framework/scripts/lib/vitest-categories.bun.test.ts'],
    });
    expect(
      splitBunTestArguments(['--bail', '--retry', '2', 'framework/scripts/lib/vitest-categories.bun.test.ts']),
    ).toEqual({
      options: ['--bail', '--retry', '2'],
      files: ['framework/scripts/lib/vitest-categories.bun.test.ts'],
    });
  });

  it('preserves documented Bun option values', () => {
    expect(
      splitBunTestArguments([
        '--seed',
        '123456',
        '--preload',
        './setup.ts',
        'framework/scripts/lib/vitest-categories.bun.test.ts',
      ]),
    ).toEqual({
      options: ['--seed', '123456', '--preload', './setup.ts'],
      files: ['framework/scripts/lib/vitest-categories.bun.test.ts'],
    });
  });

  it('rejects positional Bun patterns so Vitest-owned tests cannot be rediscovered', () => {
    expect(() => splitBunTestArguments(['.'])).toThrow('only explicit *.bun.test.ts(x) files');
    expect(() => splitBunTestArguments(['scripts'])).toThrow('only explicit *.bun.test.ts(x) files');
  });

  it('normalizes checkout-relative Bun file paths', async () => {
    await expect(resolveBunTestFiles(['./framework/scripts/lib/vitest-categories.bun.test.ts'])).resolves.toHaveLength(
      1,
    );
  });
});
