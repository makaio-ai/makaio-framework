import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFullSubjectForSubjectDefinition } from '@makaio/bus-core';
import { WorkflowSubjects } from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import { createTestCall } from '@makaio/test-utils';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { computeDirectoryDigest } from '../local-directory-materializer.js';
import { ThinWorkflowPiscinaRunner } from '../thin-workflow-piscina-runner.js';
import { makeBusWithStorage, makeWorkerConfig } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

const HostRequests = createBusNamespace('workspace-request', {
  echo: { request: z.object({ message: z.string() }), response: z.object({ message: z.string() }) },
  fail: { request: z.object({}), response: z.object({}) },
});

it('routes caller-local file requests through the standard Piscina worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'makaio-piscina-host-request-'));
  const workerEntry = join(root, 'worker.mjs');
  const sourcePath = 'workflow.mjs';
  const executionId = 'host-request-run';
  const [bus, cleanup] = makeBusWithStorage();
  bus.registerNamespace(HostRequests);
  let echoCalls = 0;
  let roleCalls = 0;
  const offEcho = bus.on(HostRequests.subjects.echo, ({ payload, setResult }) => {
    echoCalls += 1;
    setResult({ message: payload.message });
  });
  const offRole = bus.on(WorkflowSubjects.resolveRole, ({ setResult }) => {
    roleCalls += 1;
    setResult({ adapterName: 'test' });
  });
  const offFailure = bus.on(HostRequests.subjects.fail, () => {
    throw new Error('Host-only diagnostic');
  });
  const server = createServer();
  const transport = new BusServerTransportProvider({ httpServer: server });
  const runner = new ThinWorkflowPiscinaRunner({
    workerEntry,
    manifest: { contributionRefs: [] },
    resolveWorkspaceRoot: async () => root,
  });
  try {
    const port = await listenOnLoopback(server);
    await transport.connect(bus, 'workspace-request-test');
    await writeFile(
      workerEntry,
      `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
      register();
      const { default: handler } = await import(${JSON.stringify(import.meta.resolve('@makaio/runtime-node/workflow-worker/worker-entry'))});
      export default handler;`,
    );
    const echo = getFullSubjectForSubjectDefinition(HostRequests.subjects.echo);
    const role = getFullSubjectForSubjectDefinition(WorkflowSubjects.resolveRole);
    await writeFile(
      join(root, sourcePath),
      `const definition = {
        id: 'host-request-file',
        scope: { type: 'global' },
        root: { id: 'root', type: 'sequence', nodes: [{ id: 'request', type: 'code-step' }] },
      };
      const runtimeHandlers = new Map([['request', async ({ request }) => {
        const echo = await request({ subject: ${JSON.stringify(echo)}, payload: { message: 'hello' } });
        const missing = await request({ subject: 'workspace-request.missing', payload: {} });
        const failed = await request({ subject: 'workspace-request.fail', payload: {} });
        const invalid = await request({ subject: ${JSON.stringify(role)}, payload: { roleId: 42 } });
        if (!echo.ok || echo.response?.message !== 'hello' || missing.ok || missing.code !== 'request-not-granted'
          || invalid.ok || invalid.code !== 'request-rejected'
          || failed.ok || failed.code !== 'request-failed' || failed.detail !== 'Host request failed') {
          throw new Error(JSON.stringify({ echo, missing, invalid, failed }));
        }
        return null;
      }]]);
      export default { definition, runtimeHandlers };`,
    );
    const config = makeWorkerConfig({
      executionId,
      workflowId: executionId,
      source: { kind: 'path', path: sourcePath },
      busUrl: `ws://127.0.0.1:${port}/bus`,
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'host-request-workspace',
        rootDigest: await computeDirectoryDigest(root),
        sourcePath,
      },
    });

    const completion = await runner.callerLocalFileRunner.run(createTestCall(), config, new AbortController().signal);
    expect(completion, JSON.stringify(completion)).toMatchObject({
      state: 'uncommitted',
      result: { status: 'completed' },
    });
    expect(echoCalls).toBe(1);
    expect(roleCalls).toBe(0);
  } finally {
    await runner.dispose();
    await transport.disconnect();
    if (server.listening) await closeHttpServer(server);
    offRole();
    offFailure();
    offEcho();
    cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
