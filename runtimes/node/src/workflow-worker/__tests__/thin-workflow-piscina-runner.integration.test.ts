import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerContributionManifest } from '@makaio/contracts';
import { PiscinaThinWorkflowProvider } from '../piscina-thin-workflow-provider.js';
import { ThinWorkflowPiscinaRunner } from '../thin-workflow-piscina-runner.js';
import { makeWorkerConfig } from './fixtures.js';

let tempDir: string | undefined;

/**
 * Create a temporary Piscina worker entry that echoes workflow task fields.
 * @returns Absolute path to the worker entry module.
 */
async function createEchoWorkerEntry(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'thin-workflow-piscina-runner-'));
  const workerEntry = join(tempDir, 'worker-entry.mjs');
  await writeFile(
    workerEntry,
    [
      'export default async function run(task) {',
      '  return {',
      '    executionId: task.config.executionId,',
      '    workflowId: task.config.workflowId,',
      "    status: 'completed',",
      '  };',
      '}',
    ].join('\n'),
  );
  return workerEntry;
}

describe('ThinWorkflowPiscinaRunner integration', () => {
  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('runs a real Piscina worker with the per-call manifest', async () => {
    const workerEntry = await createEchoWorkerEntry();
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry,
      manifest: { packages: [{ name: 'construction-package', importPath: 'file:///construction.mjs' }] },
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });
    const perCallManifest: WorkerContributionManifest = {
      packages: [{ name: 'per-call-package', importPath: 'file:///per-call.mjs' }],
    };

    try {
      await expect(
        runner.run(makeWorkerConfig(), new AbortController().signal, perCallManifest),
      ).resolves.toMatchObject({
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      });
    } finally {
      await runner.dispose();
    }
  });

  it('provisions through the provider with a real thin Piscina runner', async () => {
    const workerEntry = await createEchoWorkerEntry();
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry,
      manifest: { packages: [{ name: 'construction-package', importPath: 'file:///construction.mjs' }] },
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-integration',
      displayName: 'Piscina Integration',
      runner,
    });
    const perCallManifest: WorkerContributionManifest = {
      packages: [{ name: 'provider-package', importPath: 'file:///provider.mjs' }],
    };

    try {
      const handle = await provider.provision({
        nodeId: 'node-integration',
        executionId: 'wfx-1',
        environment: 'piscina',
        workerConfig: makeWorkerConfig(),
        workerManifest: perCallManifest,
      });

      await expect(handle.waitForResult(new AbortController().signal)).resolves.toMatchObject({
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      });
    } finally {
      await runner.dispose();
    }
  });

  it('does not create the Piscina pool before the first run', async () => {
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry: join(tmpdir(), 'missing-workflow-worker-entry.mjs'),
      manifest: { packages: [] },
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });

    await expect(runner.dispose()).resolves.toBeUndefined();
  });
});
