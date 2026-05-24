import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SubagentSubjects } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { WorkflowGateCoordinator } from '../workflow-gate-coordinator.js';
import { executeAgentStep } from '../workflow-step-executors.js';
import type { ActiveExecution } from '../types.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

type SpawnSubagentPayload = ExtractSubjectPayload<typeof SubagentSubjects.spawn>;

describe('workflow step executors', () => {
  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('returns cancellation when an agent step is cancelled while awaiting the subagent', async () => {
    MakaioBus.__resetHandlers?.();
    const cleanups: Array<() => void> = [];

    const workflow = createWorkflowDefinition({
      id: 'workflow-agent-cancel-during-await',
      steps: [{ id: 'agent', type: 'agent', prompt: 'Run agent', adapter: 'claude-code' }],
    });
    const execution = createWorkflowExecution({
      id: 'execution-agent-cancel-during-await',
      workflowId: workflow.id,
      coordinatorSessionId: 'coordinator-session',
      steps: {
        agent: { kind: 'executable', status: 'pending' },
      },
    });
    const activeExecutions = new Map<string, ActiveExecution>([
      [
        execution.id,
        {
          execution,
          workflow: { ...workflow, createdAt: 0, updatedAt: 0 },
          stepMap: new Map(workflow.steps.map((step) => [step.id, step])),
          stepContext: new Map(),
        },
      ],
    ]);

    cleanups.push(
      MakaioBus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
        ctx.setResult({ success: ctx.payload.executionId === execution.id });
      }),
    );
    cleanups.push(
      MakaioBus.on(SubagentSubjects.spawn, (ctx) => {
        ctx.setResult({ subagentId: 'subagent-agent', status: 'spawning' });
      }),
    );
    cleanups.push(
      MakaioBus.on(SubagentSubjects.await, (ctx) => {
        execution.status = 'cancelled';
        ctx.setResult({ status: 'completed', result: `completed:${ctx.payload.subagentId}` });
      }),
    );

    try {
      const result = await executeAgentStep(
        {
          bus: MakaioBus,
          activeExecutions,
          shellAbortControllers: new Map(),
          gateCoordinator: new WorkflowGateCoordinator(MakaioBus),
          config: {
            stepCooldownMs: 0,
            stepTimeoutMs: 10_000,
            busAuth: { kind: 'none' },
            platformDefaults: { cwd: '.' },
            cancelTimeoutMs: 10_000,
          },
        },
        execution.id,
        'agent',
      );

      expect(result).toMatchObject({ status: 'failed', error: 'Execution cancelled' });
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });

  it('resolves role-based agent steps before spawning the subagent', async () => {
    MakaioBus.__resetHandlers?.();
    const cleanups: Array<() => void> = [];
    const spawnPayloads: SpawnSubagentPayload[] = [];

    const workflow = createWorkflowDefinition({
      id: 'workflow-agent-role-resolution',
      steps: [
        {
          id: 'agent',
          type: 'agent',
          prompt: 'Review {{ inputs.file }}',
          role: 'reviewer',
          adapter: 'inline-adapter',
          model: 'inline-model',
          harnessId: 'inline-harness',
          contextMode: 'fork',
        },
      ],
    });
    const execution = createWorkflowExecution({
      id: 'execution-agent-role-resolution',
      workflowId: workflow.id,
      coordinatorSessionId: 'coordinator-session',
      inputs: { file: 'README.md' },
      steps: {
        agent: { kind: 'executable', status: 'pending' },
      },
    });
    const activeExecutions = new Map<string, ActiveExecution>([
      [
        execution.id,
        {
          execution,
          workflow: { ...workflow, createdAt: 0, updatedAt: 0 },
          stepMap: new Map(workflow.steps.map((step) => [step.id, step])),
          stepContext: new Map(),
        },
      ],
    ]);

    cleanups.push(
      MakaioBus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
        ctx.setResult({ success: ctx.payload.executionId === execution.id });
      }),
    );
    cleanups.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        expect(ctx.payload).toEqual({ roleId: 'reviewer' });
        ctx.setResult({
          adapterName: 'role-adapter',
          model: 'role-model',
          harnessId: 'role-harness',
          systemPrompt: 'Use the reviewer persona.',
          contextMode: 'fresh',
          providerContext: {
            providerConfigId: 'provider-1',
            definitionId: 'anthropic-default',
            credentialRefs: {},
          },
        });
      }),
    );
    cleanups.push(
      MakaioBus.on(SubagentSubjects.spawn, (ctx) => {
        spawnPayloads.push(ctx.payload);
        ctx.setResult({ subagentId: 'subagent-agent', status: 'spawning' });
      }),
    );
    cleanups.push(
      MakaioBus.on(SubagentSubjects.await, (ctx) => {
        ctx.setResult({ status: 'completed', result: `completed:${ctx.payload.subagentId}` });
      }),
    );

    try {
      const result = await executeAgentStep(
        {
          bus: MakaioBus,
          activeExecutions,
          shellAbortControllers: new Map(),
          gateCoordinator: new WorkflowGateCoordinator(MakaioBus),
          config: {
            stepCooldownMs: 0,
            stepTimeoutMs: 10_000,
            busAuth: { kind: 'none' },
            platformDefaults: { cwd: '.' },
            cancelTimeoutMs: 10_000,
          },
        },
        execution.id,
        'agent',
      );

      expect(result.status).toBe('completed');
      expect(spawnPayloads).toHaveLength(1);
      expect(spawnPayloads[0]?.config).toMatchObject({
        task: 'Review README.md',
        adapterName: 'role-adapter',
        model: 'role-model',
        harnessId: 'role-harness',
        systemPrompt: 'Use the reviewer persona.',
        contextMode: 'fresh',
        providerContext: {
          providerConfigId: 'provider-1',
          definitionId: 'anthropic-default',
          credentialRefs: {},
        },
      });
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });

  it('does not spawn when role resolution observes workflow cancellation', async () => {
    MakaioBus.__resetHandlers?.();
    const cleanups: Array<() => void> = [];
    let spawnCalled = false;

    const workflow = createWorkflowDefinition({
      id: 'workflow-agent-role-cancelled',
      steps: [{ id: 'agent', type: 'agent', prompt: 'Review', role: 'reviewer' }],
    });
    const execution = createWorkflowExecution({
      id: 'execution-agent-role-cancelled',
      workflowId: workflow.id,
      coordinatorSessionId: 'coordinator-session',
      steps: {
        agent: { kind: 'executable', status: 'pending' },
      },
    });
    const activeExecutions = new Map<string, ActiveExecution>([
      [
        execution.id,
        {
          execution,
          workflow: { ...workflow, createdAt: 0, updatedAt: 0 },
          stepMap: new Map(workflow.steps.map((step) => [step.id, step])),
          stepContext: new Map(),
        },
      ],
    ]);

    cleanups.push(
      MakaioBus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
        ctx.setResult({ success: ctx.payload.executionId === execution.id });
      }),
    );
    cleanups.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        execution.status = 'cancelled';
        ctx.setResult({ adapterName: 'role-adapter' });
      }),
    );
    cleanups.push(
      MakaioBus.on(SubagentSubjects.spawn, (ctx) => {
        spawnCalled = true;
        ctx.setResult({ subagentId: 'subagent-agent', status: 'spawning' });
      }),
    );

    try {
      const result = await executeAgentStep(
        {
          bus: MakaioBus,
          activeExecutions,
          shellAbortControllers: new Map(),
          gateCoordinator: new WorkflowGateCoordinator(MakaioBus),
          config: {
            stepCooldownMs: 0,
            stepTimeoutMs: 10_000,
            busAuth: { kind: 'none' },
            platformDefaults: { cwd: '.' },
            cancelTimeoutMs: 10_000,
          },
        },
        execution.id,
        'agent',
      );

      expect(result).toMatchObject({ status: 'failed', error: 'Execution cancelled' });
      expect(spawnCalled).toBe(false);
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });
});
