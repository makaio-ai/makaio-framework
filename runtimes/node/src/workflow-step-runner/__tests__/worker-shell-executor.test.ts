import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ShellWorkflowStep, StepRunConfig } from '@makaio/contracts';
import { runWorkerShellStep } from '../worker-shell-executor.js';

/**
 * Create a minimal StepRunConfig for a shell step targeting the given cwd.
 * @param command - Command array to execute.
 * @param cwd - Working directory for the shell step.
 * @param overrides - Optional config fields for targeted shell behavior.
 * @returns A valid StepRunConfig for testing.
 */
function makeShellConfig(
  command: string[],
  cwd: string,
  overrides: {
    resolvedInputs?: StepRunConfig['resolvedInputs'];
    step?: Partial<ShellWorkflowStep>;
  } = {},
): StepRunConfig {
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
      ...overrides.step,
    },
    resolvedInputs: overrides.resolvedInputs ?? {},
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

  it('resolves command templates from resolved inputs', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-shell-')));
    const config = makeShellConfig(['node', '-e', 'process.stdout.write("hello {{ inputs.name }}")'], tempDir, {
      resolvedInputs: { inputs: { name: 'Ada' } },
    });
    const controller = new AbortController();

    const result = await runWorkerShellStep(config, controller.signal);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('hello Ada');
  });

  it('honors step cwd relative to platform defaults', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-shell-')));
    const nestedDir = join(tempDir, 'packages', 'worker');
    mkdirSync(nestedDir, { recursive: true });
    const config = makeShellConfig(['node', '-e', 'process.stdout.write(process.cwd())'], tempDir, {
      resolvedInputs: { inputs: { packageName: 'worker' } },
      step: { cwd: 'packages/{{ inputs.packageName }}' },
    });
    const controller = new AbortController();

    const result = await runWorkerShellStep(config, controller.signal);

    expect(result.status).toBe('completed');
    expect(resolve(result.output as string)).toBe(resolve(nestedDir));
  });

  it('rejects step cwd values that escape platform defaults', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-shell-')));
    const config = makeShellConfig(['node', '-e', 'process.stdout.write("should not run")'], tempDir, {
      step: { cwd: '..' },
    });
    const controller = new AbortController();

    const result = await runWorkerShellStep(config, controller.signal);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('outside workspace root');
  });

  it('resolves env templates from resolved inputs', async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-shell-')));
    const config = makeShellConfig(['node', '-e', 'process.stdout.write(process.env.WORKER_GREETING ?? "")'], tempDir, {
      resolvedInputs: { inputs: { greeting: 'hello from env' } },
      step: { env: { WORKER_GREETING: '{{ inputs.greeting }}' } },
    });
    const controller = new AbortController();

    const result = await runWorkerShellStep(config, controller.signal);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('hello from env');
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
