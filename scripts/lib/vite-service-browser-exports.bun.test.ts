import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { serviceBrowserExportsPlugin } from './vite-service-browser-exports.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'makaio-browser-exports-'));
  tempDirs.push(dir);
  return dir;
}

describe('serviceBrowserExportsPlugin', () => {
  it('redirects configured package subpaths to browser entries', () => {
    const sourceRoot = createTempDir();
    const browserEntry = path.join(sourceRoot, 'settings', 'index.browser.ts');
    mkdirSync(path.dirname(browserEntry), { recursive: true });
    writeFileSync(browserEntry, 'export {};');

    const plugin = serviceBrowserExportsPlugin({
      packages: [{ packageName: '@makaio/services', sourceRoots: [sourceRoot] }],
    });
    const resolveId = plugin.resolveId;

    if (typeof resolveId !== 'function') {
      throw new Error('Expected serviceBrowserExportsPlugin to expose a resolveId hook.');
    }

    expect(Reflect.apply(resolveId, undefined, ['@makaio/services/settings'])).toBe(browserEntry);
    expect(Reflect.apply(resolveId, undefined, ['@makaio/services/settings/internal'])).toBeNull();
    expect(Reflect.apply(resolveId, undefined, ['@makaio/other/settings'])).toBeNull();
  });
});
