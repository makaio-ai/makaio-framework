import { describe, expect, it } from 'vitest';
import { parseTestCategories, resolveShardForFile } from './vitest-categories.js';

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
