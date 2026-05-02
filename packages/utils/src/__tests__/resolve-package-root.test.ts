import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePackageRoot } from '../resolve-package-root.js';

describe('resolvePackageRoot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a package root from a file import meta URL in Node', () => {
    const entryPath = path.join(path.sep, 'workspace', 'plugin-a', 'src', 'index.ts');
    const entryUrl = pathToFileURL(entryPath).href;

    expect(resolvePackageRoot({ url: entryUrl })).toBe(fileURLToPath(new URL('..', entryUrl)));
  });

  it('returns undefined outside Node file URLs', () => {
    vi.stubGlobal('window', {});

    expect(resolvePackageRoot({ url: 'file:///workspace/plugin-a/src/index.ts' })).toBeUndefined();
    expect(resolvePackageRoot({ url: 'https://example.test/plugin-a/index.js' })).toBeUndefined();
  });
});
