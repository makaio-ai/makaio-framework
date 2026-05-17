import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFrameworkDistBuildPlan } from '../src/build/prepare-framework-dist.js';

describe('resolveFrameworkDistBuildPlan', () => {
  it('uses the stable framework dist scripts from the prefixed workspace root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-prefixed-workspace-'));
    try {
      const packageRoot = path.join(root, 'framework/apps/electron');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(path.join(root, 'package.json'), '{}\n');
      mkdirSync(path.join(root, 'framework'), { recursive: true });
      writeFileSync(path.join(root, 'framework/package.json'), '{}\n');

      expect(resolveFrameworkDistBuildPlan(packageRoot)).toEqual({
        cwd: root,
        scripts: ['build:framework'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the stable framework dist scripts from the package root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-framework-'));
    try {
      const packageRoot = path.join(root, 'apps/electron');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(path.join(root, 'package.json'), '{}\n');

      expect(resolveFrameworkDistBuildPlan(packageRoot)).toEqual({
        cwd: root,
        scripts: ['build:framework'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
