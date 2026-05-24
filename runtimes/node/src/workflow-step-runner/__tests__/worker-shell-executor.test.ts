import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { StepRunConfig } from '@makaio/contracts';
import { runWorkerShellStep } from '../worker-shell-executor.js';

/**
 * Create a minimal StepRunConfig for a shell step targeting the given cwd.
 * @param command - Command array to execute.
 * @param cwd - Working directory for the shell step.
 * @returns A valid StepRunConfig for testing.
 */
function makeShellConfig(command: string[], cwd: string): StepRunConfig {
  return {
    stepId: 'test-step',
    executionId: 'test-exec',
    workflowId: 'test-workflow',
    coordinatorSessionId: 'test-session',
    stepType: 'shell',
    stepDefinition: {
      id: 'test-step',
      type: 'shell',
      command,
    },
    resolvedInputs: {},
    busAuth: { kind: 'none' },
    platformDefaults: { cwd },
    cancelSubject: 'workflow.cancel.test',
  };
}

describe('runWorkerShellStep', () => {
  it('runs a command in the platform default cwd and returns stdout', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-shell-')));
    const config = makeShellConfig(['node', '-e', 'process.stdout.write(process.cwd())'], tempDir);
    const controller = new AbortController();

    const result = await runWorkerShellStep(config, controller.signal);

    expect(result.status).toBe('completed');
    expect(resolve(result.output as string)).toBe(resolve(tempDir));
    expect(result.telemetry.duration).toBeGreaterThan(0);
  });

  it('returns failed result for non-shell step type', async () => {
    const config = makeShellConfig(['echo', 'hi'], '/tmp');
    // Override stepType to simulate misconfiguration
    const agentConfig = { ...config, stepType: 'agent' as const };
    const controller = new AbortController();

    const result = await runWorkerShellStep(agentConfig, controller.signal);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('agent');
    expect(result.telemetry.duration).toBe(0);
  });

  it('returns failed result when command exits with non-zero code', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-shell-')));
    const config = makeShellConfig(['node', '-e', 'process.exit(1)'], tempDir);
    const controller = new AbortController();

    const result = await runWorkerShellStep(config, controller.signal);

    expect(result.status).toBe('failed');
    expect(result.telemetry.duration).toBeGreaterThan(0);
  });

  it('respects abort signal for cancellation', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-shell-')));
    // Long-running command that will be cancelled
    const config = makeShellConfig(['node', '-e', 'setTimeout(() => {}, 60000)'], tempDir);
    const controller = new AbortController();

    // Abort shortly after starting
    const resultPromise = runWorkerShellStep(config, controller.signal);
    controller.abort();

    const result = await resultPromise;

    expect(result.status).toBe('failed');
    expect(result.telemetry.duration).toBeGreaterThanOrEqual(0);
  });
});
