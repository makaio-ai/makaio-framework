import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveShellCwd } from '../executor-helpers.js';
import type { ExpressionContext } from '@makaio/expression';

const symlinkTest = process.platform === 'win32' ? it.skip : it;

/**
 * Build a minimal expression context fixture for shell cwd resolution tests.
 * @returns ExpressionContext with empty trigger/steps/inputs maps
 */
function makeExpressionContext(): ExpressionContext {
  return {
    trigger: {},
    steps: {},
    inputs: {},
  };
}

describe('resolveShellCwd', () => {
  symlinkTest('rejects cwd that escapes workspace through a symlink', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'workflow-executor-helpers-'));
    const workspaceRoot = join(tempRoot, 'workspace');
    const outsideRoot = join(tempRoot, 'outside');

    try {
      mkdirSync(workspaceRoot);
      mkdirSync(outsideRoot);
      symlinkSync(outsideRoot, join(workspaceRoot, 'outside-link'), 'dir');

      const resolved = resolveShellCwd('outside-link', workspaceRoot, makeExpressionContext());

      expect(resolved).toBeNull();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves cwd within the workspace when path exists', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'workflow-executor-helpers-'));
    const workspaceRoot = join(tempRoot, 'workspace');
    const innerDir = join(workspaceRoot, 'inner');

    try {
      mkdirSync(workspaceRoot);
      mkdirSync(innerDir);

      const resolved = resolveShellCwd('inner', workspaceRoot, makeExpressionContext());

      expect(resolved).toBe(realpathSync(innerDir));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
