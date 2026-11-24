import { createBusInstance } from '@makaio/bus-core';
import {
  WorkflowNamespace,
  codeStep,
  defineWorkflow,
  type WorkflowSequenceNode,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { runCallerLocalWorkflowOrchestrator, runWorkflowOrchestrator } from '../workflow-orchestrator.js';
import { createTestDbForBus } from './shared.js';

/**
 * Set up one runtime with real frame persistence.
 * @returns A run context and cleanup suitable for either runner.
 */
async function makeLoopRun() {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  const db = await createTestDbForBus(bus);
  const call = bus.own('root');
  const config: WorkflowWorkerConfig = {
    source: { kind: 'definition', workflowId: 'review' },
    executionId: 'execution',
    workflowId: 'review',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    env: {},
    coordinatorSessionId: 'coordinator',
    cancelSubject: 'workflow.execution.cancel',
  };
  return { bus, call, config, signal: new AbortController().signal, cleanup: db.cleanup };
}

describe('loops through a workflow step runner', () => {
  it('uses the check frame from each round and dispatches each body step only once', async () => {
    const { cleanup, ...runtime } = await makeLoopRun();
    const group: WorkflowSequenceNode = { id: 'group', type: 'sequence', nodes: [codeStep('check', () => false)] };
    const workflow = defineWorkflow('review').loop('converge', [group, codeStep('report', () => null)], {
      maxRounds: 3,
      check: 'check',
    });
    const seen: string[] = [];
    let rounds = 0;
    try {
      await expect(
        runWorkflowOrchestrator({
          ...runtime,
          loaded: { definition: workflow.definition },
          stepRunner: {
            async run(invocation) {
              seen.push(invocation.stepId);
              const output = invocation.stepId === 'check' ? { done: ++rounds === 2 } : rounds;
              return { status: 'completed', output, telemetry: { duration: 0 } };
            },
          },
        }),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(seen).toEqual(['check', 'report', 'check', 'report']);
      const { frames } = await runtime.bus.request(runtime.call, WorkflowStorageSubjects.listFrames, {
        executionId: runtime.config.executionId,
      });
      expect(frames.find((frame) => frame.nodeId === 'converge' && frame.iteration === undefined)?.output).toEqual({
        passed: true,
        rounds: 2,
        bodyOutputs: [1, 2],
      });
    } finally {
      cleanup();
    }
  });

  it('names unexpected keys in a strict convergence result', async () => {
    const { cleanup, ...runtime } = await makeLoopRun();
    const workflow = defineWorkflow('review').loop('converge', [codeStep('check', () => ({ done: true, extra: 1 }))], {
      maxRounds: 2,
      check: 'check',
    });
    try {
      await expect(runCallerLocalWorkflowOrchestrator({ ...runtime, loaded: workflow })).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('"extra"'),
      });
    } finally {
      cleanup();
    }
  });

  it.each([
    { onExhausted: 'complete', status: 'completed' },
    { onExhausted: 'fail', status: 'failed' },
    { onExhausted: undefined, status: 'failed' },
  ] as const)('honors caller-local exhaustion policy $onExhausted', async ({ onExhausted, status }) => {
    const { cleanup, ...runtime } = await makeLoopRun();
    const check = vi.fn(() => ({ done: false }));
    const workflow = defineWorkflow('review').loop('converge', [codeStep('check', check)], {
      maxRounds: 2,
      check: 'check',
      onExhausted,
    });
    try {
      await expect(runCallerLocalWorkflowOrchestrator({ ...runtime, loaded: workflow })).resolves.toMatchObject({
        status,
        ...(status === 'failed' && { error: expect.stringContaining('exhausted maxRounds (2)') }),
      });
      expect(check).toHaveBeenCalledTimes(2);
      if (status === 'completed') {
        const { frames } = await runtime.bus.request(runtime.call, WorkflowStorageSubjects.listFrames, {
          executionId: runtime.config.executionId,
        });
        expect(frames.find((frame) => frame.nodeId === 'converge' && frame.iteration === undefined)?.output).toEqual({
          passed: false,
          rounds: 2,
          bodyOutputs: [{ done: false }, { done: false }],
        });
      }
    } finally {
      cleanup();
    }
  });
});
