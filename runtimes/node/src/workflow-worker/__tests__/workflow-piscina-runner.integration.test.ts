import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerContributionManifest } from '@makaio/contracts';
import { WorkflowPiscinaRunner } from '../workflow-piscina-runner.js';
import { makeWorkerConfig } from './fixtures.js';

let tempDir: string | undefined;

/**
 * Create a temporary Piscina worker entry that echoes workflow task fields.
 * @returns Absolute path to the worker entry module.
 */
async function createEchoWorkerEntry(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'workflow-piscina-runner-'));
  const workerEntry = join(tempDir, 'worker-entry.mjs');
  await writeFile(
    workerEntry,
    [
      'export default async function run(task) {',
      '  return {',
      '    executionId: task.config.executionId,',
      '    workflowId: task.config.workflowId,',
      "    status: 'completed',",
      '    output: { packages: task.manifest.packages.map((pkg) => pkg.name) },',
      '  };',
      '}',
    ].join('\n'),
  );
  return workerEntry;
}

describe('WorkflowPiscinaRunner integration', () => {
  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('runs a real Piscina worker with the per-call manifest', async () => {
    const workerEntry = await createEchoWorkerEntry();
    const runner = new WorkflowPiscinaRunner({
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
        output: { packages: ['per-call-package'] },
      });
    } finally {
      await runner.dispose();
    }
  });
});
