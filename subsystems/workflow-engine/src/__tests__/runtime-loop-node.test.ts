import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  WorkflowNamespace,
  type LoopGateHandler,
  type LoopGateOutcome,
  type StationHandler,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowLoopNode,
  type WorkflowSequenceNode,
  type WorkflowStationNode,
} from '@makaio/contracts';
import { RuntimeContext } from '../runtime/runtime-context.js';
import { executeSequence } from '../runtime/primitive-runtime.js';

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
 * @returns RuntimeContext wired with the provided handlers and gates.
 */
function makeCtx(
  handlers: Record<string, StationHandler>,
  loopGates: Record<string, LoopGateHandler> = {},
  signal: AbortSignal = new AbortController().signal,
): RuntimeContext {
  const bus = makeBus();
  return new RuntimeContext(
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
    { runtimeLoopGates: new Map(Object.entries(loopGates)) },
  );
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

    const ctx = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });

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

    const ctx = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });

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

    const ctx = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });

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

    const ctx = makeCtx({ 'work-station': stationHandler }, {});

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

    const ctx = makeCtx({ 'work-station': stationHandler }, { 'check-gate': gateHandler });

    const outcome = await executeSequence(rootSequence, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('station exploded');
    }
  });
});
