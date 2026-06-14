import { MakaioBus } from '@makaio/bus-core';
import {
  AgentSubjects,
  AdapterSubjects,
  DEFAULT_CONSTRAINTS,
  SubagentConfigSchema,
  SubagentSubjects,
  type IWorkflowRunner,
  type WorkflowGateNode,
} from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { ExecutionTargetSubjects } from '@makaio/services-core';
import {
  registerMemorySessionStorage,
  registerMemorySessionEventStorage,
  MakaioSessionService,
  SessionOrchestrator,
} from '@makaio/services-core/session';
import { SubagentService } from '@makaio/services-core/subagent';
import { WorkflowExecutor } from '../workflow-executor.js';
import { createTestDb, type TestDbContext } from './shared.js';

export interface WorkflowExecutorTestSetup {
  dbContext: TestDbContext;
  sessionService: MakaioSessionService;
  sessionOrchestrator: SessionOrchestrator;
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
 * Minimal agent.sendMessage handler for workflow session-turn tests.
 *
 * The session orchestrator owns turn completion, so this handler acknowledges
 * delivery first and emits agent.complete on the next tick with the turn
 * correlation fields it received.
 * @returns Cleanup function.
 */
function registerAgentSendMessageHandler(): () => void {
  return MakaioBus.on(AgentSubjects.sendMessage, (ctx) => {
    const messageId = ctx.payload.messageId ?? `message-${Math.random().toString(36).slice(2)}`;
    ctx.setResult({ messageId });
    setTimeout(() => {
      void MakaioBus.emit(AgentSubjects.complete, {
        agentId: ctx.payload.agentId,
        adapterId: ctx.payload.adapterId,
        adapterName: 'workflow-test-adapter',
        adapterSessionId: `adapter-session-${ctx.payload.agentId}`,
        ...(ctx.payload.sessionId !== undefined ? { sessionId: ctx.payload.sessionId } : {}),
        messageId,
        ...(ctx.payload.turnId !== undefined ? { turnId: ctx.payload.turnId } : {}),
        message: `completed:${String(ctx.payload.message)}`,
      }).catch(() => {});
    }, 0);
  });
}

/**
 * Minimal subagent service stub for focused workflow executor tests.
 *
 * The full subagent runtime is not registered in this test setup. This stub
 * provides the minimum bus handler surface needed for the workflow executor tests:
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
      config: SubagentConfigSchema.parse(ctx.payload.config),
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

const MOCK_EXECUTION_TARGET = {
  id: 'system:local',
  name: 'Local',
  description: 'Default local process execution',
  type: 'local',
  scope: 'default',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as const;

function registerCommonMockHandlers(cleanupFns: Array<() => void>): void {
  cleanupFns.push(
    MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `resolved-${ctx.payload.adapterName}` });
    }),
  );
  cleanupFns.push(
    MakaioBus.on(ExecutionTargetSubjects.resolve, (ctx) => {
      ctx.setResult({ executionTarget: MOCK_EXECUTION_TARGET });
    }),
  );
}

/**
 * Set up the workflow executor with lightweight test doubles.
 * @param options - Optional runtime seams to inject into the executor.
 * @returns Initialized workflow executor test setup.
 */
export async function setupWorkflowExecutorTest(
  options: { readonly workflowRunner?: IWorkflowRunner; readonly initExecutor?: boolean } = {},
): Promise<WorkflowExecutorTestSetup> {
  MakaioBus.__resetHandlers?.();

  const cleanupFns: Array<() => void> = [];
  const dbContext = await createTestDb();

  cleanupFns.push(registerMemorySessionStorage(MakaioBus));
  cleanupFns.push(registerMemorySessionEventStorage(MakaioBus));

  const sessionService = new MakaioSessionService(MakaioBus);
  await sessionService.init();
  const sessionOrchestrator = new SessionOrchestrator(MakaioBus, 'workflow-test-machine');

  cleanupFns.push(...registerSubagentStubHandlers(MakaioBus));

  const workflowExecutor = new WorkflowExecutor(
    MakaioBus,
    {
      stepCooldownMs: 0,
      stepTimeoutMs: 10_000,
    },
    options.workflowRunner,
  );
  if (options.initExecutor !== false) {
    await workflowExecutor.init();
  }

  cleanupFns.push(registerAdapterStartHandler());
  cleanupFns.push(registerAgentSendMessageHandler());
  registerCommonMockHandlers(cleanupFns);
  cleanupFns.push(
    MakaioBus.on(SubagentSubjects.spawned, (ctx) => {
      // Defer completeTask to the next event-loop tick so SubagentSubjects.await
      // can register its pending resolver before the completion fires.
      setTimeout(() => {
        void MakaioBus.request(SubagentSubjects.completeTask, {
          subagentId: ctx.payload.subagentId,
          result: `completed:${ctx.payload.task}`,
        }).catch(() => {});
      }, 0);
    }),
  );

  return {
    dbContext,
    sessionService,
    sessionOrchestrator,
    workflowExecutor,
    cleanupFns,
  };
}

export async function teardownWorkflowExecutorTest(setup: WorkflowExecutorTestSetup): Promise<void> {
  await setup.workflowExecutor.destroy();
  setup.sessionOrchestrator.destroy();
  await setup.sessionService.destroy();

  setup.cleanupFns.forEach((cleanup) => cleanup());
  setup.cleanupFns.length = 0;

  setup.dbContext.cleanup();
}

/**
 * Extended test setup that includes the real {@link SubagentService} and a mock
 * adapter handler, allowing end-to-end workflow → subagent → adapter coverage
 * without running real AI.
 */
export interface WorkflowExecutorWithSubagentServiceTestSetup extends WorkflowExecutorTestSetup {
  /** The real subagent service instance. */
  subagentService: SubagentService;
  /** Captured payloads from each {@link AdapterSubjects.startAgent} call. */
  adapterStartCalls: Array<ExtractSubjectPayload<typeof AdapterSubjects.startAgent>>;
}

/**
 * Set up the workflow executor with the real {@link SubagentService} instead of
 * the stub handlers.
 *
 * The mock adapter start handler captures call payloads and deterministically
 * completes the subagent on the next tick via the real
 * {@link SubagentSubjects.completeTask} RPC. Subagent IDs are tracked by
 * observing {@link SubagentSubjects.spawned} and matched FIFO to adapter
 * start calls.
 * @returns Test setup including the real subagent service and captured calls.
 */
export async function setupWorkflowExecutorWithSubagentServiceTest(): Promise<WorkflowExecutorWithSubagentServiceTestSetup> {
  MakaioBus.__resetHandlers?.();

  const cleanupFns: Array<() => void> = [];
  const dbContext = await createTestDb();

  cleanupFns.push(registerMemorySessionStorage(MakaioBus));
  cleanupFns.push(registerMemorySessionEventStorage(MakaioBus));

  const sessionService = new MakaioSessionService(MakaioBus);
  await sessionService.init();
  const sessionOrchestrator = new SessionOrchestrator(MakaioBus, 'workflow-test-machine');

  // Real SubagentService — handles spawn/await/completeTask/kill RPCs.
  // sweepIntervalMs: 0 disables the periodic cleanup interval to avoid timer
  // leaks in the test process.
  const subagentService = new SubagentService(MakaioBus, {
    ...DEFAULT_CONSTRAINTS,
    sweepIntervalMs: 0,
  });
  await subagentService.init();

  const workflowExecutor = new WorkflowExecutor(MakaioBus, {
    stepCooldownMs: 0,
    stepTimeoutMs: 10_000,
  });
  await workflowExecutor.init();

  const adapterStartCalls: Array<ExtractSubjectPayload<typeof AdapterSubjects.startAgent>> = [];

  // FIFO queue of subagent IDs emitted by SubagentSubjects.spawned.
  // Each spawned event fires before SubagentService calls startAgent for that
  // subagent, so a FIFO dequeue in the startAgent handler safely matches them.
  const pendingSubagentIds: string[] = [];
  cleanupFns.push(
    MakaioBus.on(SubagentSubjects.spawned, (ctx) => {
      pendingSubagentIds.push(ctx.payload.subagentId);
    }),
  );

  cleanupFns.push(
    MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
      adapterStartCalls.push(ctx.payload);
      const subagentId = pendingSubagentIds.shift();
      ctx.setResult({
        success: true,
        agentId: `agent-${Math.random().toString(36).slice(2)}`,
        adapterId: ctx.payload.adapterId,
        adapterSessionId: `adapter-session-${Math.random().toString(36).slice(2)}`,
        sessionId: ctx.payload.sessionId ?? 'session-missing',
        messageId: `message-${Math.random().toString(36).slice(2)}`,
      });
      if (subagentId === undefined) {
        return;
      }
      // Complete the subagent on the next tick so SubagentSubjects.await can
      // register its pending resolver before the completion fires.
      setTimeout(() => {
        void MakaioBus.request(SubagentSubjects.completeTask, {
          subagentId,
          result: `completed:${String(ctx.payload.initialMessage ?? '')}`,
        }).catch(() => {});
      }, 0);
    }),
  );

  registerCommonMockHandlers(cleanupFns);
  cleanupFns.push(registerAgentSendMessageHandler());

  return {
    dbContext,
    sessionService,
    sessionOrchestrator,
    subagentService,
    workflowExecutor,
    cleanupFns,
    adapterStartCalls,
  };
}

/**
 * Tear down a {@link WorkflowExecutorWithSubagentServiceTestSetup}.
 * @param setup - The test setup to clean up.
 */
export async function teardownWorkflowExecutorWithSubagentServiceTest(
  setup: WorkflowExecutorWithSubagentServiceTestSetup,
): Promise<void> {
  await setup.workflowExecutor.destroy();
  await setup.subagentService.destroy();
  setup.sessionOrchestrator.destroy();
  await setup.sessionService.destroy();

  setup.cleanupFns.forEach((cleanup) => cleanup());
  setup.cleanupFns.length = 0;

  setup.dbContext.cleanup();
}

export type GateStepInput = WorkflowGateNode;
