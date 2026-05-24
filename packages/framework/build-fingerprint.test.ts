import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFrameworkDistFresh, writeFrameworkDistBuildStamp } from './build-fingerprint.js';

const WORKSPACE_ROOT = resolve(import.meta.dirname, '..', '..');

describe('framework dist freshness', () => {
  it('rejects dist output without a build stamp', () => {
    withTempDist((distDir) => {
      writeFileSync(join(distDir, 'contracts/index.mjs'), 'export const FrameworkContractNamespaces = [];\n');

      expect(
        isFrameworkDistFresh({
          workspaceRoot: WORKSPACE_ROOT,
          distDir,
          requiredFiles: ['contracts/index.mjs'],
        }),
      ).toBe(false);
    });
  });

  it('accepts dist output with a current build stamp and required files', () => {
    withTempDist((distDir) => {
      writeFileSync(join(distDir, 'contracts/index.mjs'), 'export const FrameworkContractNamespaces = [];\n');
      writeFrameworkDistBuildStamp({ workspaceRoot: WORKSPACE_ROOT, distDir });

      expect(
        isFrameworkDistFresh({
          workspaceRoot: WORKSPACE_ROOT,
          distDir,
          requiredFiles: ['contracts/index.mjs'],
        }),
      ).toBe(true);
    });
  });

  it('rejects stamped dist output when a required runtime file is missing', () => {
    withTempDist((distDir) => {
      writeFrameworkDistBuildStamp({ workspaceRoot: WORKSPACE_ROOT, distDir });

      expect(
        isFrameworkDistFresh({
          workspaceRoot: WORKSPACE_ROOT,
          distDir,
          requiredFiles: ['contracts/index.mjs'],
        }),
      ).toBe(false);
    });
  });

  it('rejects stamped dist output when a required runtime file is a directory', () => {
    withTempDist((distDir) => {
      mkdirSync(join(distDir, 'contracts/index.mjs'), { recursive: true });
      writeFrameworkDistBuildStamp({ workspaceRoot: WORKSPACE_ROOT, distDir });

      expect(
        isFrameworkDistFresh({
          workspaceRoot: WORKSPACE_ROOT,
          distDir,
          requiredFiles: ['contracts/index.mjs'],
        }),
      ).toBe(false);
    });
  });

  it('accepts stamped dist output without git metadata', () => {
    withTempWorkspace((workspaceRoot) => {
      const distDir = join(workspaceRoot, 'packages/framework/dist');
      mkdirSync(join(distDir, 'contracts'), { recursive: true });
      writeFileSync(join(distDir, 'contracts/index.mjs'), 'export const FrameworkContractNamespaces = [];\n');

      writeFrameworkDistBuildStamp({ workspaceRoot, distDir });

      expect(
        isFrameworkDistFresh({
          workspaceRoot,
          distDir,
          requiredFiles: ['contracts/index.mjs'],
        }),
      ).toBe(true);
    });
  });

  it('rejects stamped dist output without git metadata after source input changes', () => {
    withTempWorkspace((workspaceRoot) => {
      const distDir = join(workspaceRoot, 'packages/framework/dist');
      mkdirSync(join(distDir, 'contracts'), { recursive: true });
      writeFileSync(join(distDir, 'contracts/index.mjs'), 'export const FrameworkContractNamespaces = [];\n');
      writeFrameworkDistBuildStamp({ workspaceRoot, distDir });

      writeFileSync(join(workspaceRoot, 'package.json'), '{"name":"changed"}\n');

      expect(
        isFrameworkDistFresh({
          workspaceRoot,
          distDir,
          requiredFiles: ['contracts/index.mjs'],
        }),
      ).toBe(false);
    });
  });
});

/**
 * Create and clean up a temporary framework dist directory.
 * @param run - Callback that receives the temporary dist directory.
 */
function withTempDist(run: (distDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'makaio-framework-dist-'));
  try {
    const distDir = join(root, 'dist');
    mkdirSync(join(distDir, 'contracts'), { recursive: true });
    run(distDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Create and clean up a temporary source workspace without git metadata.
 * @param run - Callback that receives the temporary workspace root.
 */
function withTempWorkspace(run: (workspaceRoot: string) => void): void {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'makaio-framework-workspace-'));
  try {
    writeFileSync(join(workspaceRoot, 'package.json'), '{"name":"fixture"}\n');
    run(workspaceRoot);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
