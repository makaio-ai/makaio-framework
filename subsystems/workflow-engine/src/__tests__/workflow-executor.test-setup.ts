import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SubagentSubjects, type WorkflowStep } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { ExecutionTargetSubjects } from '@makaio/services-core';
import {
  registerMemorySessionStorage,
  registerMemorySessionEventStorage,
  MakaioSessionService,
} from '@makaio/services-core/session';
import { WorkflowExecutor } from '../workflow-executor.js';
import { createTestDb, type TestDbContext } from './shared.js';

export interface WorkflowExecutorTestSetup {
  dbContext: TestDbContext;
  sessionService: MakaioSessionService;
  workflowExecutor: WorkflowExecutor;
  cleanupFns: Array<() => void>;
}

function registerAdapterStartHandler(): () => void {
  return MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
    ctx.setResult({
      success: true,
      agentId: `agent-${Math.random().toString(36).slice(2)}`,
      adapterId: ctx.payload.adapterId,
      adapterSessionId: `adapter-session-${Math.random().toString(36).slice(2)}`,
      sessionId: ctx.payload.sessionId ?? 'session-missing',
      messageId: `message-${Math.random().toString(36).slice(2)}`,
    });
  });
}

/**
 * Minimal subagent service stub for standalone testing.
 *
 * The monorepo's SubagentService is not available here. This stub provides
 * the minimum bus handler surface needed for the workflow executor tests:
 * spawn → emit spawned, await → waits for completeTask, completeTask → resolves.
 * @param bus - The bus instance to register handlers on.
 */
function registerSubagentStubHandlers(bus: typeof MakaioBus): Array<() => void> {
  const pending = new Map<string, (result: { status: 'completed' | 'failed'; result?: string }) => void>();

  const offSpawn = bus.on(SubagentSubjects.spawn, async (ctx) => {
    const subagentId = `subagent-${Math.random().toString(36).slice(2)}`;
    await bus.emit(SubagentSubjects.spawned, {
      subagentId,
      parentSessionId: ctx.payload.parentSessionId,
      task: ctx.payload.config.task,
      config: { ...ctx.payload.config, contextMode: ctx.payload.config.contextMode ?? 'fork' },
      depth: ctx.payload.depth,
    });
    ctx.setResult({ subagentId, status: 'spawning' });
  });

  const offAwait = bus.on(SubagentSubjects.await, async (ctx) => {
    const { subagentId, timeoutMs } = ctx.payload;
    const result = await new Promise<{ status: 'completed' | 'failed'; result?: string }>((resolve) => {
      pending.set(subagentId, resolve);
      if (timeoutMs !== undefined) {
        setTimeout(() => {
          if (pending.has(subagentId)) {
            pending.delete(subagentId);
            resolve({ status: 'failed', result: undefined });
          }
        }, timeoutMs);
      }
    });
    ctx.setResult({ status: result.status, result: result.result });
  });

  const offCompleteTask = bus.on(SubagentSubjects.completeTask, async (ctx) => {
    const { subagentId, result } = ctx.payload;
    const resolve = pending.get(subagentId);
    if (resolve) {
      pending.delete(subagentId);
      resolve({ status: 'completed', result });
    }
    ctx.setResult({ completed: true });
  });

  const offKill = bus.on(SubagentSubjects.kill, (ctx) => {
    const { subagentId } = ctx.payload;
    const resolve = pending.get(subagentId);
    if (resolve) {
      pending.delete(subagentId);
      resolve({ status: 'failed', result: undefined });
    }
    ctx.setResult({ killed: true });
  });

  return [offSpawn, offAwait, offCompleteTask, offKill];
}

export async function setupWorkflowExecutorTest(): Promise<WorkflowExecutorTestSetup> {
  MakaioBus.__resetHandlers?.();

  const cleanupFns: Array<() => void> = [];
  const dbContext = await createTestDb();

  cleanupFns.push(registerMemorySessionStorage(MakaioBus));
  cleanupFns.push(registerMemorySessionEventStorage(MakaioBus));

  const sessionService = new MakaioSessionService(MakaioBus);
  await sessionService.init();

  cleanupFns.push(...registerSubagentStubHandlers(MakaioBus));

  const workflowExecutor = new WorkflowExecutor(MakaioBus, {
    stepCooldownMs: 0,
    stepTimeoutMs: 10_000,
  });
  await workflowExecutor.init();

  cleanupFns.push(registerAdapterStartHandler());
  cleanupFns.push(
    MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `resolved-${ctx.payload.adapterName}` });
    }),
  );
  cleanupFns.push(
    MakaioBus.on(ExecutionTargetSubjects.resolve, (ctx) => {
      ctx.setResult({
        executionTarget: {
          id: 'system:local',
          name: 'Local',
          description: 'Default local process execution',
          type: 'local',
          scope: 'default',
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      });
    }),
  );
  cleanupFns.push(
    MakaioBus.on(SubagentSubjects.spawned, async (ctx) => {
      await MakaioBus.request(SubagentSubjects.completeTask, {
        subagentId: ctx.payload.subagentId,
        result: `completed:${ctx.payload.task}`,
      });
    }),
  );

  return {
    dbContext,
    sessionService,
    workflowExecutor,
    cleanupFns,
  };
}

export async function teardownWorkflowExecutorTest(setup: WorkflowExecutorTestSetup): Promise<void> {
  await setup.workflowExecutor.destroy();
  await setup.sessionService.destroy();

  setup.cleanupFns.forEach((cleanup) => cleanup());
  setup.cleanupFns.length = 0;

  setup.dbContext.cleanup();
}

export type GateStepInput = Extract<WorkflowStep, { type: 'gate' }>;
