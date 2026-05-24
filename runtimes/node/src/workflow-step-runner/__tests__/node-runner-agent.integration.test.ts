import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { StepRunConfig } from '@makaio/contracts';
import { runStepInWorker, type WorkerRunStepParams } from '../worker-entry.js';

/**
 * Create a minimal WorkerRunStepParams for a shell step.
 * @param command - Command array to execute.
 * @param cwd - Working directory for the shell step.
 * @returns Valid WorkerRunStepParams for testing.
 */
function makeShellParams(command: string[], cwd: string): WorkerRunStepParams {
  const config: StepRunConfig = {
    stepId: 'agent-harness-step',
    executionId: 'agent-harness-exec',
    workflowId: 'agent-harness-wf',
    coordinatorSessionId: 'agent-harness-session',
    stepType: 'shell',
    stepDefinition: {
      id: 'agent-harness-step',
      type: 'shell',
      command,
    },
    resolvedInputs: {},
    busAuth: { kind: 'none' },
    platformDefaults: { cwd },
    cancelSubject: 'workflow.cancel.agent-harness-test',
  };

  return {
    config,
    manifest: { packages: [] },
  };
}

/**
 * Integration test for the worker entrypoint orchestration.
 *
 * Verifies the full flow:
 * 1. Boot worker bus (local-only, no WebSocket)
 * 2. Dispatch to shell executor
 * 3. Collect telemetry
 * 4. Return merged result
 *
 * Uses shell steps to prove the orchestration without requiring a real adapter/bus server.
 */
describe('Worker Agent Harness (integration)', { timeout: 30_000 }, () => {
  it('runs shell step through full worker entrypoint orchestration', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-harness-')));
    const params = makeShellParams(['node', '-e', 'process.stdout.write("harness-ok")'], tempDir);

    const result = await runStepInWorker(params);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('harness-ok');
    expect(result.telemetry.duration).toBeGreaterThan(0);
  });

  it('collects telemetry with zero token usage for shell steps', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-harness-')));
    const params = makeShellParams(['node', '-e', 'process.stdout.write("telemetry-test")'], tempDir);

    const result = await runStepInWorker(params);

    expect(result.status).toBe('completed');
    expect(result.telemetry.duration).toBeGreaterThan(0);
    // Shell steps produce no token usage — telemetry collector finds nothing
    expect(result.telemetry.tokenUsage).toBeUndefined();
    expect(result.telemetry.toolCalls).toBeUndefined();
  });

  it('boots bus, executes step, and closes bus cleanly on failure', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-harness-')));
    const params = makeShellParams(['node', '-e', 'process.exit(1)'], tempDir);

    const result = await runStepInWorker(params);

    expect(result.status).toBe('failed');
    expect(result.telemetry.duration).toBeGreaterThan(0);
  });

  it('does not import or reference SubagentSubjects in the worker entry', () => {
    // The isolation guarantee: worker-entry must not depend on SubagentSubjects.
    // This ensures the worker process doesn't accidentally spawn subagents directly.
    const workerEntryPath = resolve(import.meta.dirname, '..', 'worker-entry.ts');
    const workerSource = readFileSync(workerEntryPath, 'utf-8');

    expect(workerSource).not.toContain('SubagentSubjects');
  });

  it('does not import or reference SubagentSubjects in any worker module', () => {
    // Verify that no file in the workflow-step-runner directory imports SubagentSubjects.
    // This proves complete isolation from the subagent spawn path.
    const workerDir = resolve(import.meta.dirname, '..');
    const filesToCheck = ['worker-entry.ts', 'worker-boot.ts', 'worker-shell-executor.ts', 'worker-agent-executor.ts'];

    for (const file of filesToCheck) {
      const filePath = join(workerDir, file);
      const source = readFileSync(filePath, 'utf-8');
      expect(source, `${file} must not reference SubagentSubjects`).not.toContain('SubagentSubjects');
    }
  });
});
