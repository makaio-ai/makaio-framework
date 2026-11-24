import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestCall } from '@makaio/test-utils';
import { expect, it } from 'vitest';
import { computeDirectoryDigest } from '../local-directory-materializer.js';
import { ThinWorkflowPiscinaRunner } from '../thin-workflow-piscina-runner.js';
import { makeWorkerConfig } from './fixtures.js';

it('starts managed processes in the verified workspace of a Piscina workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'makaio-piscina-workspace-'));
  const workspace = await realpath(root);
  const workerEntry = join(workspace, 'worker.mjs');
  const sourcePath = 'nested/workflow.mjs';
  const runner = new ThinWorkflowPiscinaRunner({
    workerEntry,
    manifest: { contributionRefs: [] },
    resolveWorkspaceRoot: async () => workspace,
  });
  try {
    await mkdir(join(workspace, 'nested'));
    await writeFile(
      join(workspace, sourcePath),
      `const definition = {
        id: 'workflow-1',
        scope: { type: 'global' },
        root: { id: 'root', type: 'sequence', nodes: [{ id: 'check-cwd', type: 'code-step' }] },
      };
      const runtimeHandlers = new Map([['check-cwd', async ({ launchProcess }) => {
        const launch = await launchProcess({
          program: process.execPath,
          args: ['-e', 'process.stdout.write(process.cwd())'],
          cwd: '.',
          stdin: 'none',
        });
        if (!launch.ok) throw new Error('Managed launch refused: ' + launch.code);
        const actual = await new Response(launch.handle.stdout).text();
        const result = await launch.handle.result;
        if (result.exitCode !== 0 || actual !== ${JSON.stringify(workspace)}) {
          throw new Error('Unexpected managed working directory: ' + actual);
        }
        return null;
      }]]);
      export default { definition, runtimeHandlers };`,
    );
    await writeFile(
      workerEntry,
      `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
      register();
      const { runWorkflowInWorker } = await import(${JSON.stringify(import.meta.resolve('@makaio/runtime-node/workflow-worker/worker-entry'))});
      const { makeBusWithStorage } = await import(${JSON.stringify(new URL('./fixtures.ts', import.meta.url).href)});
      export default (task) => runWorkflowInWorker(task, async () => {
        const [bus, cleanup] = makeBusWithStorage();
        return { connection: { bus, async close() { cleanup(); } } };
      });`,
    );
    const config = makeWorkerConfig({
      source: { kind: 'path', path: sourcePath },
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'piscina-workspace-test',
        rootDigest: await computeDirectoryDigest(workspace),
        sourcePath,
      },
    });

    const completion = await runner.run(createTestCall(), config, new AbortController().signal);
    expect(completion, JSON.stringify(completion)).toMatchObject({
      state: 'uncommitted',
      result: { status: 'completed' },
    });
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
