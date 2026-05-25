import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, SubagentSubjects, SpawnSubagentRpcRequestSchema } from '@makaio/contracts';
import { z } from 'zod';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { WorkflowExecutor } from '../workflow-executor.js';
import { asExecutable, createWorkflowDefinition } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

describe('WorkflowExecutor', () => {
  let setup: WorkflowExecutorTestSetup;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    await teardownWorkflowExecutorTest(setup);
  });

  it('executes agent workflow steps and persists results', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-executor-test',
      name: 'executor-test',
      steps: [
        { id: 'one', type: 'agent' as const, prompt: 'Step one', adapter: 'claude-code' },
        { id: 'two', type: 'agent' as const, prompt: 'Step two', needs: ['one'], adapter: 'claude-code' },
        { id: 'three', type: 'agent' as const, prompt: 'Step three', needs: ['two'], adapter: 'claude-code' },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedSteps: string[] = [];
    const completedExecutions: string[] = [];

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.completed, (ctx) => {
        completedSteps.push(ctx.payload.stepId);
      }),
    );

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
      parentSessionId: undefined,
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('completed');
    expect(completedSteps).toEqual(['one', 'two', 'three']);
    const { spans } = await MakaioBus.request(WorkflowStorageSubjects.listSpans, { executionId });
    expect(spans.map((span) => [span.stepId, span.status])).toEqual([
      ['one', 'completed'],
      ['two', 'completed'],
      ['three', 'completed'],
    ]);

    const coordinatorSessionId = execution?.coordinatorSessionId;
    expect(coordinatorSessionId).toEqual(expect.any(String));

    if (!coordinatorSessionId) {
      throw new Error('Missing coordinator session id');
    }

    const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId: coordinatorSessionId });
    // The coordinator session exists and has a title set by the executor.
    // branchKind is a host-enriched field not persisted by the standalone
    // MakaioSessionService, so we assert on the stable fields instead.
    expect(session).not.toBeNull();
    expect(session?.title).toMatch(/^Workflow:/);
  });

  it('sanitizes trigger payload before persisting execution state', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-trigger-payload-sanitization',
      name: 'trigger-payload-sanitization',
      steps: [{ id: 'one', type: 'agent', prompt: 'Step one', adapter: 'claude-code' }],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const rawPayload = {
      Authorization: 'Bearer super-secret',
      nested: { token: 'hidden-token', ok: 'visible-value' },
      long: 'x'.repeat(2_500),
    };

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
      triggerPayload: rawPayload,
    });

    await vi.waitFor(async () => {
      const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(execution?.status).toBe('completed');
    });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.triggerPayload).toMatchObject({
      Authorization: '[REDACTED]',
      nested: { token: '[REDACTED]', ok: 'visible-value' },
    });

    const longValue = execution?.triggerPayload?.long;
    expect(typeof longValue).toBe('string');
    if (typeof longValue !== 'string') {
      throw new Error('Expected sanitized long trigger payload value to be a string');
    }
    expect(longValue.length).toBe(2_000);
  });

  it('executes independent steps in the same topological level in parallel', async () => {
    // Diamond topology: A → B, A → C, B+C → D
    // Expected topo levels: [A], [B, C], [D]
    // B and C must both complete before D starts.
    const workflow = createWorkflowDefinition({
      id: 'workflow-parallel-diamond',
      name: 'parallel-diamond',
      steps: [
        { id: 'A', type: 'agent' as const, prompt: 'Step A', adapter: 'claude-code' },
        { id: 'B', type: 'agent' as const, prompt: 'Step B', needs: ['A'], adapter: 'claude-code' },
        { id: 'C', type: 'agent' as const, prompt: 'Step C', needs: ['A'], adapter: 'claude-code' },
        { id: 'D', type: 'agent' as const, prompt: 'Step D', needs: ['B', 'C'], adapter: 'claude-code' },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedSteps: string[] = [];
    const completedExecutions: string[] = [];

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.completed, (ctx) => {
        completedSteps.push(ctx.payload.stepId);
      }),
    );

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
      parentSessionId: undefined,
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    // All four steps completed
    expect(completedSteps).toHaveLength(4);

    // A must be first; D must be last
    expect(completedSteps[0]).toBe('A');
    expect(completedSteps[3]).toBe('D');

    // B and C must both complete before D (order between B and C is non-deterministic)
    const indexB = completedSteps.indexOf('B');
    const indexC = completedSteps.indexOf('C');
    const indexD = completedSteps.indexOf('D');
    expect(indexB).toBeGreaterThan(-1);
    expect(indexC).toBeGreaterThan(-1);
    expect(indexB).toBeLessThan(indexD);
    expect(indexC).toBeLessThan(indexD);

    // Verify final execution state
    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('completed');
    expect(execution?.steps['A']?.status).toBe('completed');
    expect(execution?.steps['B']?.status).toBe('completed');
    expect(execution?.steps['C']?.status).toBe('completed');
    expect(execution?.steps['D']?.status).toBe('completed');
  });

  it('returns an empty trigger type list when registry is not configured', async () => {
    const { triggerTypes } = await MakaioBus.request(WorkflowSubjects.listTriggerTypes, {});
    expect(triggerTypes).toEqual([]);
  });

  it('discards step result when onComplete.extract is none', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-on-complete-none',
      name: 'on-complete-none',
      steps: [
        {
          id: 'silent',
          type: 'agent' as const,
          prompt: 'Do something quietly',
          adapter: 'claude-code',
          onComplete: { extract: 'none' },
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(async () => {
      const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(execution?.status).toBe('completed');
    });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(asExecutable(execution?.steps['silent'])?.result).toBe('');
  });

  it('preserves step result when onComplete is absent', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-on-complete-absent',
      name: 'on-complete-absent',
      steps: [
        {
          id: 'loud',
          type: 'agent' as const,
          prompt: 'Produce output',
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(async () => {
      const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(execution?.status).toBe('completed');
    });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(asExecutable(execution?.steps['loud'])?.result).toBe('completed:Produce output');
  });

  it('fails execution when for-each collection evaluates to a non-array at runtime', async () => {
    const failedExecutions: Array<{ executionId: string; failedStepId?: string }> = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push({ executionId: ctx.payload.executionId, failedStepId: ctx.payload.failedStepId });
      }),
    );

    const workflow = createWorkflowDefinition({
      id: 'workflow-expansion-failure-runtime',
      steps: [
        {
          id: 'loop',
          type: 'for-each' as const,
          // trigger.items is undefined — evaluates to non-array at runtime
          collection: 'trigger.items',
          steps: [{ id: 'one', type: 'agent' as const, prompt: 'Step one', adapter: 'claude-code' }],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(failedExecutions).toHaveLength(1));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('failed');
    expect(execution?.steps['loop']?.status).toBe('failed');
  });

  it('closes the coordinator session when execution persistence fails before launch', async () => {
    const { sessions: activeBefore } = await MakaioBus.request(SessionSubjects.list, { status: 'active' });
    const workflow = createWorkflowDefinition({
      id: 'workflow-persistence-failure-closes-session',
      steps: [{ id: 'one', type: 'agent', prompt: 'Step one', adapter: 'claude-code' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const failSetExecution = MakaioBus.on(
      WorkflowStorageSubjects.setExecution,
      () => {
        throw new Error('setExecution unavailable');
      },
      { priority: 1_000 },
    );
    try {
      await expect(MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id, inputs: {} })).rejects.toThrow(
        'setExecution unavailable',
      );
    } finally {
      failSetExecution();
    }

    const { sessions: activeAfter } = await MakaioBus.request(SessionSubjects.list, { status: 'active' });
    expect(activeAfter.map((session) => session.sessionId).sort()).toEqual(
      activeBefore.map((session) => session.sessionId).sort(),
    );
  });

  it('continues a persisted execution when execution.started observers fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const workflow = createWorkflowDefinition({
      id: 'workflow-started-observer-failure',
      steps: [{ id: 'one', type: 'agent', prompt: 'Step one', adapter: 'claude-code' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.started, () => {
        throw new Error('started listener failed');
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id, inputs: {} });

    await vi.waitFor(async () => {
      const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(execution?.status).toBe('completed');
    });
  });

  it('registers handlers through idempotent service lifecycle', async () => {
    // Tear down the setup executor so its handlers don't interfere with the assertion.
    await setup.workflowExecutor.destroy();

    const executor = new WorkflowExecutor(MakaioBus, { stepCooldownMs: 0, stepTimeoutMs: 10_000 });
    await executor.init();
    await executor.init();
    await executor.destroy();
    await executor.destroy();

    await expect(MakaioBus.request(WorkflowSubjects.listTriggerTypes, {})).rejects.toThrow(
      'No handler registered for request subject "workflow.listTriggerTypes"',
    );
  });

  it('emits dotted lifecycle events around step execution', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-lifecycle-events',
      steps: [{ id: 'one', type: 'agent', prompt: 'Step one', adapter: 'claude-code' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const events: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.started, () => {
        events.push('execution.started');
      }),
    );
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.beforeStart, () => {
        events.push('step.beforeStart');
      }),
    );
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.started, () => {
        events.push('step.started');
      }),
    );
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.completed, () => {
        events.push('step.completed');
      }),
    );
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, () => {
        events.push('execution.completed');
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id, inputs: {} });
    await vi.waitFor(() => expect(events.at(-1)).toBe('execution.completed'));

    expect(events).toEqual([
      'execution.started',
      'step.beforeStart',
      'step.started',
      'step.completed',
      'execution.completed',
    ]);
    expect(executionId).toEqual(expect.any(String));
  });

  it('applies workflow input defaults and rejects missing required inputs', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-input-binding',
      inputs: [
        { name: 'title', type: 'string', required: true },
        { name: 'dryRun', type: 'boolean', default: true },
      ],
      steps: [{ id: 'one', type: 'agent', prompt: 'Title {{ inputs.title }} dry {{ inputs.dryRun }}' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    await expect(MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id, inputs: {} })).rejects.toThrow(
      'Missing required workflow input: title',
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { title: 'Voucher' },
    });

    await vi.waitFor(async () => {
      const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(execution?.status).toBe('completed');
      expect(execution?.inputs).toEqual({ title: 'Voucher', dryRun: true });
    });
  });

  it('fails the step when a beforeStart interceptor throws', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-before-start-interceptor',
      steps: [{ id: 'one', type: 'agent', prompt: 'Step one', adapter: 'claude-code' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    setup.cleanupFns.push(
      MakaioBus.intercept(WorkflowSubjects.step.beforeStart, () => {
        throw new Error('battery rejected step');
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

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id, inputs: {} });
    await vi.waitFor(() => expect(failedExecutions).toEqual([{ executionId, failedStepId: 'one' }]));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps.one?.status).toBe('failed');
    expect(execution?.steps.one?.error).toBe('battery rejected step');
    const { spans } = await MakaioBus.request(WorkflowStorageSubjects.listSpans, { executionId });
    expect(spans[0]).toMatchObject({ stepId: 'one', status: 'failed' });
  });

  it('fails fast when one parallel step fails while a sibling gate waits indefinitely', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-parallel-failure-with-gate',
      steps: [
        { id: 'fail', type: 'shell', command: ['sh', '-c', 'exit 7'] },
        { id: 'approval', type: 'gate', prompt: 'Approve?', autoAction: 'reject', timeoutMs: null },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const failedExecutions: Array<{ executionId: string; failedStepId?: string }> = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push({
          executionId: ctx.payload.executionId,
          failedStepId: ctx.payload.failedStepId,
        });
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id, inputs: {} });
    await vi.waitFor(() => expect(failedExecutions).toEqual([{ executionId, failedStepId: 'fail' }]), {
      timeout: 2_000,
    });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('failed');
  });

  it('persists terminalized sibling state before emitting its failed event', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-terminalized-event-after-persist',
      steps: [
        { id: 'fail', type: 'shell', command: ['sh', '-c', 'exit 7'] },
        { id: 'approval', type: 'gate', prompt: 'Approve?', autoAction: 'reject', timeoutMs: null },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const terminalizedSnapshots: Array<{ executionStatus?: string; approvalStatus?: string }> = [];
    setup.cleanupFns.push(
      MakaioBus.on(
        WorkflowSubjects.step.failed,
        async (ctx) => {
          const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
            executionId: ctx.payload.executionId,
          });
          terminalizedSnapshots.push({
            executionStatus: execution?.status,
            approvalStatus: execution?.steps.approval?.status,
          });
        },
        { filter: { stepId: 'approval' } },
      ),
    );

    const failedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id, inputs: {} });
    await vi.waitFor(() => expect(failedExecutions).toEqual([executionId]), { timeout: 2_000 });

    expect(terminalizedSnapshots).toEqual([{ executionStatus: 'failed', approvalStatus: 'failed' }]);
  });

  it('finalizes failure when a terminalized step failed listener throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const workflow = createWorkflowDefinition({
      id: 'workflow-terminalized-event-throws',
      steps: [
        { id: 'fail', type: 'shell', command: ['sh', '-c', 'exit 7'] },
        { id: 'approval', type: 'gate', prompt: 'Approve?', autoAction: 'reject', timeoutMs: null },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    setup.cleanupFns.push(
      MakaioBus.on(
        WorkflowSubjects.step.failed,
        () => {
          throw new Error('observer failed');
        },
        { filter: { stepId: 'approval' } },
      ),
    );

    const failedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id, inputs: {} });
    await vi.waitFor(() => expect(failedExecutions).toEqual([executionId]), { timeout: 2_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('failed');
    expect(execution?.steps.approval?.status).toBe('failed');
  });

  async function runWorkflowAndCaptureSpawnPayloads(
    workflowDef: Parameters<typeof createWorkflowDefinition>[0],
    inputs: Record<string, unknown> = {},
  ): Promise<z.input<typeof SpawnSubagentRpcRequestSchema>[]> {
    const spawnPayloads: z.input<typeof SpawnSubagentRpcRequestSchema>[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(
        SubagentSubjects.spawn,
        (ctx) => {
          spawnPayloads.push(ctx.payload);
        },
        { priority: 1_000 },
      ),
    );

    const workflow = createWorkflowDefinition(workflowDef);
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id, inputs });
    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    return spawnPayloads;
  }

  it('passes harnessId and contextMode from step to the spawn payload', async () => {
    const spawnPayloads = await runWorkflowAndCaptureSpawnPayloads(
      {
        id: 'workflow-spawn-governance',
        steps: [
          {
            id: 'review',
            type: 'agent' as const,
            prompt: 'Review {{ inputs.file }}',
            adapter: 'claude-code',
            harnessId: 'harness-reviewer',
            contextMode: 'fresh' as const,
          },
        ],
      },
      { file: 'README.md' },
    );

    expect(spawnPayloads).toHaveLength(1);
    expect(spawnPayloads[0]?.config).toMatchObject({
      task: 'Review README.md',
      adapterName: 'claude-code',
      harnessId: 'harness-reviewer',
      contextMode: 'fresh',
    });
  });

  it('defaults contextMode to fresh when not specified on the step', async () => {
    const spawnPayloads = await runWorkflowAndCaptureSpawnPayloads({
      id: 'workflow-spawn-default-context',
      steps: [
        {
          id: 'build',
          type: 'agent' as const,
          prompt: 'Build the project',
          adapter: 'claude-code',
        },
      ],
    });

    expect(spawnPayloads).toHaveLength(1);
    expect(spawnPayloads[0]?.config.contextMode).toBe('fresh');
  });
});
