import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeFrameworkBuildStages } from './build-staging.js';

describe('mergeFrameworkBuildStages', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps bus, core, and react outputs after the complete staged merge', () => {
    const root = mkdtempSync(join(tmpdir(), 'framework-build-stages-'));
    tempDirs.push(root);
    const stages = ['bus', 'core', 'react'].map((name) => {
      const stagePath = join(root, name);
      const entryPath = join(stagePath, name, 'index.mjs');
      mkdirSync(join(stagePath, name), { recursive: true });
      writeFileSync(entryPath, `export const group = '${name}';\n`);
      return { name, path: stagePath };
    });
    const destination = join(root, 'dist');

    mergeFrameworkBuildStages(stages, destination);

    for (const name of ['bus', 'core', 'react']) {
      expect(readFileSync(join(destination, name, 'index.mjs'), 'utf8')).toContain(`'${name}'`);
    }
  });
});
