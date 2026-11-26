import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowDefinition } from '@makaio/contracts';
import { WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { expect, it } from 'vitest';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import type { AdmittedFixedWorkflowSource } from '../fixed-operation-workflow.js';
import {
  cloneFixtureCheckout,
  commitFixture,
  composeFixedOperationHost,
  git,
  makeFixedOperationExtension,
  runPorts,
  verifyFixtureCheckout,
} from './fixed-operation-host.fixture.js';
import { makeWorkerConfig } from './fixtures.js';

const extension = 'checkout-tools';
const definition: WorkflowDefinition = {
  id: 'workflow-1',
  scope: { type: 'global' },
  extensions: { [extension]: true },
  root: {
    id: 'root',
    type: 'sequence',
    nodes: [
      { id: 'first', type: 'code-step' },
      { id: 'next', type: 'code-step' },
    ],
  },
};

/**
 * Pin a local workflow whose first child records when it reaches its return point.
 * @param root - Fixture root, outside the private run workspace.
 * @param port - Loopback barrier port.
 * @returns The admitted source used by the real worker.
 */
async function prepareSource(root: string, port: number): Promise<AdmittedFixedWorkflowSource> {
  const original = join(root, 'original');
  await mkdir(original);
  const checkoutId = await realpath(original);
  const path = 'flow.mjs';
  await writeFile(
    join(checkoutId, path),
    `import { appendFile } from 'node:fs/promises';
    export default {
      definition: ${JSON.stringify(definition)},
      runtimeHandlers: new Map([
        ['first', async () => {
          const response = await fetch('http://127.0.0.1:${port}');
          const output = await response.text();
          await appendFile(${JSON.stringify(join(root, 'effects'))}, output);
          return output;
        }],
        ['next', async () => {
          await appendFile(${JSON.stringify(join(root, 'effects'))}, ${JSON.stringify('next\n')});
          return null;
        }],
      ]),
    };`,
  );
  await git(checkoutId, 'init', '--quiet');
  await git(checkoutId, 'add', path);
  return {
    extension,
    declaration: true,
    block: null,
    path,
    revision: await commitFixture(checkoutId),
    checkoutId,
    verify: verifyFixtureCheckout,
  };
}

it('lets a launched step finish but discards its result when the admitted owner stops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-step-retirement-'));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = createServer(async (_request, response) => {
    started.resolve();
    await release.promise;
    response.end('first returned\n');
  });
  const workspace = join(root, 'runs');
  const stop = new AbortController();
  const { host, bus, coordinator, close } = composeFixedOperationHost(
    [
      makeFixedOperationExtension(extension, [
        {
          name: `${extension}.source`,
          phase: 'workflow-source',
          applies: () => true,
          run: (ctx) => cloneFixtureCheckout(ctx, join(root, 'original')),
        },
      ]),
    ],
    workspace,
  );
  const stepFrames: string[] = [];
  const offFrame = bus.on(
    WorkflowStorageSubjects.setFrame,
    async (ctx) => {
      const { nodeId, status } = ctx.payload.frame;
      if (nodeId === 'first' || nodeId === 'next') stepFrames.push(`${nodeId}:${status}`);
      await ctx.next();
    },
    { priority: 100 },
  );
  try {
    await mkdir(workspace);
    const source = await prepareSource(root, await listenOnLoopback(server));
    await coordinator.startAll();
    const { admission } = host.catalog();
    const config = { ...makeWorkerConfig({ definition }), terminalAuthority: 'authority' as const };
    const attempt = host.run(
      { bus, call: bus.own('root'), workspace, config, signal: stop.signal },
      { ...runPorts, source, admission },
    );
    try {
      await expect(Promise.race([started.promise, attempt.then(({ result }) => result)])).resolves.toBeUndefined();
      expect(stepFrames).toEqual(['first:pending', 'first:running']);
      await expect(coordinator.applyExtensionTransition(extension, false)).resolves.toBe('applied');
      release.resolve();
      await expect(attempt).resolves.toMatchObject({
        result: { status: 'failed', error: expect.stringContaining('inactive-registration') },
        afterStepsErrors: [],
      });
      expect(stop.signal.aborted).toBe(false);
      await expect(readFile(join(root, 'effects'), 'utf8')).resolves.toBe('first returned\n');
      expect(stepFrames).toEqual(['first:pending', 'first:running', 'first:failed']);
      await expect(readdir(workspace)).resolves.toEqual([]);
    } finally {
      stop.abort();
      await Promise.allSettled([attempt]);
    }
  } finally {
    release.resolve();
    offFrame();
    await close();
    if (server.listening) await closeHttpServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
