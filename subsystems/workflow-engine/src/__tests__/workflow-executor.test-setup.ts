import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SubagentSubjects, type WorkflowStep } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { ExecutionTargetSubjects } from '../../execution-target/namespace.js';
import {
  registerMemorySessionStorage,
  registerMemorySessionEventStorage,
  MakaioSessionService,
} from '@makaio/services-core/session';
import { ProductSessionService } from '../../session-orchestration/product-session-service.js';
import { SubagentService } from '../../subagent/index.js';
import { WorkflowExecutor } from '../workflow-executor.js';
import { createTestDb, type TestDbContext } from './shared.js';

export interface WorkflowExecutorTestSetup {
  dbContext: TestDbContext;
  sessionService: MakaioSessionService;
  productSessionService: ProductSessionService;
  subagentService: SubagentService;
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

export async function setupWorkflowExecutorTest(): Promise<WorkflowExecutorTestSetup> {
  MakaioBus.__resetHandlers?.();

  const cleanupFns: Array<() => void> = [];
  const dbContext = await createTestDb();

  cleanupFns.push(registerMemorySessionStorage(MakaioBus));
  cleanupFns.push(registerMemorySessionEventStorage(MakaioBus));

  const sessionService = new MakaioSessionService(MakaioBus);
  await sessionService.init();
  const productSessionService = new ProductSessionService(MakaioBus);
  await productSessionService.init();

  const subagentService = new SubagentService(MakaioBus);
  await subagentService.init();

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
    productSessionService,
    subagentService,
    workflowExecutor,
    cleanupFns,
  };
}

export async function teardownWorkflowExecutorTest(setup: WorkflowExecutorTestSetup): Promise<void> {
  setup.workflowExecutor.destroy();
  setup.subagentService.destroy();
  await setup.productSessionService.destroy();
  await setup.sessionService.destroy();

  setup.cleanupFns.forEach((cleanup) => cleanup());
  setup.cleanupFns.length = 0;

  setup.dbContext.cleanup();
}

export type GateStepInput = Extract<WorkflowStep, { type: 'gate' }>;
