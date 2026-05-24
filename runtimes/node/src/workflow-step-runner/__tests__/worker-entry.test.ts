import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
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
    stepId: 'entry-test-step',
    executionId: 'entry-test-exec',
    workflowId: 'entry-test-workflow',
    coordinatorSessionId: 'entry-test-session',
    stepType: 'shell',
    stepDefinition: {
      id: 'entry-test-step',
      type: 'shell',
      command,
    },
    resolvedInputs: {},
    busAuth: { kind: 'none' },
    platformDefaults: { cwd },
    cancelSubject: 'workflow.cancel.entry-test',
  };

  return {
    config,
    manifest: { packages: [] },
  };
}

describe('runStepInWorker', () => {
  it('executes a shell step and returns completed result', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-entry-')));
    const params = makeShellParams(['node', '-e', 'process.stdout.write("hello from worker")'], tempDir);

    const result = await runStepInWorker(params);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('hello from worker');
    expect(result.telemetry.duration).toBeGreaterThan(0);
  });

  it('returns failed result when shell command exits non-zero', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-entry-')));
    const params = makeShellParams(['node', '-e', 'process.exit(42)'], tempDir);

    const result = await runStepInWorker(params);

    expect(result.status).toBe('failed');
    expect(result.telemetry.duration).toBeGreaterThan(0);
  });

  it('respects abort signal for cancellation', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-entry-')));
    const params = makeShellParams(['node', '-e', 'setTimeout(() => {}, 60000)'], tempDir);
    const controller = new AbortController();

    const resultPromise = runStepInWorker({ ...params, signal: controller.signal });
    controller.abort();

    const result = await resultPromise;

    expect(result.status).toBe('failed');
  });

  it('closes bus even when step execution fails', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-entry-')));
    const params = makeShellParams(['node', '-e', 'process.exit(1)'], tempDir);

    // Should not throw - bus cleanup occurs in finally block
    const result = await runStepInWorker(params);

    expect(result.status).toBe('failed');
    expect(result.telemetry.duration).toBeGreaterThan(0);
  });

  it('uses cwd from platform defaults for shell step execution', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-entry-')));
    const params = makeShellParams(['node', '-e', 'process.stdout.write(process.cwd())'], tempDir);

    const result = await runStepInWorker(params);

    expect(result.status).toBe('completed');
    expect(resolve(result.output as string)).toBe(resolve(tempDir));
  });
});
