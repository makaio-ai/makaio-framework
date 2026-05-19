import { describe, expect, it } from 'bun:test';
import { toRelativeImportPath } from './extension-path.js';

describe('toRelativeImportPath', () => {
  it('prefixes dot-prefixed filenames with ./ for valid ESM imports', () => {
    expect(toRelativeImportPath('/tmp/extensions', '/tmp/extensions/.hidden')).toBe('./.hidden');
  });

  it('preserves parent-relative imports', () => {
    expect(toRelativeImportPath('/tmp/extensions/generated', '/tmp/extensions/source/index.ts')).toBe(
      '../source/index.ts',
    );
  });
});
