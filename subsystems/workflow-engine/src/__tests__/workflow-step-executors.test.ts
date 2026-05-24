import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SubagentSubjects } from '@makaio/contracts';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { WorkflowGateCoordinator } from '../workflow-gate-coordinator.js';
import { executeAgentStep } from '../workflow-step-executors.js';
import type { ActiveExecution } from '../types.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

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
          config: { stepCooldownMs: 0, stepTimeoutMs: 10_000 },
        },
        execution.id,
        'agent',
      );

      expect(result).toMatchObject({ status: 'failed', error: 'Execution cancelled' });
    } finally {
      cleanups.forEach((cleanup) => cleanup());
    }
  });
});
