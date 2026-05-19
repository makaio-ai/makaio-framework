import { relative } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { CONFORMANCE_PATH, discoverConformanceTests } from '../lib/conformance/index.js';

function toConformanceRelative(files: string[]): string[] {
  return files.map((file) => relative(CONFORMANCE_PATH, file).replace(/\\/g, '/'));
}

describe('conformance discovery', () => {
  it('excludes matching test files after pattern expansion', async () => {
    const files = toConformanceRelative(
      await discoverConformanceTests(
        [],
        ['framework/adapters/implementations/__tests__/agents.simple.test.ts', 'orchestration/sendMessage.test.ts'],
      ),
    );

    expect(files.some((file) => file.endsWith('agents.simple.test.ts'))).toBe(false);
    expect(files.some((file) => file.endsWith('orchestration/sendMessage.test.ts'))).toBe(false);
    expect(files.some((file) => file.endsWith('agents.queue.test.ts'))).toBe(true);
  });

  it('normalizes Windows-style separators in include and exclude patterns', async () => {
    const included = toConformanceRelative(
      await discoverConformanceTests(['framework\\adapters\\implementations\\__tests__\\agents.simple.test.ts'], []),
    );
    expect(included.some((file) => file.endsWith('agents.simple.test.ts'))).toBe(true);

    const excluded = toConformanceRelative(
      await discoverConformanceTests(
        ['framework\\adapters\\implementations\\__tests__\\agents.simple.test.ts'],
        ['framework\\adapters\\implementations\\__tests__\\agents.simple.test.ts'],
      ),
    );

    expect(excluded.some((file) => file.endsWith('agents.simple.test.ts'))).toBe(false);
  });
});
