import { describe, expect, it } from 'bun:test';
import { inferCategory, parseTestCategories, resolveShardForFile } from './vitest-categories.js';
import { isBunTestFile, isTestFile, removeTestRunnerAffix } from './test-runner-contract.js';

describe('parseTestCategories', () => {
  it('defaults to standard non-e2e categories', () => {
    expect([...parseTestCategories()]).toEqual(['unit', 'ui', 'integration']);
  });

  it('rejects unknown categories', () => {
    expect(() => parseTestCategories('unit,typo')).toThrow('Invalid MAKAIO_TEST_CATEGORIES value(s): typo');
  });

  it('rejects an empty category list', () => {
    expect(() => parseTestCategories('')).toThrow('Invalid MAKAIO_TEST_CATEGORIES value(s):');
  });
});

describe('resolveShardForFile', () => {
  it('uses longest-prefix matching', () => {
    expect(
      resolveShardForFile('framework/ui/src/button.test.ts', { framework: ['framework'], ui: ['framework/ui'] }),
    ).toBe('ui');
  });
});

describe('test runner suffixes', () => {
  it('recognizes Bun ownership while retaining generic legacy test-file routing', () => {
    expect(isBunTestFile('scripts/lib/example.bun.test.ts')).toBe(true);
    expect(isBunTestFile('scripts/lib/example.test.ts')).toBe(false);
    expect(isTestFile('scripts/lib/example.bun.test.ts')).toBe(true);
    expect(isTestFile('scripts/lib/example.spec.ts')).toBe(true);
  });

  it('classifies explicit runner suffixes by their underlying category', () => {
    expect(removeTestRunnerAffix('feature.integration.bun.test.ts')).toBe('feature.integration.test.ts');
    expect(inferCategory('feature.integration.bun.test.ts')).toBe('integration');
    expect(inferCategory('feature.vitest.test.tsx')).toBe('ui');
  });
});
