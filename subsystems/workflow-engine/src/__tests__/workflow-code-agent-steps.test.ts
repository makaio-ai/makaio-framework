import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  codeStep,
  defineWorkflow,
  SubagentSubjects,
  WorkflowNamespace,
  WorkflowSubjects,
  WorkflowFrameStateSchema,
  type BuiltWorkflow,
  type WorkflowFrameState,
} from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { createRuntimeContext } from '../runtime/runtime-context.js';
import { executeSequence } from '../runtime/primitive-runtime.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowExecution } from './shared.js';

interface WorkflowScenario {
  workflow: BuiltWorkflow;
  calls: string[];
  items: unknown[];
  chainItems: unknown[];
}

/** Build a workflow exercising every execution container with the two step forms. */
function createScenario(): WorkflowScenario {
  const calls: string[] = [];
  const items: unknown[] = [];
  const chainItems: unknown[] = [];
  const workflow = defineWorkflow('code-agent-primitives')
    .codeStep('prepare', () => {
      calls.push('prepare');
      return { items: ['alpha', 'beta'] };
    })
    .agentStep('review', 'reviewer', { prompt: 'Review {{ output.items }}', timeoutMs: 1_000 })
    .parallel('branches', {}, [
      codeStep('active-branch', () => {
        calls.push('active-branch');
        return 'active';
      }),
      codeStep(
        'skipped-branch',
        () => {
          calls.push('skipped-branch');
          return 'unexpected';
        },
        { when: 'false' },
      ),
    ])
    .iterate(
      'items',
      (ctx) => {
        items.push(ctx.item);
        return { item: ctx.item };
      },
      { collection: "previousSteps['prepare'].output.items" },
    )
    .iterateChain(
      'chain',
      [
        codeStep('chain-first', (ctx) => {
          chainItems.push(ctx.item);
          calls.push('chain-first');
          return { item: ctx.item };
        }),
        codeStep('chain-second', (ctx) => {
          chainItems.push(ctx.previousSteps['chain-first']?.output);
          calls.push('chain-second');
          return 'chained';
        }),
      ],
      { collection: "previousSteps['prepare'].output.items" },
    )
    .codeStep('finish', () => {
      calls.push('finish');
      return 'finished';
    });
  return { workflow, calls, items, chainItems };
}

/**
 * Check terminal runtime frames and their persisted counterparts.
 * @param runtime - Context used by the real sequence executor.
 * @param persisted - Last persisted snapshot of every observed frame.
 */
function assertFrames(
  runtime: ReturnType<typeof createRuntimeContext>,
  persisted: ReadonlyMap<string, WorkflowFrameState>,
): void {
  for (const [nodeId, nodeType, count, status] of [
    ['prepare', 'code-step', 1, 'completed'],
    ['review', 'agent-step', 1, 'completed'],
    ['active-branch', 'code-step', 1, 'completed'],
    ['skipped-branch', 'code-step', 1, 'skipped'],
    ['items__item', 'code-step', 2, 'completed'],
    ['chain-first', 'code-step', 2, 'completed'],
    ['chain-second', 'code-step', 2, 'completed'],
    ['finish', 'code-step', 1, 'completed'],
  ] as const) {
    const frames = runtime.getFramesByNodeId(nodeId);
    expect(frames, nodeId).toHaveLength(count);
    for (const frame of frames) {
      expect(frame).toMatchObject({ nodeId, nodeType, status });
      expect(persisted.get(frame.frameId)).toMatchObject({ nodeId, nodeType, status });
    }
  }
  for (const [nodeId, nodeType] of [
    ['branches', 'parallel'],
    ['items', 'iterate'],
    ['chain', 'iterate-chain'],
  ] as const) {
    const frames = runtime.getFramesByNodeId(nodeId);
    expect(frames.length, nodeId).toBeGreaterThan(0);
    for (const frame of frames) expect(frame).toMatchObject({ nodeType, status: 'completed' });
  }
  const allowedTypes = ['code-step', 'agent-step', 'sequence', 'parallel', 'iterate', 'iterate-chain'];
  for (const frame of persisted.values()) {
    expect(allowedTypes).toContain(frame.nodeType);
    expect(['completed', 'skipped']).toContain(frame.status);
  }
}

describe('workflow code and agent steps across execution primitives', () => {
  it('completes a sequence with code and agent steps, conditional parallel branches and iterations', async () => {
    const scenario = createScenario();
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    const persisted = new Map<string, WorkflowFrameState>();
    const cleanups = [
      bus.on(WorkflowStorageSubjects.setFrame, (ctx) => {
        persisted.set(ctx.payload.frame.frameId, structuredClone(WorkflowFrameStateSchema.parse(ctx.payload.frame)));
        ctx.setResult({ frameId: ctx.payload.frame.frameId });
      }),
      bus.on(WorkflowSubjects.resolveRole, (ctx) => {
        expect(ctx.payload.roleId).toBe('reviewer');
        scenario.calls.push('resolve-role');
        ctx.setResult({ adapterName: 'claude-code', model: 'sonnet', contextMode: 'fresh' });
      }),
      bus.on(SubagentSubjects.spawn, (ctx) => {
        expect(ctx.payload.config).toMatchObject({ task: 'Review [\n  "alpha",\n  "beta"\n]' });
        scenario.calls.push('spawn-agent');
        ctx.setResult({ subagentId: 'review-subagent', status: 'spawning' });
      }),
      bus.on(SubagentSubjects.await, (ctx) => {
        expect(ctx.payload).toEqual({ subagentId: 'review-subagent', timeoutMs: 1_000 });
        scenario.calls.push('await-agent');
        ctx.setResult({ status: 'completed', result: 'reviewed' });
      }),
    ];
    const execution = createWorkflowExecution({ workflowId: scenario.workflow.id });
    const runtime = createRuntimeContext(
      scenario.workflow,
      execution,
      bus,
      new AbortController().signal,
      createTestCall(),
    );

    try {
      const outcome = await executeSequence(
        createTestCall(),
        scenario.workflow.definition.root,
        runtime,
        runtime.buildExpressionContext(),
      );

      expect(outcome).toEqual({ status: 'completed' });
      expect(scenario.calls).toEqual([
        'prepare',
        'resolve-role',
        'spawn-agent',
        'await-agent',
        'active-branch',
        'chain-first',
        'chain-second',
        'chain-first',
        'chain-second',
        'finish',
      ]);
      expect(scenario.items).toHaveLength(2);
      expect(scenario.items).toEqual(expect.arrayContaining(['alpha', 'beta']));
      expect(scenario.chainItems).toEqual(['alpha', { item: 'alpha' }, 'beta', { item: 'beta' }]);

      assertFrames(runtime, persisted);
      expect(runtime.getFramesByNodeId('review')[0]?.output).toBe('reviewed');
      expect(runtime.getFramesByNodeId('finish')[0]?.output).toBe('finished');
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  });
});
