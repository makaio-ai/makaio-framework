import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionNamespace,
  SessionSubjects,
  StoredWorkflowRunContextSchema,
  WorkflowSubjects,
  type WorkflowDefinition,
  type StoredWorkflowRunContext,
} from '@makaio/contracts';
import { WorkflowExecutor, WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { createTestCall, makeStubExtensionContext } from '@makaio/test-utils';
import { expect, it, vi } from 'vitest';
import { computeDirectoryDigest } from '../local-directory-materializer.js';
import { ThinWorkflowPiscinaRunner } from '../thin-workflow-piscina-runner.js';
import { makeBusWithStorage } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * Verify that a registered workflow runs its handler in a dedicated child process.
 * @param kind - Registered executable source form to dispatch.
 */
async function verifyRegisteredDefinition(kind: 'path' | 'source'): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'makaio-piscina-definition-'));
  const root = join(temp, 'workspace');
  await mkdir(root);
  const source = `import { isMainThread } from 'node:worker_threads';
    if (!isMainThread || process.pid === ${process.pid}) throw new Error('Expected a dedicated step process');
    export default {
      definition: {
        id: 'registered-workflow',
        scope: { type: 'global' },
        root: { id: 'root', type: 'sequence', nodes: [{ id: 'answer', type: 'code-step' }] },
      },
      runtimeHandlers: new Map([['answer', () => ({ answer: 42 })]]),
    };`;
  const workerEntry = join(root, 'worker.mjs');
  const filename = 'workflow.mjs';
  const workflow: WorkflowDefinition = {
    id: 'registered-workflow',
    scope: { type: 'global' },
    root: { id: 'root', type: 'sequence', nodes: [{ id: 'answer', type: 'code-step' }] },
    executableSource: kind === 'path' ? { kind, path: filename } : { kind, filename, source },
  };
  const [bus, cleanup, executions] = makeBusWithStorage();
  const contexts = new Map<string, StoredWorkflowRunContext>();
  const offContext = bus.on(
    WorkflowStorageSubjects.setExecutionStart,
    async (ctx) => {
      contexts.set(ctx.payload.execution.id, StoredWorkflowRunContextSchema.parse(ctx.payload.runContext));
      await ctx.next();
    },
    { priority: 100 },
  );
  const offGetContext = bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => {
    ctx.setResult({ runContext: contexts.get(ctx.payload.executionId) ?? null });
  });
  bus.registerNamespace(SessionNamespace);
  const offSession = bus.on(SessionSubjects.create, (ctx) => ctx.setResult({ sessionId: 'coordinator' }));
  const offDefinition = bus.on(WorkflowStorageSubjects.get, (ctx) => ctx.setResult({ workflow }));
  const offExecution = bus.on(WorkflowStorageSubjects.getExecution, (ctx) => {
    ctx.setResult({ execution: executions.get(ctx.payload.executionId) ?? null });
  });
  const runner = new ThinWorkflowPiscinaRunner({
    workerEntry,
    manifest: { contributionRefs: [] },
    resolveWorkspaceRoot: async () => root,
  });
  const run = vi.spyOn(runner, 'run');
  const file = vi.spyOn(runner.callerLocalFileRunner, 'run');
  const executor = new WorkflowExecutor(
    bus,
    makeStubExtensionContext(bus).namespaces,
    undefined,
    runner,
    runner.callerLocalFileRunner,
  );
  const call = createTestCall();
  try {
    await writeFile(join(root, filename), source);
    await writeFile(
      workerEntry,
      `import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
      register();
      const { createPiscinaWorker } = await import(${JSON.stringify(import.meta.resolve('@makaio/runtime-node/workflow-worker/worker-entry'))});
      const { makeBusWithStorage } = await import(${JSON.stringify(new URL('./fixtures.ts', import.meta.url).href)});
      export default createPiscinaWorker(async () => {
        const [bus, cleanup] = makeBusWithStorage();
        const { WorkflowStorageSubjects } = await import(${JSON.stringify(import.meta.resolve('@makaio/subsystem-workflow-engine'))});
        const off = bus.on(WorkflowStorageSubjects.setFrame, async (ctx) => {
          const { executionId, frame } = ctx.payload;
          await ctx.next();
          if (frame.status === 'completed' && frame.nodeId === 'answer') {
            await writeFile(join(${JSON.stringify(temp)}, executionId), JSON.stringify(frame.output));
          }
        }, { priority: 100 });
        return { connection: { bus, async close() { off(); cleanup(); } } };
      });`,
    );
    executor.registerWorkflowMaterializationSpecResolver({
      resolve: async () => ({
        kind: 'local-directory',
        workspaceId: 'test-checkout',
        rootDigest: await computeDirectoryDigest(root),
        sourcePath: filename,
      }),
    });
    await executor.init();
    const { executionId } = await bus.request(call, WorkflowSubjects.start, { workflowId: workflow.id });
    const expectOutput = async (id: string, answer: number): Promise<void> => {
      const index = run.mock.calls.findIndex(([, config]) => config.executionId === id);
      expect(run.mock.calls[index]?.[1].cancelSubject).toBe(`workflow.${id}.cancel`);
      const result = run.mock.results[index];
      expect(file).not.toHaveBeenCalled();
      expect(result).toBeDefined();
      await expect(result?.value).resolves.toMatchObject({
        state: 'uncommitted',
        result: { status: 'completed', executionId: id, workflowId: workflow.id },
      });
      await expect(readFile(join(temp, id), 'utf8')).resolves.toBe(JSON.stringify({ answer }));
    };
    await expectOutput(executionId, 42);
    if (kind === 'path') {
      const snapshot = await bus.request(call, WorkflowSubjects.rerun, { executionId, mode: 'snapshot' });
      await expectOutput(snapshot.executionId, 42);
      await writeFile(join(root, filename), source.replace('answer: 42', 'answer: 43'));
      const current = await bus.request(call, WorkflowSubjects.rerun, { executionId, mode: 'current' });
      await expectOutput(current.executionId, 43);
      expect(new Set([executionId, snapshot.executionId, current.executionId]).size).toBe(3);
      await bus.request(call, WorkflowSubjects.rerun, { executionId, mode: 'snapshot' });
      await expect(run.mock.results.at(-1)?.value).rejects.toThrow('Workspace root digest mismatch');
      expect(file).not.toHaveBeenCalled();
    }
  } finally {
    await executor.destroy();
    offContext();
    offGetContext();
    offExecution();
    offDefinition();
    offSession();
    cleanup();
    await rm(temp, { recursive: true, force: true });
  }
}

it('runs the registered definition with executable source path', () => verifyRegisteredDefinition('path'));
it('runs the registered definition with executable source source', () => verifyRegisteredDefinition('source'));
