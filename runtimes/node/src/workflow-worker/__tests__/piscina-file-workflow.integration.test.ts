import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { createBusInstance } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import { expect, it, vi } from 'vitest';
import { computeDirectoryDigest } from '../local-directory-materializer.js';
import { createNodeWorkflowRunnerPackageOptions } from '../node-workflow-runner-factory.js';
import { makeWorkerConfig } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

it('dispatches caller-local file execution through the existing Piscina thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'makaio-piscina-file-'));
  const workspace = join(root, 'workspace');
  const workerEntry = join(root, 'worker.mjs');
  await mkdir(workspace);
  await writeFile(
    join(workspace, 'workflow.mjs'),
    `import { threadId } from 'node:worker_threads';
    if (threadId === ${threadId}) throw new Error('Workflow source was imported on the host thread');
    export const inWorker = true;`,
  );
  await writeFile(
    workerEntry,
    `import { pathToFileURL } from 'node:url';
    export default async ({ kind, config }) => ({
      executionId: config.executionId,
      workflowId: config.workflowId,
      status: 'completed',
      output: { kind, inWorker: (await import(pathToFileURL(config.source.path).href)).inWorker },
    });`,
  );
  const { callerLocalFileRunner, workflowRunner } = createNodeWorkflowRunnerPackageOptions({
    busUrl: 'ws://localhost/bus',
    runtimeModuleDir: '/app/src',
    platformDefaults: { cwd: workspace },
    workflowRunner: { mode: 'piscina', workerEntry, resolveWorkspaceRoot: async () => workspace },
    bus: createBusInstance(),
  });
  try {
    await expect(
      callerLocalFileRunner?.run(
        createTestCall(),
        makeWorkerConfig({
          source: { kind: 'path', path: 'workflow.mjs' },
          materializationSpec: {
            kind: 'local-directory',
            workspaceId: 'piscina-file-test',
            rootDigest: await computeDirectoryDigest(workspace),
            sourcePath: 'workflow.mjs',
          },
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      state: 'uncommitted',
      result: { status: 'completed', output: { kind: 'caller-local-file', inWorker: true } },
    });
  } finally {
    await workflowRunner?.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});
