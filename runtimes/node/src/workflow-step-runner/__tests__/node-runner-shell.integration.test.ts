import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { StepRunConfig } from '@makaio/contracts';
import { ChildProcessStepRunner } from '../child-process-step-runner.js';
import { resolveWorkerEntry } from '../worker-entry-resolver.js';

/**
 * Integration test for the ChildProcessStepRunner with a real worker process.
 *
 * Verifies that:
 * 1. A real child process is spawned with the worker entrypoint
 * 2. The JSONL protocol (send config → ready signal → result) works end-to-end
 * 3. The shell step respects the configured working directory
 */
describe('ChildProcessStepRunner (integration)', { timeout: 30_000 }, () => {
  const packageRoot = resolve(import.meta.dirname, '..', '..', '..');
  const workerEntry = resolveWorkerEntry({ packageRoot, mode: 'source' });

  let tempDir: string;

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('runs a shell step in a real child process and returns the correct cwd', async () => {
    tempDir = realpathSync(await mkdtemp(join(tmpdir(), 'runner-shell-integration-')));

    const runner = new ChildProcessStepRunner({
      mode: 'child-process',
      workerEntry,
      cwd: packageRoot,
      manifest: { packages: [] },
    });

    const config: StepRunConfig = {
      stepId: 'integration-step',
      executionId: 'integration-exec',
      workflowId: 'integration-wf',
      coordinatorSessionId: 'integration-session',
      stepType: 'shell',
      stepDefinition: {
        id: 'integration-step',
        type: 'shell',
        command: ['node', '-e', 'process.stdout.write(process.cwd())'],
      },
      resolvedInputs: {},
      busAuth: { kind: 'none' },
      platformDefaults: { cwd: tempDir },
      cancelSubject: 'workflow.cancel.integration-test',
    };

    const controller = new AbortController();
    const result = await runner.run(config, controller.signal);

    expect(result.status).toBe('completed');
    expect(resolve(result.output as string)).toBe(resolve(tempDir));
    expect(result.telemetry.duration).toBeGreaterThan(0);
  });
});
