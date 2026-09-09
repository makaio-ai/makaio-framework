import { MakaioBus } from '@makaio/bus-core';
import {
  AgentSubjects,
  AdapterSubjects,
  DEFAULT_CONSTRAINTS,
  SessionNamespace,
  SessionSubjects,
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
  registerMemoryMessageStorage,
  registerMemoryAgentStorage,
  registerMemorySessionOwnershipStorage,
  createSessionStorageMemoryState,
  AgentStorageSubjects,
  MakaioSessionService,
  SessionOrchestrator,
} from '@makaio/services-core/session';
import { SubagentService } from '@makaio/services-core/subagent';
import { WorkflowExecutor } from '../workflow-executor.js';
import type { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import type { WorkflowAttemptOutcome } from '../workflow-attempt-outcome.js';
import { createTestDb, type TestDbContext } from './shared.js';

export interface WorkflowExecutorTestSetup {
  dbContext: TestDbContext;
  sessionService: MakaioSessionService;
  sessionOrchestrator: SessionOrchestrator;
  workflowExecutor: WorkflowExecutor;
  cleanupFns: Array<() => void>;
}

/**
 * Create a collision-resistant test identity with a stable semantic prefix.
 * @param prefix - Entity category used in assertions and diagnostics.
 * @returns Randomized test identity.
 */
function createTestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function registerAdapterStartHandler(): () => void {
  return MakaioBus.on(AdapterSubjects.startAgent, async (ctx) => {
    const now = Date.now();
    const agentId = createTestId('agent');
    const adapterSessionId = createTestId('adapter-session');
    const sessionId = ctx.payload.sessionId ?? 'session-missing';
    const providerConfigId =
      ctx.payload.providerContext?.state === 'resolved' ? ctx.payload.providerContext.providerConfigId : undefined;
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId: ctx.payload.adapterId,
        adapterName: 'workflow-test-adapter',
        sessionId,
        role: ctx.payload.role ?? 'lead',
        status: 'idle',
        createdAt: now,
        lastActivityAt: now,
        ...(ctx.payload.model !== undefined && { model: ctx.payload.model }),
        ...(ctx.payload.cwd !== undefined && { cwd: ctx.payload.cwd }),
        ...(providerConfigId !== undefined && { providerConfigId }),
      },
    });
    await MakaioBus.emit(SessionSubjects.agent.added, {
      sessionId,
      adapterSessionId,
      agentId,
      adapterId: ctx.payload.adapterId,
      adapterName: 'workflow-test-adapter',
      role: ctx.payload.role ?? 'lead',
      ...(ctx.payload.model !== undefined && { model: ctx.payload.model }),
      ...(ctx.payload.cwd !== undefined && { cwd: ctx.payload.cwd }),
    });
    ctx.setResult({
      success: true,
      agentId,
      adapterId: ctx.payload.adapterId,
      ownerInstanceId: 'workflow-test-owner-instance',
      adapterSessionId,
      sessionId,
      messageId: createTestId('message'),
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
    const messageId = ctx.payload.messageId ?? createTestId('message');
    ctx.setResult({ messageId });
    setTimeout(() => {
      void (async () => {
        if (ctx.payload.sessionId !== undefined && ctx.payload.turnId !== undefined) {
          const completion = await MakaioBus.request(SubagentSubjects.completeTask, {
            sessionId: ctx.payload.sessionId,
            turnId: ctx.payload.turnId,
            result: `completed:${String(ctx.payload.message)}`,
          });
          if (!completion.completed) return;
        }
        await MakaioBus.emit(AgentSubjects.complete, {
          agentId: ctx.payload.agentId,
          adapterId: ctx.payload.adapterId,
          adapterName: 'workflow-test-adapter',
          adapterSessionId: `adapter-session-${ctx.payload.agentId}`,
          ...(ctx.payload.sessionId !== undefined ? { sessionId: ctx.payload.sessionId } : {}),
          messageId,
          ...(ctx.payload.turnId !== undefined ? { turnId: ctx.payload.turnId } : {}),
          message: `completed:${String(ctx.payload.message)}`,
        });
      })().catch(() => undefined);
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
  const subagentBySession = new Map<string, string>();

  const offSpawn = bus.on(SubagentSubjects.spawn, async (ctx) => {
    const subagentId = createTestId('subagent');
    subagentBySession.set(`session-${subagentId}`, subagentId);
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

  const offGetStatus = bus.on(SubagentSubjects.getStatus, (ctx) => {
    ctx.setResult({
      status: 'running',
      childSessionId: `session-${ctx.payload.subagentId}`,
      progress: [],
    });
  });

  const offCompleteTask = bus.on(SubagentSubjects.completeTask, async (ctx) => {
    const { sessionId, result } = ctx.payload;
    const subagentId = subagentBySession.get(sessionId);
    if (subagentId === undefined) {
      ctx.setResult({ completed: false });
      return;
    }
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

  return [offSpawn, offAwait, offGetStatus, offCompleteTask, offKill];
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
  options: {
    readonly workflowRunner?: IWorkflowRunner;
    readonly initExecutor?: boolean;
    readonly executionAttemptAuthority?: ExecutionAttemptAuthority<WorkflowAttemptOutcome>;
  } = {},
): Promise<WorkflowExecutorTestSetup> {
  MakaioBus.__resetHandlers?.();
  MakaioBus.registerNamespace(SessionNamespace);

  const cleanupFns: Array<() => void> = [];
  const dbContext = await createTestDb();

  // One shared state across the three session backends, and the ownership
  // backend among them: every start path reserves now, and a reservation reads
  // the agent and session rows the other two wrote.
  const sessionState = createSessionStorageMemoryState();
  cleanupFns.push(registerMemorySessionStorage(MakaioBus, sessionState));
  cleanupFns.push(registerMemorySessionEventStorage(MakaioBus));
  cleanupFns.push(registerMemoryMessageStorage(MakaioBus));
  cleanupFns.push(registerMemoryAgentStorage(MakaioBus, sessionState));
  cleanupFns.push(registerMemorySessionOwnershipStorage(MakaioBus, sessionState));

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
    options.executionAttemptAuthority,
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
          sessionId: `session-${ctx.payload.subagentId}`,
          turnId: `turn-${ctx.payload.subagentId}`,
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
 * @param options - Optional test-handler registration controls.
 * @returns Test setup including the real subagent service and captured calls.
 */
export async function setupWorkflowExecutorWithSubagentServiceTest(
  options: { readonly registerAdapterHandler?: boolean } = {},
): Promise<WorkflowExecutorWithSubagentServiceTestSetup> {
  MakaioBus.__resetHandlers?.();

  const cleanupFns: Array<() => void> = [];
  const dbContext = await createTestDb();

  // One shared state across the three session backends, and the ownership
  // backend among them: every start path reserves now, and a reservation reads
  // the agent and session rows the other two wrote.
  const sessionState = createSessionStorageMemoryState();
  cleanupFns.push(registerMemorySessionStorage(MakaioBus, sessionState));
  cleanupFns.push(registerMemorySessionEventStorage(MakaioBus));
  cleanupFns.push(registerMemoryMessageStorage(MakaioBus));
  cleanupFns.push(registerMemoryAgentStorage(MakaioBus, sessionState));
  cleanupFns.push(registerMemorySessionOwnershipStorage(MakaioBus, sessionState));

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

  if (options.registerAdapterHandler !== false)
    cleanupFns.push(
      MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
        adapterStartCalls.push(ctx.payload);
        ctx.setResult({
          success: true,
          agentId: createTestId('agent'),
          adapterId: ctx.payload.adapterId,
          ownerInstanceId: 'workflow-test-owner-instance',
          adapterSessionId: createTestId('adapter-session'),
          sessionId: ctx.payload.sessionId ?? 'session-missing',
          messageId: createTestId('message'),
        });
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
