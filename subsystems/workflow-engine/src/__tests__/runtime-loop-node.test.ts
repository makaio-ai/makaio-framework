import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  WorkflowNamespace,
  type JsonValue,
  type LoopGateContext,
  type LoopGateHandler,
  type LoopGateOutcome,
  type StationHandler,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowFrameState,
  type WorkflowLoopNode,
  type WorkflowSequenceNode,
  type WorkflowStationNode,
} from '@makaio/contracts';
import { RuntimeContext, type RuntimeExecutionOptions } from '../runtime/runtime-context.js';
import { executeSequence } from '../runtime/primitive-runtime.js';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { buildResumeFrameIndex } from '../runtime/resume-frames.js';
import type { LoopOutput } from '../runtime/loop-node.js';

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
 * Create a fresh isolated bus with the WorkflowNamespace registered.
 */
function makeBus(): ReturnType<typeof createBusInstance> {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  return bus;
}

/**
 * Create a RuntimeContext with station handlers and loop gate handlers.
 * @param handlers - Station handlers keyed by node ID.
 * @param loopGates - Loop gate handlers keyed by handler name.
 * @param signal - Optional abort signal.
 * @param options - Optional additional runtime execution options.
 * @returns RuntimeContext and the underlying bus.
 */
function makeCtx(
  handlers: Record<string, StationHandler>,
  loopGates: Record<string, LoopGateHandler> = {},
  signal: AbortSignal = new AbortController().signal,
  options: Omit<RuntimeExecutionOptions, 'runtimeLoopGates'> = {},
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
    { runtimeLoopGates: new Map(Object.entries(loopGates)), ...options },
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
 * Build a loop node with a single station in its body.
 * @param nodeId - Loop node ID.
 * @param stationId - Station node ID inside the body.
 * @param gateHandler - Gate handler name.
 * @param maxRounds - Maximum rounds.
 * @returns A WorkflowLoopNode.
 */
function makeLoopNode(nodeId: string, stationId: string, gateHandler: string, maxRounds: number): WorkflowLoopNode {
  const stationNode: WorkflowStationNode = {
    id: stationId,
    type: 'station',
    prompt: 'do work',
  };
  const bodySequence: WorkflowSequenceNode = {
    id: `${nodeId}__body`,
    type: 'sequence',
    nodes: [stationNode],
  };
  return {
    id: nodeId,
    type: 'loop',
    maxRounds,
    body: bodySequence,
    gate: {
      handler: gateHandler,
    },
  };
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

describe('executeLoopNode', () => {
  it('completes when gate returns pass after one round', async () => {
    let callCount = 0;
    const stationHandler: StationHandler = async () => {
      callCount++;
      return callCount;
    };

    const gateHandler: LoopGateHandler = (): LoopGateOutcome => {
      return { kind: 'pass' };
    };

    const loopNode = makeLoopNode('loop1', 'work-station', 'check-gate', 3);
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });

    const outcome = await executeSequence(rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(callCount).toBe(1);
  });

  it('loops then passes after two rounds', async () => {
    let callCount = 0;
    const stationHandler: StationHandler = async () => {
      callCount++;
      return callCount * 10;
    };

    let gateCallCount = 0;
    const gateHandler: LoopGateHandler = (): LoopGateOutcome => {
      gateCallCount++;
      // Loop on first round, pass on second.
      return gateCallCount === 1 ? { kind: 'loop' } : { kind: 'pass' };
    };

    const loopNode = makeLoopNode('loop1', 'work-station', 'check-gate', 5);
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });

    const outcome = await executeSequence(rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(callCount).toBe(2);
    expect(gateCallCount).toBe(2);

    // Verify the loop output is accessible via the completed frame.
    if (outcome.status === 'completed' && outcome.output !== undefined) {
      const loopOutput = outcome.output as {
        outcome: string;
        rounds: number;
        bodyOutputs: number[];
      };
      expect(loopOutput.outcome).toBe('pass');
      expect(loopOutput.rounds).toBe(2);
      expect(loopOutput.bodyOutputs).toEqual([10, 20]);
    }
  });

  it('passes evaluated gate input, config, and loop context after body execution', async () => {
    const stationHandler: StationHandler = async () => ({ score: 42 });
    const gateCalls: Array<{ input: unknown; config: unknown; round: number; maxRounds: number; nodeId: string }> = [];
    const gateHandler: LoopGateHandler = (
      input: JsonValue,
      config: JsonValue,
      ctx: LoopGateContext,
    ): LoopGateOutcome => {
      gateCalls.push({ input, config, round: ctx.round, maxRounds: ctx.maxRounds, nodeId: ctx.nodeId });
      return { kind: 'pass' };
    };

    const loopNode = {
      ...makeLoopNode('loop-input', 'work-station', 'check-gate', 3),
      gate: {
        handler: 'check-gate',
        input: 'frames["work-station"].output.score',
        config: { threshold: 40 },
      },
    } satisfies WorkflowLoopNode;
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });
    const outcome = await executeSequence(rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(gateCalls).toEqual([
      {
        input: 42,
        config: { threshold: 40 },
        round: 1,
        maxRounds: 3,
        nodeId: 'loop-input',
      },
    ]);
  });

  it('escalates when max rounds reached', async () => {
    let callCount = 0;
    const stationHandler: StationHandler = async () => {
      callCount++;
      return callCount;
    };

    const gateHandler: LoopGateHandler = (): LoopGateOutcome => {
      // Always want to loop.
      return { kind: 'loop' };
    };

    // maxRounds: 1 means the body runs once, then gate returns loop,
    // but round + 1 >= maxRounds so the runtime overrides with escalate.
    const loopNode = makeLoopNode('loop1', 'work-station', 'check-gate', 1);
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });

    const outcome = await executeSequence(rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(callCount).toBe(1);

    if (outcome.status === 'completed' && outcome.output !== undefined) {
      const loopOutput = outcome.output as {
        outcome: string;
        rounds: number;
        lastGateOutcome: LoopGateOutcome;
      };
      expect(loopOutput.outcome).toBe('escalate');
      expect(loopOutput.rounds).toBe(1);
      expect(loopOutput.lastGateOutcome).toEqual({
        kind: 'escalate',
        reason: 'max_rounds_reached',
      });
    }
  });

  it('fails with clear error when gate handler is not registered', async () => {
    const stationHandler: StationHandler = async () => 'done';

    // No gate handler registered — the handler name 'missing-gate' has no entry.
    const loopNode = makeLoopNode('loop1', 'work-station', 'missing-gate', 3);
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-station': stationHandler }, {});

    const outcome = await executeSequence(rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain("Loop node 'loop1'");
      expect(outcome.error).toContain('missing-gate');
    }
  });

  it('fails when body station throws', async () => {
    const stationHandler: StationHandler = async () => {
      throw new Error('station exploded');
    };

    const gateHandler: LoopGateHandler = (): LoopGateOutcome => {
      return { kind: 'pass' };
    };

    const loopNode = makeLoopNode('loop1', 'work-station', 'check-gate', 3);
    const rootSequence: WorkflowSequenceNode = {
      id: 'root',
      type: 'sequence',
      nodes: [loopNode],
    };

    const { ctx } = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });

    const outcome = await executeSequence(rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('station exploded');
    }
  });
});

// -----------------------------------------------------------------
// Escalation gate tests
// -----------------------------------------------------------------

/**
 * Build a loop node with escalation config for gate suspension tests.
 * @param nodeId - Loop node ID.
 * @param stationId - Station node ID inside the body.
 * @param gateHandler - Gate handler name.
 * @param maxRounds - Maximum rounds.
 * @param escalation - Escalation gate configuration.
 * @returns A WorkflowLoopNode with escalation config.
 */
function makeLoopNodeWithEscalation(
  nodeId: string,
  stationId: string,
  gateHandler: string,
  maxRounds: number,
  escalation: NonNullable<WorkflowLoopNode['gate']['escalation']>,
): WorkflowLoopNode {
  const base = makeLoopNode(nodeId, stationId, gateHandler, maxRounds);
  return {
    ...base,
    gate: {
      ...base.gate,
      escalation,
    },
  };
}

describe('executeLoopNode — escalation gate', () => {
  it('opens gate suspension when escalation config is present and gate returns escalate', async () => {
    let callCount = 0;
    const stationHandler: StationHandler = async () => {
      callCount++;
      return callCount;
    };

    const gateHandler: LoopGateHandler = (): LoopGateOutcome => {
      return { kind: 'escalate', reason: 'review needed' };
    };

    const loopNode = makeLoopNodeWithEscalation('loop-esc', 'work-station', 'check-gate', 3, {
      prompt: 'Please review the loop results',
      autoAction: 'reject',
      timeoutMs: null,
    });

    const { ctx, bus } = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });

    // Create a container frame so updateFrame can find it during escalation.
    const containerFrame = ctx.createFrame({
      nodeId: 'loop-esc',
      nodeType: 'loop',
      path: [],
      parentFrameId: undefined,
    });

    // Track gate.suspended emissions.
    const suspendedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.suspended, (c) => {
      suspendedPayloads.push(c.payload);
    });

    // Respond immediately when the gate is suspended so the test doesn't hang.
    bus.on(WorkflowSubjects.gate.suspended, () => {
      setImmediate(() => {
        void bus.request(WorkflowSubjects.gate.respond, {
          executionId: 'exec-test',
          gateId: 'loop-esc',
          action: 'approve',
          resumeData: { decision: 'approved' },
        });
      });
    });

    const { executeLoopNode } = await import('../runtime/loop-node.js');
    const outcome = await executeLoopNode(
      loopNode,
      ctx,
      emptyExpressionCtx,
      executeSequence,
      containerFrame.frameId,
      containerFrame.path,
    );

    expect(outcome.status).toBe('completed');
    expect(callCount).toBe(1);
    expect(suspendedPayloads).toHaveLength(1);
    expect(suspendedPayloads[0]).toMatchObject({
      executionId: 'exec-test',
      nodeId: 'loop-esc',
      prompt: 'Please review the loop results',
      autoAction: 'reject',
      timeoutMs: null,
    });

    if (outcome.status === 'completed') {
      const loopOutput = outcome.output as LoopOutput;
      expect(loopOutput.outcome).toBe('escalate');
      expect(loopOutput.rounds).toBe(1);
      expect(loopOutput.resumeData).toEqual({ decision: 'approved' });
      expect(loopOutput.bodyOutputs).toEqual([1]);
    }
  });

  it('returns paused for exit-based suspension on escalation', async () => {
    let callCount = 0;
    const stationHandler: StationHandler = async () => {
      callCount++;
      return callCount;
    };

    const gateHandler: LoopGateHandler = (): LoopGateOutcome => {
      return { kind: 'escalate', reason: 'needs human review' };
    };

    const loopNode = makeLoopNodeWithEscalation('loop-park', 'work-station', 'check-gate', 3, {
      prompt: 'Review needed',
      autoAction: 'reject',
      timeoutMs: null,
    });

    const { ctx, bus } = makeCtx(
      { 'work-station': stationHandler },
      { 'check-gate': gateHandler },
      new AbortController().signal,
      { suspensionStrategy: 'exit-and-redispatch' },
    );

    // Register storage handlers required for exit-based suspension.
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      c.setResult({ id: c.payload.gate.frameId });
    });
    bus.on(WorkflowStorageSubjects.setFrame, (c) => {
      c.setResult({ frameId: c.payload.frame.frameId });
    });

    const suspendedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.suspended, (c) => {
      suspendedPayloads.push(c.payload);
    });

    // Create a container frame so updateFrame can find it.
    const containerFrame = ctx.createFrame({
      nodeId: 'loop-park',
      nodeType: 'loop',
      path: [],
      parentFrameId: undefined,
    });

    const { executeLoopNode } = await import('../runtime/loop-node.js');
    const outcome = await executeLoopNode(
      loopNode,
      ctx,
      emptyExpressionCtx,
      executeSequence,
      containerFrame.frameId,
      containerFrame.path,
    );

    expect(outcome.status).toBe('paused');
    expect(callCount).toBe(1);
    expect(suspendedPayloads).toHaveLength(1);
    if (outcome.status === 'paused') {
      expect(outcome.pausedAtGateId).toBe('loop-park');
    }
  });

  it('completes without gate when escalation config is absent', async () => {
    let callCount = 0;
    const stationHandler: StationHandler = async () => {
      callCount++;
      return callCount;
    };

    const gateHandler: LoopGateHandler = (): LoopGateOutcome => {
      return { kind: 'escalate', reason: 'review needed' };
    };

    // No escalation config — use the basic makeLoopNode.
    const loopNode = makeLoopNode('loop-no-esc', 'work-station', 'check-gate', 3);

    const { ctx, bus } = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });
    const parentFrameId = 'test-loop-parent';

    // Ensure no gate.suspended is emitted.
    const suspendedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.suspended, (c) => {
      suspendedPayloads.push(c.payload);
    });

    const { executeLoopNode } = await import('../runtime/loop-node.js');
    const outcome = await executeLoopNode(loopNode, ctx, emptyExpressionCtx, executeSequence, parentFrameId, [
      parentFrameId,
    ]);

    expect(outcome.status).toBe('completed');
    expect(callCount).toBe(1);
    expect(suspendedPayloads).toHaveLength(0);

    if (outcome.status === 'completed') {
      const loopOutput = outcome.output as LoopOutput;
      expect(loopOutput.outcome).toBe('escalate');
      expect(loopOutput.resumeData).toBeUndefined();
    }
  });
});

// -----------------------------------------------------------------
// Resume frame reuse tests
// -----------------------------------------------------------------

describe('executeLoopNode — resume frame reuse', () => {
  it('skips body execution for rounds with reusable resume frames', async () => {
    // This test uses executeLoopNode directly with a known parentFrameId
    // to verify frame reuse behavior.
    let callCount = 0;
    const stationHandler: StationHandler = async () => {
      callCount++;
      return callCount * 10;
    };

    let gateCallCount = 0;
    const gateHandler: LoopGateHandler = (): LoopGateOutcome => {
      gateCallCount++;
      return { kind: 'pass' };
    };

    const loopNode = makeLoopNode('loop-resume', 'work-station', 'check-gate', 5);

    // Build resume frames: 2 completed rounds with known parentFrameId.
    const parentFrameId = 'known-parent-frame';
    const resumeFrames: WorkflowFrameState[] = [
      {
        frameId: 'resume-round-0',
        nodeId: 'loop-resume',
        nodeType: 'loop',
        path: [parentFrameId, 'resume-round-0'],
        parentFrameId,
        status: 'completed',
        attempt: 0,
        iteration: 0,
        output: 'round-0-output',
        startedAt: 1,
        completedAt: 2,
      },
      {
        frameId: 'resume-round-1',
        nodeId: 'loop-resume',
        nodeType: 'loop',
        path: [parentFrameId, 'resume-round-1'],
        parentFrameId,
        status: 'completed',
        attempt: 0,
        iteration: 1,
        output: 'round-1-output',
        startedAt: 3,
        completedAt: 4,
      },
    ];

    const resumeIndex = buildResumeFrameIndex(resumeFrames);
    const { ctx } = makeCtx(
      { 'work-station': stationHandler },
      { 'check-gate': gateHandler },
      new AbortController().signal,
      { resumeFrames: resumeIndex },
    );

    // Import executeLoopNode for direct invocation.
    const { executeLoopNode } = await import('../runtime/loop-node.js');

    const outcome = await executeLoopNode(loopNode, ctx, emptyExpressionCtx, executeSequence, parentFrameId, [
      parentFrameId,
    ]);

    // The two resume rounds were replayed (no body execution).
    // Then the main loop runs round 2: body executes once, gate passes.
    expect(callCount).toBe(1);
    expect(gateCallCount).toBe(1);
    expect(outcome.status).toBe('completed');

    if (outcome.status === 'completed') {
      const loopOutput = outcome.output as LoopOutput;
      expect(loopOutput.outcome).toBe('pass');
      // 3 rounds total: 2 resumed + 1 fresh.
      expect(loopOutput.rounds).toBe(3);
      expect(loopOutput.bodyOutputs).toEqual(['round-0-output', 'round-1-output', 10]);
    }
  });

  it('resolves a persisted escalation gate after replaying completed round frames', async () => {
    const stationHandler: StationHandler = async () => {
      throw new Error('body should not rerun');
    };
    const gateHandler: LoopGateHandler = () => {
      throw new Error('gate should not re-evaluate');
    };
    const parentFrameId = 'known-parent-frame';
    const resumeFrames: WorkflowFrameState[] = [
      {
        frameId: 'resume-round-0',
        nodeId: 'loop-resume-gate',
        nodeType: 'loop',
        path: [parentFrameId, 'resume-round-0'],
        parentFrameId,
        status: 'completed',
        attempt: 0,
        iteration: 0,
        output: { result: 'previous-round' },
        startedAt: 1,
        completedAt: 2,
      },
    ];

    const loopNode = makeLoopNodeWithEscalation('loop-resume-gate', 'work-station', 'check-gate', 5, {
      prompt: 'Review needed',
      autoAction: 'reject',
      timeoutMs: null,
    });
    const resumeIndex = buildResumeFrameIndex(resumeFrames);
    const { ctx, bus } = makeCtx(
      { 'work-station': stationHandler },
      { 'check-gate': gateHandler },
      new AbortController().signal,
      { resumeFrames: resumeIndex, suspensionStrategy: 'exit-and-redispatch' },
    );
    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({
        gate: {
          executionId: 'exec-test',
          nodeId: 'loop-resume-gate',
          frameId: parentFrameId,
          schema: {},
          prompt: 'Review needed',
          status: 'resumed',
          autoAction: 'reject',
          timeoutMs: null,
          resumeData: { decision: 'continue' },
          createdAt: 10,
          resolvedAt: 20,
        },
      });
    });

    const { executeLoopNode } = await import('../runtime/loop-node.js');
    const outcome = await executeLoopNode(loopNode, ctx, emptyExpressionCtx, executeSequence, parentFrameId, [
      parentFrameId,
    ]);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const loopOutput = outcome.output as LoopOutput;
      expect(loopOutput.outcome).toBe('escalate');
      expect(loopOutput.rounds).toBe(1);
      expect(loopOutput.bodyOutputs).toEqual([{ result: 'previous-round' }]);
      expect(loopOutput.resumeData).toEqual({ decision: 'continue' });
    }
  });

  it('fails an expired persisted escalation gate with auto-reject on redispatch', async () => {
    const loopNode = makeLoopNodeWithEscalation('loop-timeout', 'work-station', 'check-gate', 5, {
      prompt: 'Review needed',
      autoAction: 'reject',
      timeoutMs: 1,
    });
    const parentFrameId = 'timeout-parent-frame';
    const resumeFrames = buildResumeFrameIndex([
      {
        frameId: 'resume-round-0',
        nodeId: 'loop-timeout',
        nodeType: 'loop',
        path: [parentFrameId, 'resume-round-0'],
        parentFrameId,
        status: 'completed',
        attempt: 0,
        iteration: 0,
        output: 'previous-output',
        startedAt: 1,
        completedAt: 2,
      },
    ]);
    const persistedGateUpdates: unknown[] = [];
    const { ctx, bus } = makeCtx(
      { 'work-station': async () => 'fresh-output' },
      { 'check-gate': () => ({ kind: 'loop' }) },
      new AbortController().signal,
      { resumeFrames, suspensionStrategy: 'exit-and-redispatch' },
    );
    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({
        gate: {
          executionId: 'exec-test',
          nodeId: 'loop-timeout',
          frameId: parentFrameId,
          schema: {},
          prompt: 'Review needed',
          status: 'waiting',
          autoAction: 'reject',
          timeoutMs: 1,
          createdAt: Date.now() - 10_000,
        },
      });
    });
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      persistedGateUpdates.push(c.payload.gate);
      c.setResult({ id: c.payload.gate.frameId });
    });

    const { executeLoopNode } = await import('../runtime/loop-node.js');
    const outcome = await executeLoopNode(loopNode, ctx, emptyExpressionCtx, executeSequence, parentFrameId, [
      parentFrameId,
    ]);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('auto-rejected');
    }
    expect(persistedGateUpdates).toContainEqual(expect.objectContaining({ status: 'timed-out' }));
  });
});
