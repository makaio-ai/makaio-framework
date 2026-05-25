import { describe, it, expect, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { WorkflowWorkerConfig, JsonValue, WorkflowExecution } from '@makaio/contracts';
import {
  defineWorkflow,
  ManualWorkflowTrigger,
  SubagentSubjects,
  WorkflowNamespace,
  WorkflowSubjects,
} from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import type { LoadedWorkflow } from '../workflow-orchestrator.js';
import { runWorkflowOrchestrator } from '../workflow-orchestrator.js';
import { executeAgentStepInWorker, executeFunctionStep } from '../workflow-step-execution.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal WorkflowWorkerConfig for orchestrator tests.
 * @param overrides - Optional field overrides.
 * @returns Valid WorkflowWorkerConfig stub.
 */
function makeConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return {
    source: { kind: 'path', path: '/tmp/workflow.mjs' },
    executionId: 'exec-orch-001',
    workflowId: 'wf-orch-001',
    triggerPayload: { event: 'push' },
    inputs: { branch: 'main' },
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    context: {
      repoPath: '/repo',
      makaioHome: '/home/.makaio',
      os: 'linux',
      arch: 'x64',
    },
    env: { CI: 'true' },
    coordinatorSessionId: 'session-orch-001',
    cancelSubject: 'workflow.cancel.wf-orch-001',
    ...overrides,
  };
}

/**
 * Register in-memory workflow storage handlers on a bus instance.
 *
 * Provides the minimum storage surface required by the scheduler:
 * `setExecution`, `updateExecution`, and `setSpan`. Execution records are
 * held in a local Map so tests can inspect them after the fact.
 * @param bus - Bus instance to register handlers on.
 * @returns Tuple of cleanup function and execution store Map.
 */
function registerInMemoryStorage(
  bus: ReturnType<typeof createBusInstance>,
): [() => void, Map<string, WorkflowExecution>] {
  const executions = new Map<string, WorkflowExecution>();

  const offSet = bus.on(WorkflowStorageSubjects.setExecution, (ctx) => {
    // Cast: bus infers a structurally identical type from WorkflowExecutionSchema,
    // but TypeScript cannot unify two z.infer results for discriminated-union fields.
    // See storage/handler.ts for the same pattern used in production.
    const execution = ctx.payload.execution as WorkflowExecution;
    executions.set(execution.id, execution);
    ctx.setResult({ id: execution.id });
  });

  const offUpdate = bus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
    const { executionId, status, error, completedAt, stepUpdates } = ctx.payload;
    const execution = executions.get(executionId);
    if (!execution) {
      ctx.setResult({ success: false });
      return;
    }
    if (status !== undefined) execution.status = status;
    if (error !== undefined) execution.error = error ?? undefined;
    if (completedAt !== undefined) execution.completedAt = completedAt ?? undefined;
    if (stepUpdates) {
      Object.assign(execution.steps, stepUpdates);
    }
    ctx.setResult({ success: true });
  });

  const offSpan = bus.on(WorkflowStorageSubjects.setSpan, (ctx) => {
    // Accept and discard span records — tests do not inspect telemetry spans.
    ctx.setResult({ id: ctx.payload.span.stepId });
  });

  const cleanup = (): void => {
    offSet();
    offUpdate();
    offSpan();
  };

  return [cleanup, executions];
}

/**
 * Create an isolated bus instance with the workflow namespaces registered
 * and in-memory storage handlers attached.
 * @returns Tuple of bus instance, storage cleanup, and execution store.
 */
function makeBusWithStorage(): [ReturnType<typeof createBusInstance>, () => void, Map<string, WorkflowExecution>] {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  const [cleanup, executions] = registerInMemoryStorage(bus);
  return [bus, cleanup, executions];
}

/**
 * Build a LoadedWorkflow with a zero-step definition.
 * @returns LoadedWorkflow with no steps.
 */
function makeEmptyWorkflow(): LoadedWorkflow {
  return {
    definition: {
      id: 'wf-orch-001',
      name: 'Orchestrator Test',
      steps: [],
      triggers: [],
      scope: { type: 'global' },
    },
    runtimeSteps: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runWorkflowOrchestrator', () => {
  it('returns completed status for a workflow with no steps', async () => {
    const [bus, cleanup, executions] = makeBusWithStorage();
    const completedEvents: Array<ExtractSubjectPayload<typeof WorkflowSubjects.execution.completed>> = [];
    const offCompleted = bus.on(WorkflowSubjects.execution.completed, (ctx) => {
      completedEvents.push(ctx.payload);
    });

    try {
      const result = await runWorkflowOrchestrator({
        config: makeConfig(),
        loaded: makeEmptyWorkflow(),
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect(result.executionId).toBe('exec-orch-001');
      expect(result.workflowId).toBe('wf-orch-001');
      expect(executions.get('exec-orch-001')?.status).toBe('completed');
      expect(completedEvents).toEqual([{ executionId: 'exec-orch-001', totalDuration: expect.any(Number) }]);
    } finally {
      offCompleted();
      cleanup();
    }
  });

  it('persists the resolved execution scope from worker config', async () => {
    const [bus, cleanup, executions] = makeBusWithStorage();

    try {
      await runWorkflowOrchestrator({
        config: makeConfig({ scope: { type: 'external', kind: 'project', id: 'proj-1' } }),
        loaded: makeEmptyWorkflow(),
        bus,
        signal: new AbortController().signal,
      });

      expect(executions.get('exec-orch-001')?.scope).toEqual({ type: 'external', kind: 'project', id: 'proj-1' });
    } finally {
      cleanup();
    }
  });

  it('executes two dependent function steps and returns completed with results', async () => {
    const workflow = defineWorkflow('wf-orch-001', {
      name: 'Orchestrator Test',
      triggers: [ManualWorkflowTrigger()],
    });

    const firstStep = workflow.addStep('step-1', () => ({ message: 'Hello World' }), { needs: [] });
    workflow.addStep(
      'step-2',
      (ctx) => {
        const previous = ctx.previousSteps['step-1'];
        if (previous.status !== 'completed') {
          throw new Error('step-1 should have completed');
        }
        return { length: previous.output.message.length };
      },
      {
        needs: [firstStep],
      },
    );

    const loaded: LoadedWorkflow = {
      definition: workflow.definition,
      runtimeSteps: workflow.runtimeSteps,
    };

    const [bus, cleanup] = makeBusWithStorage();
    const persistedSteps: Record<string, { result: JsonValue | undefined }> = {};

    // Collect step.completed events to verify step results and lifecycle events.
    bus.on(WorkflowSubjects.step.completed, (ctx) => {
      persistedSteps[ctx.payload.stepId] = { result: ctx.payload.result ?? undefined };
    });

    try {
      const result = await runWorkflowOrchestrator({
        config: makeConfig(),
        loaded,
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect(persistedSteps['step-1'].result).toEqual({ message: 'Hello World' });
      expect(persistedSteps['step-2'].result).toEqual({ length: 11 });
    } finally {
      cleanup();
    }
  });

  it('preserves skipped dependencies in function previousSteps', async () => {
    const workflow = defineWorkflow('wf-orch-001', {
      name: 'Skipped Dependency Test',
      triggers: [ManualWorkflowTrigger()],
    });

    const optionalStep = workflow.addStep('optional-step', () => ({ skipped: false }), { needs: [], if: 'false' });
    workflow.addStep(
      'consumer-step',
      (ctx) => ({
        optionalStatus: ctx.previousSteps['optional-step'].status,
        optionalOutputPresent: 'output' in ctx.previousSteps['optional-step'],
      }),
      { needs: [optionalStep] },
    );

    const loaded: LoadedWorkflow = {
      definition: workflow.definition,
      runtimeSteps: workflow.runtimeSteps,
    };
    const [bus, cleanup] = makeBusWithStorage();
    const completedSteps: Record<string, JsonValue | undefined> = {};
    const offCompleted = bus.on(WorkflowSubjects.step.completed, (ctx) => {
      completedSteps[ctx.payload.stepId] = ctx.payload.result ?? undefined;
    });

    try {
      const result = await runWorkflowOrchestrator({
        config: makeConfig(),
        loaded,
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect(completedSteps['consumer-step']).toEqual({
        optionalStatus: 'skipped',
        optionalOutputPresent: false,
      });
    } finally {
      offCompleted();
      cleanup();
    }
  });

  it('returns failed status for agent step when subagent system is unavailable', async () => {
    // The isolated test bus has no SubagentSubjects.spawn handler registered,
    // so requestOptional returns { handled: false } → step fails.
    const [bus, cleanup] = makeBusWithStorage();

    const loaded: LoadedWorkflow = {
      definition: {
        id: 'wf-orch-001',
        name: 'Agent Test',
        steps: [{ type: 'agent', id: 'agent-step', prompt: 'do the thing' }],
        triggers: [],
        scope: { type: 'global' },
      },
      runtimeSteps: new Map(),
    };

    try {
      const result = await runWorkflowOrchestrator({
        config: makeConfig(),
        loaded,
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failed');
      expect(typeof result.output).toBe('string');
      expect(result.output).toMatch(/subagent/i);
    } finally {
      cleanup();
    }
  });

  it('returns failed status instead of rejecting for invalid step dependency graphs', async () => {
    const [bus, cleanup, executions] = makeBusWithStorage();

    const loaded: LoadedWorkflow = {
      definition: {
        id: 'wf-orch-001',
        name: 'Invalid Graph Test',
        steps: [
          { type: 'agent', id: 'a', prompt: 'A', needs: ['b'] },
          { type: 'agent', id: 'b', prompt: 'B', needs: ['a'] },
        ],
        triggers: [],
        scope: { type: 'global' },
      },
      runtimeSteps: new Map(),
    };

    try {
      const result = await runWorkflowOrchestrator({
        config: makeConfig(),
        loaded,
        bus,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        executionId: 'exec-orch-001',
        workflowId: 'wf-orch-001',
        status: 'failed',
      });
      expect(result.output).toBe('Cycle detected in workflow step dependencies');
      expect(executions.get('exec-orch-001')?.status).toBe('failed');
    } finally {
      cleanup();
    }
  });

  it('returns failed status for shell step when workspace root does not exist', async () => {
    // Config uses repoPath '/repo' which does not exist on the test host —
    // resolveShellCwd returns null → step fails with a path error.
    const [bus, cleanup] = makeBusWithStorage();

    const loaded: LoadedWorkflow = {
      definition: {
        id: 'wf-orch-001',
        name: 'Shell Test',
        steps: [{ type: 'shell', id: 'shell-step', command: ['echo', 'hello'] }],
        triggers: [],
        scope: { type: 'global' },
      },
      runtimeSteps: new Map(),
    };

    try {
      const result = await runWorkflowOrchestrator({
        config: makeConfig(),
        loaded,
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failed');
    } finally {
      cleanup();
    }
  });

  it('returns failed status for gate step when gate.awaitApproval handler is absent', async () => {
    // The isolated test bus has no WorkflowSubjects.gate.awaitApproval handler,
    // so the RPC throws → step fails. The scheduler's runGateStep path calls
    // executeGateStepInWorker which sends the awaitApproval RPC.
    const [bus, cleanup] = makeBusWithStorage();

    const loaded: LoadedWorkflow = {
      definition: {
        id: 'wf-orch-001',
        name: 'Gate Test',
        steps: [
          {
            type: 'gate',
            id: 'gate-step',
            prompt: 'Approve?',
            autoAction: 'reject',
            timeoutMs: 60_000,
          },
        ],
        triggers: [],
        scope: { type: 'global' },
      },
      runtimeSteps: new Map(),
    };

    try {
      const result = await runWorkflowOrchestrator({
        config: makeConfig(),
        loaded,
        bus,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failed');
    } finally {
      cleanup();
    }
  });

  it('returns cancelled status when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const [bus, cleanup, executions] = makeBusWithStorage();
    const cancelledEvents: Array<ExtractSubjectPayload<typeof WorkflowSubjects.execution.cancelled>> = [];
    const offCancelled = bus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
      cancelledEvents.push(ctx.payload);
    });

    try {
      const result = await runWorkflowOrchestrator({
        config: makeConfig(),
        loaded: {
          definition: {
            id: 'wf-orch-001',
            name: 'Abort Test',
            steps: [{ type: 'agent', id: 'agent-step', prompt: 'never run' }],
            triggers: [],
            scope: { type: 'global' },
          },
          runtimeSteps: new Map(),
        },
        bus,
        signal: controller.signal,
      });

      expect(result.status).toBe('cancelled');
      const execution = executions.get('exec-orch-001');
      expect(execution?.status).toBe('cancelled');
      expect(execution?.steps['agent-step']).toMatchObject({ kind: 'executable', status: 'failed' });
      expect(cancelledEvents).toEqual([{ executionId: 'exec-orch-001', reason: 'Workflow cancelled' }]);
    } finally {
      offCancelled();
      cleanup();
    }
  });

  it('cancels an in-flight worker function step when the signal aborts', async () => {
    const controller = new AbortController();
    const [bus, cleanup, executions] = makeBusWithStorage();
    let functionSawAbort = false;

    try {
      const resultPromise = runWorkflowOrchestrator({
        config: makeConfig(),
        loaded: {
          definition: {
            id: 'wf-orch-001',
            name: 'Abort Running Test',
            steps: [{ type: 'function', id: 'wait', runtime: true }],
            triggers: [],
            scope: { type: 'global' },
          },
          runtimeSteps: new Map([
            [
              'wait',
              (ctx) =>
                new Promise((resolve) => {
                  if (ctx.signal.aborted) {
                    functionSawAbort = true;
                    resolve('cancelled');
                    return;
                  }
                  ctx.signal.addEventListener(
                    'abort',
                    () => {
                      functionSawAbort = true;
                      resolve('cancelled');
                    },
                    { once: true },
                  );
                }),
            ],
          ]),
        },
        bus,
        signal: controller.signal,
      });

      await vi.waitFor(() => expect(executions.get('exec-orch-001')?.steps['wait']?.status).toBe('running'));
      controller.abort();

      const result = await resultPromise;
      const execution = executions.get('exec-orch-001');

      expect(result.status).toBe('cancelled');
      expect(execution?.status).toBe('cancelled');
      expect(execution?.steps['wait']).toMatchObject({ kind: 'executable', status: 'failed' });
      expect(functionSawAbort).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('executeFunctionStep', () => {
  it('observes cancellation that happens while the function step is starting', async () => {
    const controller = new AbortController();

    const result = await executeFunctionStep({
      loaded: {
        definition: makeEmptyWorkflow().definition,
        runtimeSteps: new Map([
          [
            'wait',
            () => {
              controller.abort();
              return new Promise<JsonValue>(() => {});
            },
          ],
        ]),
      },
      stepId: 'wait',
      context: {
        repoPath: '/repo',
        makaioHome: '/home/.makaio',
        os: 'linux',
        arch: 'x64',
        inputs: {},
        env: {},
        executionId: 'exec-orch-001',
        workflowId: 'wf-orch-001',
        trigger: {},
        previousSteps: {},
        signal: controller.signal,
      },
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: 'failed', error: 'Workflow cancelled' });
  });
});

describe('executeAgentStepInWorker', () => {
  it('does not spawn when the signal is already aborted', async () => {
    const [bus, cleanup] = makeBusWithStorage();
    const controller = new AbortController();
    controller.abort();
    let spawnCalled = false;
    const offSpawn = bus.on(SubagentSubjects.spawn, (ctx) => {
      spawnCalled = true;
      ctx.setResult({ subagentId: 'subagent-aborted', status: 'spawning' });
    });

    try {
      const result = await executeAgentStepInWorker({
        step: { type: 'agent', id: 'agent-step', prompt: 'do it' },
        bus,
        coordinatorSessionId: 'session-orch-001',
        signal: controller.signal,
        resolvedPrompt: 'do it',
      });

      expect(result).toMatchObject({ status: 'failed', error: 'Workflow cancelled' });
      expect(spawnCalled).toBe(false);
    } finally {
      offSpawn();
      cleanup();
    }
  });

  it('resolves role-backed agent config before spawning in the worker path', async () => {
    const [bus, cleanup] = makeBusWithStorage();
    const spawnPayloads: Array<ExtractSubjectPayload<typeof SubagentSubjects.spawn>> = [];

    const offRole = bus.on(WorkflowSubjects.resolveRole, (ctx) => {
      expect(ctx.payload).toEqual({ roleId: 'reviewer' });
      ctx.setResult({
        adapterName: 'role-adapter',
        model: 'role-model',
        harnessId: 'role-harness',
        contextMode: 'fork',
        systemPrompt: 'Review carefully.',
        providerContext: {
          providerConfigId: 'provider-1',
          definitionId: 'anthropic-default',
          credentialRefs: {},
        },
      });
    });
    const offSpawn = bus.on(SubagentSubjects.spawn, (ctx) => {
      spawnPayloads.push(ctx.payload);
      ctx.setResult({ subagentId: 'subagent-role', status: 'spawning' });
    });
    const offAwait = bus.on(SubagentSubjects.await, (ctx) => {
      ctx.setResult({ status: 'completed', result: `completed:${ctx.payload.subagentId}` });
    });

    try {
      const result = await executeAgentStepInWorker({
        step: { type: 'agent', id: 'agent-step', prompt: 'Review', role: 'reviewer' },
        bus,
        coordinatorSessionId: 'session-orch-001',
        signal: new AbortController().signal,
        resolvedPrompt: 'Review',
      });

      expect(result.status).toBe('completed');
      expect(spawnPayloads).toHaveLength(1);
      expect(spawnPayloads[0]?.config).toMatchObject({
        task: 'Review',
        adapterName: 'role-adapter',
        model: 'role-model',
        harnessId: 'role-harness',
        contextMode: 'fork',
        systemPrompt: 'Review carefully.',
        providerContext: {
          providerConfigId: 'provider-1',
          definitionId: 'anthropic-default',
          credentialRefs: {},
        },
      });
    } finally {
      offAwait();
      offSpawn();
      offRole();
      cleanup();
    }
  });

  it('normalizes await RPC errors and kills the spawned subagent', async () => {
    const [bus, cleanup] = makeBusWithStorage();
    const killedSubagents: string[] = [];

    const offSpawn = bus.on(SubagentSubjects.spawn, (ctx) => {
      ctx.setResult({ subagentId: 'subagent-await-error', status: 'spawning' });
    });
    const offAwait = bus.on(SubagentSubjects.await, () => {
      throw new Error('await unavailable');
    });
    const offKill = bus.on(SubagentSubjects.kill, (ctx) => {
      killedSubagents.push(ctx.payload.subagentId);
      ctx.setResult({ killed: true });
    });

    try {
      const result = await executeAgentStepInWorker({
        step: { type: 'agent', id: 'agent-step', prompt: 'Run', adapter: 'claude-code' },
        bus,
        coordinatorSessionId: 'session-orch-001',
        signal: new AbortController().signal,
        resolvedPrompt: 'Run',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('await unavailable');
      expect(killedSubagents).toEqual(['subagent-await-error']);
    } finally {
      offKill();
      offAwait();
      offSpawn();
      cleanup();
    }
  });

  it('kills a spawned subagent when cancellation is observed before await listener setup', async () => {
    const [bus, cleanup] = makeBusWithStorage();
    const controller = new AbortController();
    const killedSubagents: string[] = [];
    let awaitCalled = false;

    const offSpawn = bus.on(SubagentSubjects.spawn, (ctx) => {
      ctx.setResult({ subagentId: 'subagent-race', status: 'spawning' });
      controller.abort();
    });
    const offAwait = bus.on(SubagentSubjects.await, (ctx) => {
      awaitCalled = true;
      ctx.setResult({ status: 'completed', result: ctx.payload.subagentId });
    });
    const offKill = bus.on(SubagentSubjects.kill, (ctx) => {
      killedSubagents.push(ctx.payload.subagentId);
      ctx.setResult({ killed: true });
    });

    try {
      const promise = executeAgentStepInWorker({
        step: { type: 'agent', id: 'agent-step', prompt: 'Run', adapter: 'claude-code' },
        bus,
        coordinatorSessionId: 'session-orch-001',
        signal: controller.signal,
        resolvedPrompt: 'Run',
      });

      const result = await promise;

      expect(result).toMatchObject({ status: 'failed', error: 'Workflow cancelled' });
      expect(killedSubagents).toEqual(['subagent-race']);
      expect(awaitCalled).toBe(false);
    } finally {
      offKill();
      offAwait();
      offSpawn();
      cleanup();
    }
  });
});
