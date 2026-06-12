import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  WorkflowNamespace,
  type StationHandler,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowGateNode,
} from '@makaio/contracts';
import { RuntimeContext, type RuntimeExecutionOptions } from '../runtime/runtime-context.js';
import { executeGateNode, type GateNodeOutput } from '../runtime/gate-node.js';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';

// ─────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────

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
 * @returns A fresh bus instance.
 */
function makeBus(): ReturnType<typeof createBusInstance> {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  return bus;
}

/**
 * Create a fresh RuntimeContext with an isolated bus.
 * @param options - Optional runtime execution options (e.g. suspension strategy).
 * @param signal - Optional abort signal.
 * @returns A runtime context and its underlying bus.
 */
function makeCtx(
  options: RuntimeExecutionOptions = {},
  signal: AbortSignal = new AbortController().signal,
): {
  ctx: RuntimeContext;
  bus: ReturnType<typeof createBusInstance>;
} {
  const bus = makeBus();
  const ctx = new RuntimeContext(
    'exec-gate-test',
    'workflow-gate-test',
    makeDefinition('workflow-gate-test'),
    makeExecution('workflow-gate-test'),
    new Map<string, StationHandler>(),
    bus,
    signal,
    undefined,
    undefined,
    undefined,
    options,
  );
  return { ctx, bus };
}

/**
 * Build a minimal gate node for tests.
 * @param overrides - Optional field overrides.
 * @returns A gate node.
 */
function makeGateNode(overrides: Partial<WorkflowGateNode> = {}): WorkflowGateNode {
  return {
    id: 'test-gate',
    type: 'gate',
    prompt: 'Approve this action?',
    autoAction: 'reject',
    timeoutMs: null,
    ...overrides,
  };
}

/**
 * Create a frame ID for the gate node in the given context.
 * @param ctx - Runtime context to register the frame in.
 * @param nodeId - Node ID for the frame.
 * @returns The created frame ID.
 */
function makeGateFrame(ctx: RuntimeContext, nodeId: string): string {
  const frame = ctx.createFrame({ nodeId, nodeType: 'gate', path: [] });
  frame.status = 'running';
  frame.startedAt = Date.now();
  return frame.frameId;
}

/** Empty expression context for tests. */
const emptyExpressionCtx = { inputs: {}, trigger: {}, frames: {}, previousSteps: {} };

// ─────────────────────────────────────────────────────────────
// Gate suspension tests
// ─────────────────────────────────────────────────────────────

describe('executeGateNode — suspension', () => {
  it('emits gate.suspended with the node prompt and empty schema when no resumeSchema', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-suspend', prompt: 'Confirm deletion?' });
    const frameId = makeGateFrame(ctx, 'gate-suspend');

    const suspendedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.suspended, (c) => {
      suspendedPayloads.push(c.payload);
    });

    // Respond immediately in the next microtask so the test doesn't hang.
    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-suspend',
        action: 'approve',
        resumeData: { confirmed: true },
      });
    });

    await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(suspendedPayloads).toHaveLength(1);
    expect(suspendedPayloads[0]).toMatchObject({
      executionId: 'exec-gate-test',
      frameId,
      nodeId: 'gate-suspend',
      prompt: 'Confirm deletion?',
      schema: {},
    });
  });

  it('includes the resumeSchema in the gate.suspended event when declared', async () => {
    const { ctx, bus } = makeCtx();
    const resumeSchema = { type: 'object', properties: { decision: { type: 'string' } } };
    const node = makeGateNode({ id: 'gate-schema', resumeSchema });
    const frameId = makeGateFrame(ctx, 'gate-schema');

    const suspendedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.suspended, (c) => {
      suspendedPayloads.push(c.payload);
    });

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-schema',
        action: 'approve',
        resumeData: { decision: 'approved' },
      });
    });

    await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(suspendedPayloads[0]).toMatchObject({ schema: resumeSchema });
  });

  it('emits gate.suspended with a prompt rendered from the expression context', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({
      id: 'gate-prompt',
      prompt:
        'Review {{ ctx.inputs.branch }} in {{ config.repository }} after {{ steps.analyze.output.findings }} findings',
    });
    const frameId = makeGateFrame(ctx, 'gate-prompt');

    const suspendedPayloads: unknown[] = [];
    const persistedGatePrompts: unknown[] = [];
    bus.on(WorkflowSubjects.gate.suspended, (c) => {
      suspendedPayloads.push(c.payload);
    });
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      persistedGatePrompts.push(c.payload.gate.prompt);
      c.setResult({ id: c.payload.gate.nodeId });
    });

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-prompt',
        action: 'approve',
        resumeData: null,
      });
    });

    await executeGateNode(
      node,
      ctx,
      {
        inputs: { branch: 'main' },
        config: { repository: 'makaio' },
        trigger: {},
        frames: { analyze: { status: 'completed', output: { findings: 3 } } },
        previousSteps: {},
      },
      frameId,
    );

    expect(suspendedPayloads[0]).toMatchObject({
      prompt: 'Review main in makaio after 3 findings',
    });
    expect(persistedGatePrompts[0]).toBe('Review main in makaio after 3 findings');
  });

  it('transitions the frame to waiting status while suspended', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-waiting' });
    const frameId = makeGateFrame(ctx, 'gate-waiting');

    let frameStatusWhileWaiting: string | undefined;
    bus.on(WorkflowSubjects.gate.suspended, () => {
      frameStatusWhileWaiting = ctx.getFrame(frameId)?.status;
    });

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-waiting',
        action: 'approve',
        resumeData: null,
      });
    });

    await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(frameStatusWhileWaiting).toBe('waiting');
  });

  it('returns cancelled immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { ctx } = makeCtx({}, ctrl.signal);
    const node = makeGateNode({ id: 'gate-pre-aborted' });
    const frameId = makeGateFrame(ctx, 'gate-pre-aborted');

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('cancelled');
  });
});

// ─────────────────────────────────────────────────────────────
// Gate resume tests
// ─────────────────────────────────────────────────────────────

describe('executeGateNode — resume', () => {
  it('completes with the submitted resumeData as output', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-resume' });
    const frameId = makeGateFrame(ctx, 'gate-resume');

    const resumePayload = { decision: 'approved', comment: 'Looks good' };

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-resume',
        action: 'approve',
        resumeData: resumePayload,
      });
    });

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as GateNodeOutput;
      expect(output.resumeData).toEqual(resumePayload);
    }
  });

  it('emits gate.resumed with resumeData after successful response', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-emit-resumed' });
    const frameId = makeGateFrame(ctx, 'gate-emit-resumed');

    const resumedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.resumed, (c) => {
      resumedPayloads.push(c.payload);
    });
    const resolvedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.resolved, (c) => {
      resolvedPayloads.push(c.payload);
    });

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-emit-resumed',
        action: 'approve',
        resumeData: { decision: 'ok' },
      });
    });

    await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(resumedPayloads).toHaveLength(1);
    expect(resumedPayloads[0]).toMatchObject({
      executionId: 'exec-gate-test',
      frameId,
      nodeId: 'gate-emit-resumed',
      resumeData: { decision: 'ok' },
    });
    expect(resolvedPayloads).toEqual([
      expect.objectContaining({
        executionId: 'exec-gate-test',
        stepId: 'gate-emit-resumed',
        stepType: 'gate',
        frameId,
        action: 'approve',
        source: 'user',
      }),
    ]);
  });

  it('records user reject responses as rejected gate resolutions while resuming with typed data', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-reject-response' });
    const frameId = makeGateFrame(ctx, 'gate-reject-response');

    const resumedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.resumed, (c) => {
      resumedPayloads.push(c.payload);
    });
    const resolvedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.resolved, (c) => {
      resolvedPayloads.push(c.payload);
    });

    const resumePayload = { decision: 'rejected', reason: 'needs changes' };
    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-reject-response',
        action: 'reject',
        resumeData: resumePayload,
      });
    });

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect((outcome.output as GateNodeOutput).resumeData).toEqual(resumePayload);
    }
    expect(resumedPayloads).toEqual([
      expect.objectContaining({
        executionId: 'exec-gate-test',
        frameId,
        nodeId: 'gate-reject-response',
        resumeData: resumePayload,
      }),
    ]);
    expect(resolvedPayloads).toEqual([
      expect.objectContaining({
        executionId: 'exec-gate-test',
        stepId: 'gate-reject-response',
        stepType: 'gate',
        frameId,
        action: 'reject',
        source: 'user',
      }),
    ]);
  });

  it('returns accepted: true when responding to a waiting gate', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-accepted' });
    const frameId = makeGateFrame(ctx, 'gate-accepted');

    let accepted: boolean | undefined;
    setImmediate(() => {
      void bus
        .request(WorkflowSubjects.gate.respond, {
          executionId: 'exec-gate-test',
          gateId: 'gate-accepted',
          action: 'approve',
          resumeData: null,
        })
        .then((res) => {
          accepted = res.accepted;
        });
    });

    await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(accepted).toBe(true);
  });

  it('returns no handler when a second response arrives after the gate has resolved and unsubscribed', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-late-respond' });
    const frameId = makeGateFrame(ctx, 'gate-late-respond');

    // First respond resolves the gate.
    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-late-respond',
        action: 'approve',
        resumeData: null,
      });
    });

    await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    // Second respond arrives after gate resolved and unsubscribed — no handler remains.
    const secondResponse = await bus.requestOptional(WorkflowSubjects.gate.respond, {
      executionId: 'exec-gate-test',
      gateId: 'gate-late-respond',
      action: 'approve',
      resumeData: null,
    });

    expect(secondResponse.handled).toBe(false);
  });

  it('filters responses by executionId and gateId — ignores mismatches', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-filter' });
    const frameId = makeGateFrame(ctx, 'gate-filter');

    // Wrong executionId and gateId — should not resolve the gate.
    // These use requestOptional since the gate does not "own" mismatched requests.
    const wrongResponses: boolean[] = [];
    setImmediate(async () => {
      // Wrong executionId — returns { accepted: false } from our handler.
      const r1 = await bus.requestOptional(WorkflowSubjects.gate.respond, {
        executionId: 'wrong-execution-id',
        gateId: 'gate-filter',
        action: 'approve',
        resumeData: 'wrong',
      });
      wrongResponses.push(r1.handled ? r1.data.accepted : false);

      // Wrong gateId — returns { accepted: false } from our handler.
      const r2 = await bus.requestOptional(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'wrong-gate-id',
        action: 'approve',
        resumeData: 'wrong',
      });
      wrongResponses.push(r2.handled ? r2.data.accepted : false);

      // Correct response — should resolve.
      await bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-filter',
        action: 'approve',
        resumeData: 'correct',
      });
    });

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as GateNodeOutput;
      expect(output.resumeData).toBe('correct');
    }
    // Wrong executionId/gateId got { accepted: false } — gate was not resolved by them.
    expect(wrongResponses).toEqual([false, false]);
  });

  it('filters by frameId when provided in the response', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-frameid' });
    const frameId = makeGateFrame(ctx, 'gate-frameid');

    setImmediate(async () => {
      // Wrong frameId — returns { accepted: false } since it doesn't match this frame.
      // Use requestOptional because the handler passes to next() when frameId mismatches,
      // which may throw NoHandlerError at the bus level on non-optional requests.
      const wrongFrameOptional = await bus.requestOptional(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-frameid',
        frameId: 'wrong-frame-id',
        action: 'approve',
        resumeData: 'wrong',
      });
      // Gate should not have resolved yet.
      const wrongAccepted = wrongFrameOptional.handled ? wrongFrameOptional.data.accepted : false;
      expect(wrongAccepted).toBe(false);

      // No frameId — should match any frame and resolve the gate.
      await bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-frameid',
        action: 'approve',
        resumeData: 'correct',
      });
    });

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect((outcome.output as GateNodeOutput).resumeData).toBe('correct');
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Gate reason threading (in-process path)
// ─────────────────────────────────────────────────────────────

describe('executeGateNode — reason (in-process)', () => {
  it('carries reason through gate instance and gate.resolved when respond includes it', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-reason-present' });
    const frameId = makeGateFrame(ctx, 'gate-reason-present');

    const persistedGates: unknown[] = [];
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      persistedGates.push(c.payload.gate);
      c.setResult({ id: c.payload.gate.nodeId });
    });
    const resolvedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.resolved, (c) => {
      resolvedPayloads.push(c.payload);
    });

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-reason-present',
        action: 'approve',
        resumeData: { decision: 'ok' },
        reason: 'Reviewed and approved by the team',
      });
    });

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('completed');
    // Persisted gate instance carries the reason.
    expect(persistedGates).toContainEqual(
      expect.objectContaining({ status: 'resumed', reason: 'Reviewed and approved by the team' }),
    );
    // gate.resolved event carries the reason.
    expect(resolvedPayloads).toEqual([
      expect.objectContaining({
        executionId: 'exec-gate-test',
        stepId: 'gate-reason-present',
        action: 'approve',
        source: 'user',
        reason: 'Reviewed and approved by the team',
      }),
    ]);
  });

  it('does not set reason on gate instance or gate.resolved when respond omits it', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-reason-absent' });
    const frameId = makeGateFrame(ctx, 'gate-reason-absent');

    const persistedGates: unknown[] = [];
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      persistedGates.push(c.payload.gate);
      c.setResult({ id: c.payload.gate.nodeId });
    });
    const resolvedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.resolved, (c) => {
      resolvedPayloads.push(c.payload);
    });

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-reason-absent',
        action: 'approve',
        resumeData: null,
      });
    });

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('completed');
    // Persisted gate instance should not have a reason field.
    expect(persistedGates).toContainEqual(expect.objectContaining({ status: 'resumed' }));
    const resolvedGate = (persistedGates as Record<string, unknown>[]).find((g) => g.status === 'resumed');
    expect(resolvedGate).not.toHaveProperty('reason');
    // gate.resolved event should not carry reason.
    expect(resolvedPayloads[0]).not.toHaveProperty('reason');
  });
});

// ─────────────────────────────────────────────────────────────
// Gate timeout tests
// ─────────────────────────────────────────────────────────────

describe('executeGateNode — timeout', () => {
  it('returns failed outcome when timeoutMs expires with autoAction reject', async () => {
    vi.useFakeTimers();

    try {
      const { ctx, bus } = makeCtx();
      const node = makeGateNode({ id: 'gate-timeout', timeoutMs: 1000 });
      const frameId = makeGateFrame(ctx, 'gate-timeout');
      const resolvedPayloads: unknown[] = [];
      bus.on(WorkflowSubjects.gate.resolved, (c) => {
        resolvedPayloads.push(c.payload);
      });

      const outcomePromise = executeGateNode(node, ctx, emptyExpressionCtx, frameId);

      // Advance past the timeout.
      await vi.advanceTimersByTimeAsync(1001);

      const outcome = await outcomePromise;

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.error).toContain('gate-timeout');
        expect(outcome.error).toContain('1000ms');
        expect(outcome.error).toContain('auto-rejected');
      }
      expect(resolvedPayloads).toEqual([
        expect.objectContaining({
          executionId: 'exec-gate-test',
          stepId: 'gate-timeout',
          stepType: 'gate',
          frameId,
          action: 'reject',
          source: 'timeout',
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes when timeoutMs expires with autoAction approve', async () => {
    vi.useFakeTimers();

    try {
      const { ctx, bus } = makeCtx();
      const node = makeGateNode({ id: 'gate-timeout-approve', autoAction: 'approve', timeoutMs: 1000 });
      const frameId = makeGateFrame(ctx, 'gate-timeout-approve');
      const resolvedPayloads: unknown[] = [];
      bus.on(WorkflowSubjects.gate.resolved, (c) => {
        resolvedPayloads.push(c.payload);
      });

      const outcomePromise = executeGateNode(node, ctx, emptyExpressionCtx, frameId);

      await vi.advanceTimersByTimeAsync(1001);

      const outcome = await outcomePromise;

      expect(outcome.status).toBe('completed');
      if (outcome.status === 'completed') {
        expect(outcome.output).toEqual({ resumeData: { action: 'approve', source: 'timeout' } });
      }
      expect(resolvedPayloads).toEqual([
        expect.objectContaining({
          executionId: 'exec-gate-test',
          stepId: 'gate-timeout-approve',
          stepType: 'gate',
          frameId,
          action: 'approve',
          source: 'timeout',
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out if response arrives before the deadline', async () => {
    vi.useFakeTimers();

    try {
      const { ctx, bus } = makeCtx();
      const node = makeGateNode({ id: 'gate-no-timeout', timeoutMs: 500 });
      const frameId = makeGateFrame(ctx, 'gate-no-timeout');

      const outcomePromise = executeGateNode(node, ctx, emptyExpressionCtx, frameId);

      // Respond before the timeout fires.
      await vi.advanceTimersByTimeAsync(100);
      await bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-no-timeout',
        action: 'approve',
        resumeData: { decision: 'approved' },
      });

      const outcome = await outcomePromise;

      expect(outcome.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Gate cancellation tests
// ─────────────────────────────────────────────────────────────

describe('executeGateNode — cancellation', () => {
  it('returns cancelled when the abort signal fires while waiting', async () => {
    const ctrl = new AbortController();
    const { ctx, bus } = makeCtx({}, ctrl.signal);
    const node = makeGateNode({ id: 'gate-abort' });
    const frameId = makeGateFrame(ctx, 'gate-abort');
    const resumedPayloads: unknown[] = [];
    const resolvedPayloads: unknown[] = [];
    bus.on(WorkflowSubjects.gate.resumed, (c) => {
      resumedPayloads.push(c.payload);
    });
    bus.on(WorkflowSubjects.gate.resolved, (c) => {
      resolvedPayloads.push(c.payload);
    });

    const outcomePromise = executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    // Abort after a microtask so the gate has time to register.
    setImmediate(() => ctrl.abort());

    const outcome = await outcomePromise;

    expect(outcome.status).toBe('cancelled');
    expect(resumedPayloads).toEqual([]);
    expect(resolvedPayloads).toEqual([
      expect.objectContaining({
        executionId: 'exec-gate-test',
        stepId: 'gate-abort',
        stepType: 'gate',
        frameId,
        source: 'cancelled',
      }),
    ]);
    expect(resolvedPayloads[0]).not.toHaveProperty('action');
  });

  it('returns accepted: false for a respond call after cancellation', async () => {
    const ctrl = new AbortController();
    const { ctx, bus } = makeCtx({}, ctrl.signal);
    const node = makeGateNode({ id: 'gate-post-cancel' });
    const frameId = makeGateFrame(ctx, 'gate-post-cancel');

    const outcomePromise = executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    setImmediate(() => ctrl.abort());
    await outcomePromise;

    // After the gate cancels and unsubscribes, there is no handler for gate.respond.
    // Use requestOptional to avoid a "no handler" error.
    const response = await bus.requestOptional(WorkflowSubjects.gate.respond, {
      executionId: 'exec-gate-test',
      gateId: 'gate-post-cancel',
      action: 'approve',
      resumeData: null,
    });

    // Gate was cancelled and unsubscribed — no handler remains.
    expect(response.handled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Gate resume data validation tests
// ─────────────────────────────────────────────────────────────

describe('executeGateNode — resume data passthrough', () => {
  it('passes any JsonValue as resumeData when no resumeSchema is declared', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-any-data' });
    const frameId = makeGateFrame(ctx, 'gate-any-data');

    const complexData = { nested: { value: [1, 2, 3] }, flag: true };

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-any-data',
        action: 'approve',
        resumeData: complexData,
      });
    });

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect((outcome.output as GateNodeOutput).resumeData).toEqual(complexData);
    }
  });

  it('passes null resumeData through without error', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({ id: 'gate-null-data' });
    const frameId = makeGateFrame(ctx, 'gate-null-data');

    setImmediate(() => {
      void bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-null-data',
        action: 'approve',
        resumeData: null,
      });
    });

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect((outcome.output as GateNodeOutput).resumeData).toBeNull();
    }
  });
});

describe('executeGateNode — resume data validation', () => {
  it('rejects invalid resumeData and continues waiting for a valid response', async () => {
    const { ctx, bus } = makeCtx();
    const node = makeGateNode({
      id: 'gate-validated-data',
      resumeSchema: {
        type: 'object',
        properties: { decision: { type: 'string' } },
        required: ['decision'],
        additionalProperties: false,
      },
    });
    const frameId = makeGateFrame(ctx, 'gate-validated-data');

    const acceptedResponses: boolean[] = [];
    setImmediate(async () => {
      const invalidResponse = await bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-validated-data',
        action: 'approve',
        resumeData: { decision: 123 },
      });
      acceptedResponses.push(invalidResponse.accepted);

      const validResponse = await bus.request(WorkflowSubjects.gate.respond, {
        executionId: 'exec-gate-test',
        gateId: 'gate-validated-data',
        action: 'approve',
        resumeData: { decision: 'approved' },
      });
      acceptedResponses.push(validResponse.accepted);
    });

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(acceptedResponses).toEqual([false, true]);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect((outcome.output as GateNodeOutput).resumeData).toEqual({ decision: 'approved' });
    }
  });

  it('fails before suspension when resumeSchema is not a valid JSON Schema document', async () => {
    const { ctx } = makeCtx();
    const node = makeGateNode({
      id: 'gate-invalid-schema',
      resumeSchema: { type: 123 },
    });
    const frameId = makeGateFrame(ctx, 'gate-invalid-schema');

    const outcome = await executeGateNode(node, ctx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain("Gate 'gate-invalid-schema' has an invalid resumeSchema");
    }
  });

  it('fails auto-approve timeout when the timeout resumeData does not match resumeSchema', async () => {
    vi.useFakeTimers();

    try {
      const { ctx } = makeCtx();
      const node = makeGateNode({
        id: 'gate-timeout-schema',
        autoAction: 'approve',
        timeoutMs: 1000,
        resumeSchema: {
          type: 'object',
          properties: { approved: { type: 'boolean' } },
          required: ['approved'],
          additionalProperties: false,
        },
      });
      const frameId = makeGateFrame(ctx, 'gate-timeout-schema');

      const outcomePromise = executeGateNode(node, ctx, emptyExpressionCtx, frameId);

      await vi.advanceTimersByTimeAsync(1001);
      const outcome = await outcomePromise;

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.error).toContain(
          "Gate 'gate-timeout-schema' auto-approve timeout resume data does not match resumeSchema",
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes auto-approve timeout when the timeout resumeData matches resumeSchema', async () => {
    vi.useFakeTimers();

    try {
      const { ctx } = makeCtx();
      const node = makeGateNode({
        id: 'gate-timeout-schema-match',
        autoAction: 'approve',
        timeoutMs: 1000,
        resumeSchema: {
          type: 'object',
          properties: {
            action: { const: 'approve' },
            source: { const: 'timeout' },
          },
          required: ['action', 'source'],
          additionalProperties: false,
        },
      });
      const frameId = makeGateFrame(ctx, 'gate-timeout-schema-match');

      const outcomePromise = executeGateNode(node, ctx, emptyExpressionCtx, frameId);

      await vi.advanceTimersByTimeAsync(1001);
      const outcome = await outcomePromise;

      expect(outcome.status).toBe('completed');
      if (outcome.status === 'completed') {
        expect(outcome.output).toEqual({ resumeData: { action: 'approve', source: 'timeout' } });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Gate parking tests (exit-and-redispatch strategy)
// ─────────────────────────────────────────────────────────────

describe('executeGateNode — parking (exit-and-redispatch)', () => {
  /**
   * Register a required gate lookup that proves this is a first-run gate entry.
   * @param bus - Isolated workflow test bus.
   */
  function registerMissingPersistedGate(bus: ReturnType<typeof createBusInstance>): void {
    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({ gate: null });
    });
  }

  /**
   * Register required frame persistence for successful exit-based parking tests.
   * @param bus - Isolated workflow test bus.
   */
  function registerFramePersistence(bus: ReturnType<typeof createBusInstance>): void {
    bus.on(WorkflowStorageSubjects.setFrame, (c) => {
      c.setResult({ frameId: c.payload.frame.frameId });
    });
  }

  it('parks instead of waiting when suspension strategy exits the runner', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-park' });
    const frameId = makeGateFrame(runtimeCtx, 'gate-park');
    const gateRows: unknown[] = [];
    registerMissingPersistedGate(bus);
    registerFramePersistence(bus);
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      gateRows.push(c.payload.gate);
      c.setResult({ id: c.payload.gate.frameId });
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome).toEqual({ status: 'paused', pausedAtGateId: 'gate-park', pausedAtFrameId: frameId });
    expect(runtimeCtx.getFrame(frameId)?.status).toBe('waiting');
    expect(gateRows).toContainEqual(expect.objectContaining({ status: 'waiting', frameId }));
  });

  it('parks finite-timeout gates under exit strategy', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-park-timeout', autoAction: 'approve', timeoutMs: 1000 });
    const frameId = makeGateFrame(runtimeCtx, 'gate-park-timeout');
    const gateRows: unknown[] = [];
    registerMissingPersistedGate(bus);
    registerFramePersistence(bus);
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      gateRows.push(c.payload.gate);
      c.setResult({ id: c.payload.gate.frameId });
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome).toEqual({
      status: 'paused',
      pausedAtGateId: 'gate-park-timeout',
      pausedAtFrameId: frameId,
    });
    expect(gateRows).toContainEqual(expect.objectContaining({ status: 'waiting', frameId }));
  });

  it('does not accept synchronous responses before the exit-based gate parks', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-sync-respond' });
    const frameId = makeGateFrame(runtimeCtx, 'gate-sync-respond');
    const gateRows: unknown[] = [];
    let syncResponse: Awaited<ReturnType<typeof bus.requestOptional<typeof WorkflowSubjects.gate.respond>>> | undefined;

    registerMissingPersistedGate(bus);
    registerFramePersistence(bus);
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      gateRows.push(c.payload.gate);
      c.setResult({ id: c.payload.gate.frameId });
    });
    bus.on(WorkflowSubjects.gate.suspended, async () => {
      syncResponse = await bus.requestOptional(WorkflowSubjects.gate.respond, {
        executionId: runtimeCtx.executionId,
        gateId: 'gate-sync-respond',
        frameId,
        action: 'approve',
        resumeData: { decision: 'approved' },
      });
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome).toEqual({
      status: 'paused',
      pausedAtGateId: 'gate-sync-respond',
      pausedAtFrameId: frameId,
    });
    expect(syncResponse).toEqual({ handled: false });
    expect(gateRows).toEqual([expect.objectContaining({ status: 'waiting', frameId })]);
  });

  it('fails exit-based parking when the gate storage handler is missing', async () => {
    const { ctx: runtimeCtx } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-missing-storage' });
    const frameId = makeGateFrame(runtimeCtx, 'gate-missing-storage');

    await expect(executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId)).rejects.toThrow();
  });

  it('fails exit-based parking when the waiting gate row cannot be persisted', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-storage-fails' });
    const frameId = makeGateFrame(runtimeCtx, 'gate-storage-fails');
    registerMissingPersistedGate(bus);
    bus.on(WorkflowStorageSubjects.setGateInstance, () => {
      throw new Error('gate storage unavailable');
    });

    await expect(executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId)).rejects.toThrow(
      'gate storage unavailable',
    );
  });

  it('fails exit-based parking when the waiting frame cannot be persisted', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-frame-storage-fails' });
    const frameId = makeGateFrame(runtimeCtx, 'gate-frame-storage-fails');
    registerMissingPersistedGate(bus);
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      c.setResult({ id: c.payload.gate.frameId });
    });
    bus.on(WorkflowStorageSubjects.setFrame, () => {
      throw new Error('frame storage unavailable');
    });

    await expect(executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId)).rejects.toThrow(
      'frame storage unavailable',
    );
  });

  it('completes a parked gate from a persisted rejected response with valid resume data', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-resume' });
    const frameId = makeGateFrame(runtimeCtx, 'gate-resume');
    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({
        gate: {
          executionId: runtimeCtx.executionId,
          nodeId: 'gate-resume',
          frameId,
          schema: {},
          prompt: 'Approve this action?',
          status: 'rejected',
          autoAction: 'reject',
          timeoutMs: null,
          resumeData: { decision: 'needs-changes' },
          createdAt: 1,
          resolvedAt: 2,
        },
      });
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome).toEqual({ status: 'completed', output: { resumeData: { decision: 'needs-changes' } } });
  });

  it('validates persisted resume data against the persisted gate schema on redispatch', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({
      id: 'gate-persisted-schema',
      resumeSchema: {
        type: 'object',
        required: ['currentOnly'],
        properties: { currentOnly: { type: 'boolean' } },
        additionalProperties: false,
      },
    });
    const frameId = makeGateFrame(runtimeCtx, 'gate-persisted-schema');

    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({
        gate: {
          executionId: runtimeCtx.executionId,
          nodeId: 'gate-persisted-schema',
          frameId,
          schema: {
            type: 'object',
            required: ['decision'],
            properties: { decision: { const: 'approved' } },
            additionalProperties: false,
          },
          prompt: 'Approve this action?',
          status: 'resumed',
          autoAction: 'reject',
          timeoutMs: null,
          resumeData: { decision: 'approved' },
          createdAt: 1,
          resolvedAt: 2,
        },
      });
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome).toEqual({ status: 'completed', output: { resumeData: { decision: 'approved' } } });
  });

  it('applies timeout semantics to an expired persisted waiting gate on redispatch', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-expired', timeoutMs: 1000 });
    const frameId = makeGateFrame(runtimeCtx, 'gate-expired');
    const persistedUpdates: unknown[] = [];
    const resolvedPayloads: unknown[] = [];

    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({
        gate: {
          executionId: runtimeCtx.executionId,
          nodeId: 'gate-expired',
          frameId,
          schema: {},
          prompt: 'Approve this action?',
          status: 'waiting',
          autoAction: 'reject',
          timeoutMs: 1000,
          createdAt: Date.now() - 1001,
        },
      });
    });
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      persistedUpdates.push(c.payload.gate);
      c.setResult({ id: c.payload.gate.frameId });
    });
    bus.on(WorkflowSubjects.gate.resolved, (c) => {
      resolvedPayloads.push(c.payload);
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('gate-expired');
      expect(outcome.error).toContain('1000ms');
      expect(outcome.error).toContain('auto-rejected');
    }
    expect(persistedUpdates).toContainEqual(expect.objectContaining({ status: 'timed-out', frameId }));
    expect(resolvedPayloads).toEqual([
      expect.objectContaining({
        executionId: runtimeCtx.executionId,
        stepId: 'gate-expired',
        stepType: 'gate',
        frameId,
        action: 'reject',
        source: 'timeout',
      }),
    ]);
  });

  it('auto-approves an expired persisted waiting gate on redispatch', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-expired-approve', autoAction: 'approve', timeoutMs: 1000 });
    const frameId = makeGateFrame(runtimeCtx, 'gate-expired-approve');
    const persistedUpdates: unknown[] = [];

    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({
        gate: {
          executionId: runtimeCtx.executionId,
          nodeId: 'gate-expired-approve',
          frameId,
          schema: {},
          prompt: 'Approve this action?',
          status: 'waiting',
          autoAction: 'approve',
          timeoutMs: 1000,
          createdAt: Date.now() - 1001,
        },
      });
    });
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      persistedUpdates.push(c.payload.gate);
      c.setResult({ id: c.payload.gate.frameId });
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome).toEqual({
      status: 'completed',
      output: { resumeData: { action: 'approve', source: 'timeout' } },
    });
    expect(persistedUpdates).toContainEqual(
      expect.objectContaining({
        status: 'resumed',
        frameId,
        resumeData: { action: 'approve', source: 'timeout' },
      }),
    );
  });

  it('validates persisted auto-approve timeout data against the persisted gate schema on redispatch', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({
      id: 'gate-expired-schema-policy',
      autoAction: 'reject',
      timeoutMs: 60_000,
      resumeSchema: {
        type: 'object',
        required: ['currentOnly'],
        properties: { currentOnly: { type: 'boolean' } },
        additionalProperties: false,
      },
    });
    const frameId = makeGateFrame(runtimeCtx, 'gate-expired-schema-policy');

    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({
        gate: {
          executionId: runtimeCtx.executionId,
          nodeId: 'gate-expired-schema-policy',
          frameId,
          schema: {
            type: 'object',
            properties: {
              action: { const: 'approve' },
              source: { const: 'timeout' },
            },
            required: ['action', 'source'],
            additionalProperties: false,
          },
          prompt: 'Approve this action?',
          status: 'waiting',
          autoAction: 'approve',
          timeoutMs: 1000,
          createdAt: Date.now() - 1001,
        },
      });
    });
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      c.setResult({ id: c.payload.gate.frameId });
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome).toEqual({
      status: 'completed',
      output: { resumeData: { action: 'approve', source: 'timeout' } },
    });
  });

  it('uses persisted timeout policy when redispatching an expired waiting gate', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-expired-policy', autoAction: 'reject', timeoutMs: 60_000 });
    const frameId = makeGateFrame(runtimeCtx, 'gate-expired-policy');
    const persistedUpdates: unknown[] = [];

    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({
        gate: {
          executionId: runtimeCtx.executionId,
          nodeId: 'gate-expired-policy',
          frameId,
          schema: {},
          prompt: 'Approve this action?',
          status: 'waiting',
          autoAction: 'approve',
          timeoutMs: 1000,
          createdAt: Date.now() - 1001,
        },
      });
    });
    bus.on(WorkflowStorageSubjects.setGateInstance, (c) => {
      persistedUpdates.push(c.payload.gate);
      c.setResult({ id: c.payload.gate.frameId });
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome).toEqual({
      status: 'completed',
      output: { resumeData: { action: 'approve', source: 'timeout' } },
    });
    expect(persistedUpdates).toContainEqual(
      expect.objectContaining({
        status: 'resumed',
        resumeData: { action: 'approve', source: 'timeout' },
      }),
    );
  });

  it('carries reason through gate.resolved on redispatch when persisted gate row includes it', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-parked-reason' });
    const frameId = makeGateFrame(runtimeCtx, 'gate-parked-reason');
    const resolvedPayloads: unknown[] = [];

    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({
        gate: {
          executionId: runtimeCtx.executionId,
          nodeId: 'gate-parked-reason',
          frameId,
          schema: {},
          prompt: 'Approve this action?',
          status: 'resumed',
          autoAction: 'reject',
          timeoutMs: null,
          resumeData: { decision: 'approved' },
          reason: 'Signed off after security review',
          createdAt: 1,
          resolvedAt: 2,
        },
      });
    });
    bus.on(WorkflowSubjects.gate.resolved, (c) => {
      resolvedPayloads.push(c.payload);
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome).toEqual({ status: 'completed', output: { resumeData: { decision: 'approved' } } });
    expect(resolvedPayloads).toEqual([
      expect.objectContaining({
        executionId: runtimeCtx.executionId,
        stepId: 'gate-parked-reason',
        action: 'approve',
        source: 'user',
        reason: 'Signed off after security review',
      }),
    ]);
  });

  it('does not include reason in gate.resolved on redispatch when persisted gate row omits it', async () => {
    const { ctx: runtimeCtx, bus } = makeCtx({ suspensionStrategy: 'exit-and-redispatch' });
    const node = makeGateNode({ id: 'gate-parked-no-reason' });
    const frameId = makeGateFrame(runtimeCtx, 'gate-parked-no-reason');
    const resolvedPayloads: unknown[] = [];

    bus.on(WorkflowStorageSubjects.getGateInstance, (c) => {
      c.setResult({
        gate: {
          executionId: runtimeCtx.executionId,
          nodeId: 'gate-parked-no-reason',
          frameId,
          schema: {},
          prompt: 'Approve this action?',
          status: 'resumed',
          autoAction: 'reject',
          timeoutMs: null,
          resumeData: { decision: 'approved' },
          createdAt: 1,
          resolvedAt: 2,
        },
      });
    });
    bus.on(WorkflowSubjects.gate.resolved, (c) => {
      resolvedPayloads.push(c.payload);
    });

    const outcome = await executeGateNode(node, runtimeCtx, emptyExpressionCtx, frameId);

    expect(outcome).toEqual({ status: 'completed', output: { resumeData: { decision: 'approved' } } });
    expect(resolvedPayloads[0]).not.toHaveProperty('reason');
  });
});
