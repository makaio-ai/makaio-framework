import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveShellCwd, runShellStep } from '../executor-helpers.js';
import type { WorkflowExpressionContext } from '@makaio/expression';

const symlinkTest = process.platform === 'win32' ? it.skip : it;

/**
 * Build a minimal expression context fixture for shell cwd resolution tests.
 * @returns WorkflowExpressionContext with empty trigger/steps/inputs maps
 */
function makeExpressionContext(): WorkflowExpressionContext {
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

describe('runShellStep', () => {
  it('fails before spawning when the command array is empty', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'workflow-executor-helpers-'));

    try {
      const outcome = await runShellStep({
        step: { command: [] },
        workspaceRoot: tempRoot,
        expressionContext: makeExpressionContext(),
      });

      expect(outcome).toEqual({ status: 'failed', error: 'Shell step command is empty' });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails before spawning when template resolution clears the executable', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'workflow-executor-helpers-'));

    try {
      const outcome = await runShellStep({
        step: { command: ['{{ inputs.missingBinary }}'] },
        workspaceRoot: tempRoot,
        expressionContext: makeExpressionContext(),
      });

      expect(outcome).toEqual({ status: 'failed', error: 'Shell step command is empty' });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
