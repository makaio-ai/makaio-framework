import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'bun:test';
import { resolvePackageRoot } from '../resolve-package-root.js';

describe('resolvePackageRoot', () => {
  let originalWindow: unknown;

  afterEach(() => {
    if (originalWindow === undefined) {
      // @ts-expect-error — restoring absence of window on globalThis
      delete globalThis.window;
    } else {
      // @ts-expect-error — restoring window on globalThis
      globalThis.window = originalWindow;
    }
    originalWindow = undefined;
  });

  it('resolves a package root from a file import meta URL in Node', () => {
    const entryPath = path.join(path.sep, 'workspace', 'plugin-a', 'src', 'index.ts');
    const entryUrl = pathToFileURL(entryPath).href;

    expect(resolvePackageRoot({ url: entryUrl })).toBe(fileURLToPath(new URL('..', entryUrl)));
  });

  it('returns undefined outside Node file URLs', () => {
    originalWindow = globalThis.window;
    // @ts-expect-error — stubbing window on globalThis
    globalThis.window = {};

    expect(resolvePackageRoot({ url: 'file:///workspace/plugin-a/src/index.ts' })).toBeUndefined();
    expect(resolvePackageRoot({ url: 'https://example.test/plugin-a/index.js' })).toBeUndefined();
  });
});
