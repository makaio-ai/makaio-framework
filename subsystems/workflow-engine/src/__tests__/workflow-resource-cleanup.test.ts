import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, DEFAULT_CONSTRAINTS, SubagentSubjects } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import { ExecutionTargetSubjects } from '@makaio/services-core';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import {
  MakaioSessionService,
  registerMemorySessionEventStorage,
  registerMemorySessionStorage,
} from '@makaio/services-core/session';
import { SubagentService } from '@makaio/services-core/subagent';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { WorkflowExecutor } from '../workflow-executor.js';
import { asExecutable, createTestDb, createWorkflowDefinition, type TestDbContext } from './shared.js';

type CancelledSubagentPayload = ExtractSubjectPayload<typeof SubagentSubjects.cancelled>;
type KillSubagentPayload = ExtractSubjectPayload<typeof SubagentSubjects.kill>;
type GateRequestedPayload = ExtractSubjectPayload<typeof WorkflowSubjects.gate.requested>;

interface ResourceCleanupTestSetup {
  dbContext: TestDbContext;
  sessionService: MakaioSessionService;
  subagentService: SubagentService;
  workflowExecutor: WorkflowExecutor;
  cleanupFns: Array<() => void>;
}

/**
 * Register runtime handlers outside the workflow engine boundary.
 * @param cleanupFns - Cleanup sink for bus handler teardown.
 */
function registerRuntimeSupport(cleanupFns: Array<() => void>): void {
  cleanupFns.push(
    MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `resolved-${ctx.payload.adapterName}` });
    }),
  );
  cleanupFns.push(
    MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
      ctx.setResult({
        success: true,
        agentId: `agent-${Math.random().toString(36).slice(2)}`,
        adapterId: ctx.payload.adapterId,
        adapterSessionId: `adapter-session-${Math.random().toString(36).slice(2)}`,
        sessionId: ctx.payload.sessionId ?? 'session-missing',
        messageId: `message-${Math.random().toString(36).slice(2)}`,
      });
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
}

/**
 * Build a workflow executor fixture with the real subagent service.
 * @returns Initialized fixture and teardown handles.
 */
async function setupResourceCleanupTest(): Promise<ResourceCleanupTestSetup> {
  MakaioBus.__resetHandlers?.();

  const cleanupFns: Array<() => void> = [];
  const dbContext = await createTestDb();

  cleanupFns.push(registerMemorySessionStorage(MakaioBus));
  cleanupFns.push(registerMemorySessionEventStorage(MakaioBus));

  const sessionService = new MakaioSessionService(MakaioBus);
  await sessionService.init();

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

  registerRuntimeSupport(cleanupFns);

  return {
    dbContext,
    sessionService,
    subagentService,
    workflowExecutor,
    cleanupFns,
  };
}

/**
 * Tear down a resource cleanup fixture.
 * @param setup - Fixture returned by setupResourceCleanupTest.
 */
async function teardownResourceCleanupTest(setup: ResourceCleanupTestSetup): Promise<void> {
  await setup.workflowExecutor.destroy();
  await setup.subagentService.destroy();
  await setup.sessionService.destroy();

  setup.cleanupFns.forEach((cleanup) => cleanup());
  setup.cleanupFns.length = 0;

  setup.dbContext.cleanup();
}

describe('WorkflowExecutor resource cleanup', () => {
  let setup: ResourceCleanupTestSetup | undefined;

  beforeEach(async () => {
    setup = await setupResourceCleanupTest();
  });

  afterEach(async () => {
    if (setup) {
      await teardownResourceCleanupTest(setup);
      setup = undefined;
    }
  });

  it('kills an in-flight subagent when a parallel step fails', async () => {
    if (!setup) {
      throw new Error('Expected initialized test setup');
    }

    const cancelledSubagents: CancelledSubagentPayload[] = [];
    const killRequests: KillSubagentPayload[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(
        SubagentSubjects.kill,
        async (ctx) => {
          killRequests.push(ctx.payload);
          await ctx.next();
        },
        { priority: 1_000 },
      ),
    );
    setup.cleanupFns.push(
      MakaioBus.on(SubagentSubjects.cancelled, (ctx) => {
        cancelledSubagents.push(ctx.payload);
      }),
    );

    const failedExecutions: Array<{ executionId: string; failedStepId?: string }> = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push({
          executionId: ctx.payload.executionId,
          failedStepId: ctx.payload.failedStepId,
        });
      }),
    );

    let gateRequest: GateRequestedPayload | undefined;
    let longAgentSubagentId: string | undefined;
    let gateResponsePromise: Promise<{ accepted: boolean }> | undefined;

    const rejectGateWhenAgentIsRunning = (): void => {
      if (!gateRequest || !longAgentSubagentId || gateResponsePromise) return;
      gateResponsePromise = MakaioBus.request(WorkflowSubjects.gate.respond, {
        executionId: gateRequest.executionId,
        stepId: gateRequest.stepId,
        action: 'reject',
      });
    };

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.gate.requested, (ctx) => {
        gateRequest = ctx.payload;
        rejectGateWhenAgentIsRunning();
      }),
    );
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.started, (ctx) => {
        if (ctx.payload.stepId !== 'long-agent' || typeof ctx.payload.subagentId !== 'string') return;
        longAgentSubagentId = ctx.payload.subagentId;
        rejectGateWhenAgentIsRunning();
      }),
    );

    const workflow = createWorkflowDefinition({
      id: 'workflow-fail-fast-subagent-cleanup',
      steps: [
        {
          id: 'long-agent',
          type: 'agent',
          prompt: 'Keep running until fail-fast cleanup cancels the subagent',
          adapter: 'claude-code',
        },
        {
          id: 'reject-gate',
          type: 'gate',
          prompt: 'Reject to fail the parallel workflow',
          autoAction: 'approve',
          timeoutMs: null,
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await vi.waitFor(() => expect(gateResponsePromise).toBeDefined(), { timeout: 10_000 });
    await expect(gateResponsePromise).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => expect(cancelledSubagents).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(failedExecutions).toEqual([{ executionId, failedStepId: 'reject-gate' }]), {
      timeout: 10_000,
    });

    expect(killRequests).toEqual([
      {
        subagentId: longAgentSubagentId,
        reason: 'Workflow step failed',
      },
    ]);
    expect(cancelledSubagents[0]).toMatchObject({
      subagentId: longAgentSubagentId,
      reason: 'Workflow step failed',
    });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('failed');
    expect(execution?.steps['reject-gate']?.status).toBe('failed');
    expect(execution?.steps['long-agent']?.status).toBe('failed');
    expect(asExecutable(execution?.steps['long-agent'])?.subagentId).toBe(longAgentSubagentId);
  });
});
