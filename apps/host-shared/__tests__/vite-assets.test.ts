import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveSharedRendererAssetPath,
  sharedRendererAliases,
  sharedRendererRoot,
} from '../src/renderer/vite-assets.js';

describe('sharedRendererRoot', () => {
  it('points to an existing directory', () => {
    expect(existsSync(sharedRendererRoot)).toBe(true);
    expect(statSync(sharedRendererRoot).isDirectory()).toBe(true);
  });
});

describe('resolveSharedRendererAssetPath', () => {
  it('resolves main.scss to an existing file', () => {
    const resolved = resolveSharedRendererAssetPath('main.scss');
    expect(existsSync(resolved)).toBe(true);
  });
});

describe('sharedRendererAliases', () => {
  it.each(
    Object.entries(sharedRendererAliases),
  )('alias %s points to an existing file on disk', (_alias, targetPath) => {
    expect(existsSync(targetPath)).toBe(true);
  });
});
