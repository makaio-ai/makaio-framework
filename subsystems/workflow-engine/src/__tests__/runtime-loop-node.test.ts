import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import {
  WorkflowNamespace,
  type CodeStepHandler,
  type JsonValue,
  type LoopCheckContext,
  type LoopCheckHandler,
  type LoopCheckOutcome,
  type WorkflowCodeStepNode,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowLoopNode,
  type WorkflowSequenceNode,
} from '@makaio/contracts';
import { RuntimeContext } from '../runtime/runtime-context.js';
import { executeSequence } from '../runtime/primitive-runtime.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { registerInMemoryFrameStore } from './shared.js';

// -----------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------

/**
 * Create a minimal WorkflowDefinition for tests.
 * @param id - Workflow identifier.
 * @returns Minimal definition with an empty root sequence.
 */
function makeDefinition(id: string): WorkflowDefinition {
  return {
    id,
    root: { id: `${id}__root`, type: 'sequence', nodes: [] },
    scope: { type: 'global' },
  };
}

/**
 * Create a minimal WorkflowExecution for tests.
 * @param workflowId - Workflow identifier.
 * @returns Minimal execution record.
 */
function makeExecution(workflowId: string): WorkflowExecution {
  return {
    id: `exec-${workflowId}`,
    workflowId,
    status: 'running',
    inputs: {},
    startedAt: Date.now(),
    scope: { type: 'global' },
  };
}

/**
 * Create a fresh isolated bus with the workflow namespace and frame storage.
 */
function makeBus(): ReturnType<typeof createBusInstance> {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  registerInMemoryFrameStore(bus);
  return bus;
}

/**
 * Create a RuntimeContext with code step handlers and loop check handlers.
 * @param handlers - Code step handlers keyed by node ID.
 * @param loopChecks - Loop check handlers keyed by handler name.
 * @param signal - Optional abort signal.
 * @returns RuntimeContext and the underlying bus.
 */
function makeCtx(
  handlers: Record<string, CodeStepHandler>,
  loopChecks: Record<string, LoopCheckHandler> = {},
  signal: AbortSignal = new AbortController().signal,
): { ctx: RuntimeContext; bus: ReturnType<typeof createBusInstance> } {
  const bus = makeBus();
  const ctx = new RuntimeContext(
    'exec-test',
    'workflow-test',
    makeDefinition('workflow-test'),
    makeExecution('workflow-test'),
    new Map(Object.entries(handlers)),
    bus,
    signal,
    undefined,
    undefined,
    undefined,
    { runtimeLoopChecks: new Map(Object.entries(loopChecks)) },
  );
  return { ctx, bus };
}

/** Minimal expression context with no pre-populated frames. */
const emptyExpressionCtx = {
  inputs: {},
  config: {},
  trigger: {},
  frames: {},
  previousSteps: {},
};

// -----------------------------------------------------------------
// Loop node factory helpers
// -----------------------------------------------------------------

/**
 * Build a loop node with a single code step in its body.
 * @param nodeId - Loop node ID.
 * @param stepId - Code step node ID inside the body.
 * @param checkHandler - Check handler name.
 * @param maxRounds - Maximum rounds.
 * @returns A WorkflowLoopNode.
 */
function makeLoopNode(nodeId: string, stepId: string, checkHandler: string, maxRounds: number): WorkflowLoopNode {
  const codeStepNode: WorkflowCodeStepNode = {
    id: stepId,
    type: 'code-step',
  };
  const bodySequence: WorkflowSequenceNode = {
    id: `${nodeId}__body`,
    type: 'sequence',
    nodes: [codeStepNode],
  };
  return {
    id: nodeId,
    type: 'loop',
    maxRounds,
    body: bodySequence,
    check: {
      handler: checkHandler,
    },
  };
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

describe('executeLoopNode', () => {
  it('completes when check returns pass after one round', async () => {
    const call = createTestCall();
    let callCount = 0;
    const codeStepHandler: CodeStepHandler = async () => {
      callCount++;
      return callCount;
    };

    const checkHandler: LoopCheckHandler = (): LoopCheckOutcome => {
      return { kind: 'pass' };
    };

    const loopNode = makeLoopNode('loop1', 'work-step', 'convergence', 3);
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-step': codeStepHandler }, { convergence: checkHandler });

    const outcome = await executeSequence(call, rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(callCount).toBe(1);
  });

  it('loops then passes after two rounds', async () => {
    const call = createTestCall();
    let callCount = 0;
    const codeStepHandler: CodeStepHandler = async () => {
      callCount++;
      return callCount * 10;
    };

    let checkCallCount = 0;
    const checkHandler: LoopCheckHandler = (): LoopCheckOutcome => {
      checkCallCount++;
      // Loop on first round, pass on second.
      return checkCallCount === 1 ? { kind: 'loop' } : { kind: 'pass' };
    };

    const loopNode = makeLoopNode('loop1', 'work-step', 'convergence', 5);
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx, bus } = makeCtx({ 'work-step': codeStepHandler }, { convergence: checkHandler });

    const outcome = await executeSequence(call, rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(callCount).toBe(2);
    expect(checkCallCount).toBe(2);

    const { frames } = await bus.request(call, WorkflowStorageSubjects.listFrames, { executionId: ctx.executionId });
    const loopFrame = frames.find((frame) => frame.nodeId === loopNode.id && frame.parentFrameId === undefined);
    expect(loopFrame?.status).toBe('completed');
    expect(loopFrame?.output).toEqual({ passed: true, rounds: 2, bodyOutputs: [10, 20] });
    const roundFrames = frames.filter(
      (frame) => frame.nodeId === loopNode.id && frame.parentFrameId === loopFrame?.frameId,
    );
    expect(roundFrames.map(({ iteration, status, output }) => ({ iteration, status, output }))).toEqual([
      { iteration: 0, status: 'completed', output: 10 },
      { iteration: 1, status: 'completed', output: 20 },
    ]);
  });

  it('passes evaluated check input, config, and loop context after body execution', async () => {
    const call = createTestCall();
    const codeStepHandler: CodeStepHandler = async () => ({ score: 42 });
    const checkCalls: Array<{ input: unknown; config: unknown; round: number; maxRounds: number; nodeId: string }> = [];
    const checkHandler: LoopCheckHandler = (
      input: JsonValue,
      config: JsonValue,
      ctx: LoopCheckContext,
    ): LoopCheckOutcome => {
      checkCalls.push({ input, config, round: ctx.round, maxRounds: ctx.maxRounds, nodeId: ctx.nodeId });
      return { kind: 'pass' };
    };

    const loopNode = {
      ...makeLoopNode('loop-input', 'work-step', 'convergence', 3),
      check: {
        handler: 'convergence',
        input: 'frames["work-step"].output.score',
        config: { threshold: 40 },
      },
    } satisfies WorkflowLoopNode;
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-step': codeStepHandler }, { convergence: checkHandler });
    const outcome = await executeSequence(call, rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(checkCalls).toEqual([
      {
        input: 42,
        config: { threshold: 40 },
        round: 1,
        maxRounds: 3,
        nodeId: 'loop-input',
      },
    ]);
  });

  it('fails after exhausting maxRounds without a passing check', async () => {
    const call = createTestCall();
    let callCount = 0;
    const codeStepHandler: CodeStepHandler = async () => {
      callCount++;
      return callCount;
    };

    const checkHandler = vi.fn<LoopCheckHandler>(() => ({ kind: 'loop' }));

    const loopNode = makeLoopNode('loop1', 'work-step', 'convergence', 3);
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-step': codeStepHandler }, { convergence: checkHandler });

    const outcome = await executeSequence(call, rootSequence, ctx, emptyExpressionCtx);

    expect(outcome).toEqual({
      status: 'failed',
      error: "Loop node 'loop1' exhausted maxRounds (3) without a passing check",
    });
    expect(callCount).toBe(3);
    expect(checkHandler).toHaveBeenCalledTimes(3);
  });

  it('fails when the check handler throws', async () => {
    const call = createTestCall();
    const checkHandler = vi.fn<LoopCheckHandler>(() => {
      throw new Error('quality check failed');
    });
    const loopNode = makeLoopNode('loop1', 'work-step', 'convergence', 3);
    const rootSequence: WorkflowSequenceNode = { id: 'root', type: 'sequence', nodes: [loopNode] };
    const { ctx } = makeCtx({ 'work-step': async () => 1 }, { convergence: checkHandler });

    const outcome = await executeSequence(call, rootSequence, ctx, emptyExpressionCtx);

    expect(outcome).toEqual({
      status: 'failed',
      error: "Loop node 'loop1': check handler 'convergence' threw: quality check failed",
    });
    expect(checkHandler).toHaveBeenCalledTimes(1);
  });

  it('fails with clear error when check handler is not registered', async () => {
    const call = createTestCall();
    const codeStepHandler: CodeStepHandler = async () => 'done';

    const loopNode = makeLoopNode('loop1', 'work-step', 'missing-check', 3);
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-step': codeStepHandler });

    const outcome = await executeSequence(call, rootSequence, ctx, emptyExpressionCtx);

    expect(outcome).toEqual({
      status: 'failed',
      error: "Loop node 'loop1': no check handler registered for 'missing-check'",
    });
  });

  it('fails when body code step throws', async () => {
    const call = createTestCall();
    const codeStepHandler: CodeStepHandler = async () => {
      throw new Error('code step exploded');
    };

    const checkHandler = vi.fn<LoopCheckHandler>(() => ({ kind: 'pass' }));

    const loopNode = makeLoopNode('loop1', 'work-step', 'convergence', 3);
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-step': codeStepHandler }, { convergence: checkHandler });

    const outcome = await executeSequence(call, rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('code step exploded');
    }
    expect(checkHandler).not.toHaveBeenCalled();
  });

  it('keeps a null output entry for each round with an empty body', async () => {
    const call = createTestCall();
    const loopNode: WorkflowLoopNode = {
      ...makeLoopNode('loop-no-output', 'unused-step', 'convergence', 3),
      body: { id: 'loop-no-output__body', type: 'sequence', nodes: [] },
    };
    const rootSequence: WorkflowSequenceNode = { id: 'root', type: 'sequence', nodes: [loopNode] };
    const { ctx, bus } = makeCtx(
      {},
      { convergence: (_input, _config, { round }) => (round === 1 ? { kind: 'loop' } : { kind: 'pass' }) },
    );

    const outcome = await executeSequence(call, rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    const { frames } = await bus.request(call, WorkflowStorageSubjects.listFrames, { executionId: ctx.executionId });
    const loopFrame = frames.find((frame) => frame.nodeId === loopNode.id && frame.parentFrameId === undefined);
    expect(loopFrame?.output).toEqual({ passed: true, rounds: 2, bodyOutputs: [null, null] });
  });

  it('cancels before starting another round after an abort', async () => {
    const call = createTestCall();
    const controller = new AbortController();
    const checkHandler = vi.fn<LoopCheckHandler>(() => {
      controller.abort();
      return { kind: 'loop' };
    });
    const codeStepHandler = vi.fn<CodeStepHandler>(async () => 1);
    const loopNode = makeLoopNode('loop1', 'work-step', 'convergence', 3);
    const rootSequence: WorkflowSequenceNode = { id: 'root', type: 'sequence', nodes: [loopNode] };
    const { ctx, bus } = makeCtx({ 'work-step': codeStepHandler }, { convergence: checkHandler }, controller.signal);

    const outcome = await executeSequence(call, rootSequence, ctx, emptyExpressionCtx);

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(codeStepHandler).toHaveBeenCalledTimes(1);
    expect(checkHandler).toHaveBeenCalledTimes(1);
    const { frames } = await bus.request(call, WorkflowStorageSubjects.listFrames, { executionId: ctx.executionId });
    const loopFrames = frames.filter((frame) => frame.nodeId === loopNode.id);
    expect(loopFrames).toMatchObject([{ status: 'cancelled' }, { iteration: 0, status: 'completed' }]);
  });
});
