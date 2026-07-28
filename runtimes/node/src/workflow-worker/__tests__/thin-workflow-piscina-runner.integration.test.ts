import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { WorkerContributionManifest } from '@makaio/contracts';
import {
  BUILT_IN_THIN_WORKFLOW_PROVIDER_ID,
  PROVIDER_ALLOCATION_REF_VERSION,
  WorkerNodeNamespace,
} from '@makaio/contracts';
import { PiscinaThinWorkflowProvider } from '../piscina-thin-workflow-provider.js';
import { ThinWorkflowPiscinaRunner } from '../thin-workflow-piscina-runner.js';
import { computeContributionPackageDigest, computeDirectoryDigest } from '../local-directory-materializer.js';
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

/**
 * Create a local workspace with a workflow source and a verified extension
 * package. The worker entry returns its received task, proving the host
 * materialized it before Piscina imported the worker module.
 * @returns Workspace root, task-echo worker entry, and contribution manifest.
 */
async function createMaterializedWorkspace(): Promise<{
  readonly workspaceRoot: string;
  readonly workerEntry: string;
  readonly rootDigest: string;
  readonly manifest: WorkerContributionManifest;
}> {
  tempDir = await mkdtemp(join(tmpdir(), 'thin-workflow-piscina-materialization-'));
  const workspaceRoot = join(tempDir, 'external-workspace');
  const packageRoot = join(workspaceRoot, 'node_modules', 'example-worker-extension');
  await mkdir(join(workspaceRoot, 'workflows'), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'workflows', 'example.mjs'), 'export default {}\n');
  const contributionEntrypoint = join(packageRoot, 'worker.mjs');
  await writeFile(contributionEntrypoint, 'export default { name: "example-worker-extension", adapters: [] };\n');
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'example-worker-extension', version: '1.2.3', type: 'module' }),
  );
  const workerEntry = join(tempDir, 'worker-entry.mjs');
  await writeFile(
    workerEntry,
    [
      'export default async function run(task) {',
      '  return { executionId: task.config.executionId, workflowId: task.config.workflowId, status: "completed", task };',
      '}',
    ].join('\n'),
  );
  const integrity = await computeContributionPackageDigest(packageRoot, 'sha384');
  return {
    workspaceRoot,
    workerEntry,
    rootDigest: await computeDirectoryDigest(workspaceRoot),
    manifest: {
      contributionRefs: [
        {
          packageName: 'example-worker-extension',
          version: '1.2.3',
          entrypoint: 'worker.mjs',
          integrity,
        },
      ],
    },
  };
}

describe('ThinWorkflowPiscinaRunner integration', () => {
  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('runs a real Piscina worker with an explicit empty contribution identity set', async () => {
    const workerEntry = await createEchoWorkerEntry();
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry,
      manifest: { contributionRefs: [] },
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });
    const perCallManifest: WorkerContributionManifest = { contributionRefs: [] };

    try {
      const completion = await runner.run(makeWorkerConfig(), new AbortController().signal, perCallManifest);
      expect(completion).toMatchObject({
        state: 'uncommitted',
        result: {
          executionId: 'wfx-1',
          workflowId: 'workflow-1',
          status: 'completed',
        },
      });
    } finally {
      await runner.dispose();
    }
  });

  it('materializes an external local workspace and verified contribution before Piscina dispatch', async () => {
    const workspace = await createMaterializedWorkspace();
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry: workspace.workerEntry,
      manifest: workspace.manifest,
      resolveWorkspaceRoot: async (workspaceId) =>
        workspaceId === 'external-workspace' ? workspace.workspaceRoot : undefined,
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });
    const config = makeWorkerConfig({
      source: { kind: 'path', path: 'workflows/example.mjs' },
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'external-workspace',
        rootDigest: workspace.rootDigest,
        sourcePath: 'workflows/example.mjs',
      },
    });

    try {
      const completion = await runner.run(config, new AbortController().signal, workspace.manifest);
      expect(completion.result).toMatchObject({
        status: 'completed',
        task: {
          config: { source: { kind: 'path', path: join(workspace.workspaceRoot, 'workflows', 'example.mjs') } },
          contributionEntrypoints: [
            join(workspace.workspaceRoot, 'node_modules', 'example-worker-extension', 'worker.mjs'),
          ],
        },
      });
    } finally {
      await runner.dispose();
    }
  });

  it('provisions through the provider with a real thin Piscina runner', async () => {
    const workerEntry = await createEchoWorkerEntry();
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry,
      manifest: { contributionRefs: [] },
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNodeNamespace);
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-integration',
      displayName: 'Piscina Integration',
      runner,
      bus,
    });
    const perCallManifest: WorkerContributionManifest = { contributionRefs: [] };

    try {
      const { allocationRef, handle } = await provider.provision(
        {
          executionId: 'wfx-1',
          executionAttemptId: 'attempt-integration',
          environment: 'piscina',
          workerConfig: makeWorkerConfig(),
          workerManifest: perCallManifest,
        },
        new AbortController().signal,
      );

      expect(allocationRef.version).toBe(PROVIDER_ALLOCATION_REF_VERSION);
      expect(allocationRef.providerId).toBe(BUILT_IN_THIN_WORKFLOW_PROVIDER_ID);
      expect(allocationRef.providerData).toMatchObject({
        executionAttemptId: 'attempt-integration',
      });
      expect(handle.executionAttemptId).toBe('attempt-integration');
    } finally {
      await runner.dispose();
    }
  });

  it('does not create the Piscina pool before the first run', async () => {
    const runner = new ThinWorkflowPiscinaRunner({
      workerEntry: join(tmpdir(), 'missing-workflow-worker-entry.mjs'),
      manifest: { contributionRefs: [] },
      maxConcurrency: 1,
      idleTimeoutMs: 100,
    });

    await expect(runner.dispose()).resolves.toBeUndefined();
  });
});
