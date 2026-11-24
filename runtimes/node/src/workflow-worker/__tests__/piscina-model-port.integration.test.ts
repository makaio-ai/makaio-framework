import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowAgentStepNode } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { expect, it, vi } from 'vitest';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { createNodeWorkflowRunnerPackageOptions } from '../node-workflow-runner-factory.js';
import { makeWorkerConfig } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

it.each([false, true])('runs an unbound Agent Step with a host model port: %s', async (withModel) => {
  const root = await mkdtemp(join(tmpdir(), 'makaio-piscina-model-'));
  const workerEntry = join(root, 'worker.mjs');
  let gatewayRequests = 0;
  const server = createServer((request, response) => {
    gatewayRequests += 1;
    if (request.headers.authorization !== 'Bearer local-test-token') {
      response.writeHead(401).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ text: JSON.stringify({ approved: true }) }));
  });
  const { workflowRunner } = createNodeWorkflowRunnerPackageOptions({
    busUrl: 'ws://localhost/bus',
    runtimeModuleDir: '/app/src',
    platformDefaults: { cwd: root },
    workflowRunner: { mode: 'piscina', workerEntry },
  });
  try {
    const port = await listenOnLoopback(server);
    await writeFile(
      workerEntry,
      `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
      register();
      const { createPiscinaWorker } = await import(${JSON.stringify(import.meta.resolve('@makaio/runtime-node/workflow-worker/worker-entry'))});
      const { WorkflowSubjects } = await import(${JSON.stringify(import.meta.resolve('@makaio/contracts'))});
      const { makeBusWithStorage } = await import(${JSON.stringify(new URL('./fixtures.ts', import.meta.url).href)});
      const connect = async () => {
        const [bus, cleanup] = makeBusWithStorage();
        const stop = bus.on(WorkflowSubjects.resolveRole, (ctx) => {
          ctx.setResult({ adapterName: 'text-model', model: 'role-selected-model' });
        });
        return {
          connection: { bus, async close() { stop(); cleanup(); } },
          ...(${withModel} ? { stepModel: {
            adapterName: 'text-model',
            ownerInstanceId: 'piscina-worker',
            target: { name: 'test-model', url: new URL('http://127.0.0.1:${port}') },
            credentialSource: { request: async () => ({ kind: 'issued', credential: 'local-test-token' }) },
          } } : {}),
        };
      };
      export default (task) => createPiscinaWorker(connect)(task);`,
    );
    const reviewStep: WorkflowAgentStepNode = {
      id: 'review',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review',
      completion: 'turn',
      outputSchema: { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' } } },
    };
    const config = makeWorkerConfig({
      definition: {
        id: 'workflow-1',
        scope: { type: 'global' },
        root: {
          id: 'root',
          type: 'sequence',
          nodes: [reviewStep],
        },
      },
    });
    await expect(workflowRunner?.run(createTestCall(), config, new AbortController().signal)).resolves.toMatchObject({
      state: 'uncommitted',
      result: withModel ? { status: 'completed' } : { status: 'failed', error: 'environmentMissing' },
    });
    expect(gatewayRequests).toBe(withModel ? 1 : 0);
  } finally {
    await workflowRunner?.dispose?.();
    await closeHttpServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
