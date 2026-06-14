import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance, ValidationError } from '@makaio/bus-core';
import {
  AgentSubjects,
  SessionSubjects,
  SubagentSubjects,
  WorkflowNamespace,
  WorkflowSubjects,
  type JsonValue,
  type SpanRecord,
  type StationHandler,
  type WorkflowDefinition,
  type WorkflowDelegateAgentNode,
  type WorkflowDelegateRoleNode,
  type WorkflowExecution,
  type WorkflowFrameState,
  type WorkflowIterateNode,
  type WorkflowParallelNode,
  type WorkflowSequenceNode,
  type WorkflowStationNode,
} from '@makaio/contracts';
import { RuntimeContext } from '../runtime/runtime-context.js';
import { executeStationNode } from '../runtime/station-node.js';
import { createWorkflowStateContext } from '../runtime/workflow-state-context.js';
import { executeDelegateAgentNode, executeDelegateRoleNode } from '../runtime/delegate-node.js';
import { executeRoleSubagentNode } from '../runtime/role-subagent-node.js';
import { executeParallelNode, type ParallelOutput } from '../runtime/parallel-node.js';
import { executeSequence } from '../runtime/primitive-runtime.js';
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
 *
 * Each test gets its own bus instance so handler registrations do not bleed
 * across tests (no shared global state from the test-global MakaioBus).
 */
function makeBus(): ReturnType<typeof createBusInstance> {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  return bus;
}

/**
 * Create a fresh RuntimeContext with an isolated bus.
 * @param handlers - Station handlers keyed by node ID.
 * @param signal - Optional abort signal.
 */
function makeCtx(
  handlers: Record<string, StationHandler>,
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

const SESSION_LINK_TEST_CLEANUP_TIMEOUT_MS = 60_000;

// ─────────────────────────────────────────────────────────────
// Station node tests
// ─────────────────────────────────────────────────────────────

describe('executeStationNode', () => {
  it('calls the registered handler and returns its output', async () => {
    const node: WorkflowStationNode = {
      id: 'greet',
      type: 'station',
      prompt: 'Say hello',
    };

    const handler: StationHandler = async (ctx) => {
      const inputs =
        ctx.inputs !== null && typeof ctx.inputs === 'object' && !Array.isArray(ctx.inputs)
          ? (ctx.inputs as Record<string, unknown>)
          : {};
      const name = (inputs['name'] as string | undefined) ?? 'world';
      return `Hello, ${name}!`;
    };

    const ctx = makeCtx({ greet: handler });
    const outcome = await executeStationNode(node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.output).toBe('Hello, world!');
    }
  });

  it('passes execution inputs and config to the handler', async () => {
    const node: WorkflowStationNode = {
      id: 'echo-input',
      type: 'station',
      prompt: 'Echo the input',
    };

    const received: unknown[] = [];
    const handler: StationHandler = (ctx) => {
      received.push({ inputs: ctx.inputs, config: ctx.config });
      return 'ok';
    };

    const bus = makeBus();
    const ctx = new RuntimeContext(
      'exec-1',
      'workflow-1',
      makeDefinition('workflow-1'),
      {
        ...makeExecution('workflow-1'),
        inputs: { key: 'value' },
        config: { mode: 'strict' },
      },
      new Map([['echo-input', handler]]),
      bus,
      new AbortController().signal,
    );

    await executeStationNode(node, ctx, emptyExpressionCtx);

    expect(received[0]).toEqual({ inputs: { key: 'value' }, config: { mode: 'strict' } });
  });

  it('passes previousSteps from completed frames in the expression context', async () => {
    const node: WorkflowStationNode = {
      id: 'consumer',
      type: 'station',
      prompt: 'Use previous step',
    };

    let receivedPreviousSteps: unknown;
    const handler: StationHandler = (ctx) => {
      receivedPreviousSteps = ctx.previousSteps;
      return null;
    };

    const expressionCtx = {
      inputs: {},
      trigger: {},
      previousSteps: {},
      frames: {
        'prior-step': { status: 'completed' as const, output: { result: 42 } },
        'skipped-step': { status: 'skipped' as const },
        'failed-step': { status: 'failed' as const },
      },
    };

    const ctx = makeCtx({ consumer: handler });
    await executeStationNode(node, ctx, expressionCtx);

    expect(receivedPreviousSteps).toMatchObject({
      'prior-step': { status: 'completed', output: { result: 42 } },
      'skipped-step': { status: 'skipped' },
    });
    // Failed frames are excluded from previousSteps.
    expect((receivedPreviousSteps as Record<string, unknown>)['failed-step']).toBeUndefined();
  });

  it('emits structured progress updates with execution, workflow, frame, and node identity', async () => {
    const node: WorkflowStationNode = {
      id: 'progress-station',
      type: 'station',
      prompt: 'Report progress',
    };
    const handler: StationHandler = async (ctx) => {
      await ctx.updateProgress({
        message: 'Review draft ready',
        details: 'The review artifact has been updated.',
        kind: 'checkpoint',
        metadata: { artifactId: 'artifact-1', percent: 50 },
      });
      return 'done';
    };
    const ctx = makeCtx({ 'progress-station': handler });
    let receivedPayload: unknown;
    const unsubscribe = ctx.bus.on(WorkflowSubjects.execution.progress, (eventCtx) => {
      receivedPayload = eventCtx.payload;
    });

    const outcome = await executeStationNode(node, ctx, emptyExpressionCtx, 'frame-progress');

    expect(outcome.status).toBe('completed');
    expect(receivedPayload).toMatchObject({
      executionId: 'exec-test',
      workflowId: 'workflow-test',
      frameId: 'frame-progress',
      nodeId: 'progress-station',
      progress: {
        message: 'Review draft ready',
        details: 'The review artifact has been updated.',
        kind: 'checkpoint',
        metadata: { artifactId: 'artifact-1', percent: 50 },
      },
    });
    expect((receivedPayload as { emittedAt: number }).emittedAt).toBeGreaterThan(0);
    unsubscribe();
  });

  it('fails the station when updateProgress receives a payload rejected by the progress schema', async () => {
    const node: WorkflowStationNode = {
      id: 'invalid-progress',
      type: 'station',
      prompt: 'Report invalid progress',
    };
    const handler: StationHandler = async (ctx) => {
      await ctx.updateProgress({ message: '' });
      return 'done';
    };
    const ctx = makeCtx({ 'invalid-progress': handler });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const outcome = await executeStationNode(node, ctx, emptyExpressionCtx, 'frame-invalid-progress');

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.error).toContain('message');
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not fail the station when a progress subscriber fails', async () => {
    const node: WorkflowStationNode = {
      id: 'progress-observer-failure',
      type: 'station',
      prompt: 'Report progress',
    };
    const handler: StationHandler = async (ctx) => {
      await ctx.updateProgress({ message: 'Observer may fail' });
      return 'done';
    };
    const ctx = makeCtx({ 'progress-observer-failure': handler });
    const unsubscribe = ctx.bus.on(WorkflowSubjects.execution.progress, () => {
      throw new Error('subscriber exploded');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const outcome = await executeStationNode(node, ctx, emptyExpressionCtx, 'frame-observer-failure');

      expect(outcome.status).toBe('completed');
    } finally {
      consoleError.mockRestore();
      unsubscribe();
    }
  });

  it('does not fail the station when a progress subscriber throws a ValidationError', async () => {
    const node: WorkflowStationNode = {
      id: 'progress-validation-observer-failure',
      type: 'station',
      prompt: 'Report progress',
    };
    const handler: StationHandler = async (ctx) => {
      await ctx.updateProgress({ message: 'Observer validation may fail' });
      return 'done';
    };
    const ctx = makeCtx({ 'progress-validation-observer-failure': handler });
    const unsubscribe = ctx.bus.on(WorkflowSubjects.execution.progress, () => {
      const parsed = z.object({ value: z.string() }).safeParse({ value: 1 });
      if (!parsed.success) {
        throw new ValidationError('subscriber.validation', parsed.error);
      }
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const outcome = await executeStationNode(node, ctx, emptyExpressionCtx, 'frame-validation-observer-failure');

      expect(outcome.status).toBe('completed');
    } finally {
      consoleError.mockRestore();
      unsubscribe();
    }
  });

  it('fails with a descriptive message when no handler is registered', async () => {
    const node: WorkflowStationNode = {
      id: 'no-handler',
      type: 'station',
      prompt: 'Orphan station',
    };

    const ctx = makeCtx({});
    const outcome = await executeStationNode(node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('no-handler');
    }
  });

  it('runs role-backed stations through the subagent seam when no handler is registered', async () => {
    const node: WorkflowStationNode = {
      id: 'role-station',
      type: 'station',
      prompt: 'Review {{ input.title }}',
      role: 'reviewer',
      outputSchema: { type: 'object' },
      timeoutMs: 1_000,
    };
    const ctx = makeCtx({});
    const spawned: unknown[] = [];
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      expect(requestCtx.payload.roleId).toBe('reviewer');
      requestCtx.setResult({
        adapterName: 'claude-code',
        model: 'sonnet',
        harnessId: 'review-harness',
        contextMode: 'fresh',
      });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      spawned.push(requestCtx.payload);
      requestCtx.setResult({ subagentId: 'subagent-role-station', status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      expect(requestCtx.payload).toEqual({ subagentId: 'subagent-role-station', timeoutMs: 1_000 });
      requestCtx.setResult({ status: 'completed', result: 'review complete' });
    });

    try {
      const outcome = await executeStationNode(node, ctx, {
        ...emptyExpressionCtx,
        inputs: { title: 'the implementation' },
      });

      expect(outcome).toEqual({ status: 'completed', output: 'review complete' });
      expect(spawned).toHaveLength(1);
      const spawnPayload = spawned[0] as {
        parentSessionId: string;
        depth: number;
        config: Record<string, unknown>;
      };
      // Isolated runtime-node tests do not create a coordinator session, so
      // role-backed stations fall back to the execution ID for subagent lineage.
      expect(spawnPayload.parentSessionId).toBe('exec-test');
      expect(spawnPayload.depth).toBe(1);
      expect(spawnPayload.config).toMatchObject({
        task: 'Review the implementation',
        adapterName: 'claude-code',
        model: 'sonnet',
        harnessId: 'review-harness',
        contextMode: 'fresh',
        responseSchema: { schema: { type: 'object' } },
      });
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
    }
  });

  it('prefers a registered station handler over a station role', async () => {
    const node: WorkflowStationNode = {
      id: 'handler-wins',
      type: 'station',
      prompt: 'Use the role only when no handler exists',
      role: 'reviewer',
    };
    const handler: StationHandler = () => 'handler result';
    const ctx = makeCtx({ 'handler-wins': handler });
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, () => {
      throw new Error('Role resolver should not run when a handler is registered.');
    });

    try {
      const outcome = await executeStationNode(node, ctx, emptyExpressionCtx);

      expect(outcome).toEqual({ status: 'completed', output: 'handler result' });
    } finally {
      unsubscribeRole();
    }
  });

  it('fails role-backed stations when the role cannot resolve', async () => {
    const node: WorkflowStationNode = {
      id: 'missing-role',
      type: 'station',
      prompt: 'Resolve role',
      role: 'unknown-role',
    };
    const ctx = makeCtx({});

    const outcome = await executeStationNode(node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain("role 'unknown-role' could not be resolved");
    }
  });

  it('fails role-backed stations when subagent runtime is unavailable', async () => {
    const node: WorkflowStationNode = {
      id: 'missing-subagent',
      type: 'station',
      prompt: 'Run role',
      role: 'reviewer',
    };
    const ctx = makeCtx({});
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });

    try {
      const outcome = await executeStationNode(node, ctx, emptyExpressionCtx);

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.error).toContain('Subagent runtime is not available');
      }
    } finally {
      unsubscribeRole();
    }
  });

  it('fails role-backed stations when the subagent runtime cannot await', async () => {
    const node: WorkflowStationNode = {
      id: 'missing-await',
      type: 'station',
      prompt: 'Run role',
      role: 'reviewer',
    };
    const ctx = makeCtx({});
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-missing-await', status: 'spawning' });
    });

    try {
      const outcome = await executeStationNode(node, ctx, emptyExpressionCtx);

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.error).toContain("Subagent runtime cannot await station node 'missing-await'");
      }
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
    }
  });

  it.each([
    {
      awaitStatus: 'failed' as const,
      awaitError: 'review failed',
      expected: { status: 'failed' as const, error: "Station node 'subagent-failed' subagent failed: review failed" },
    },
    {
      awaitStatus: 'cancelled' as const,
      awaitError: undefined,
      expected: { status: 'cancelled' as const },
    },
  ])('maps role-backed station subagent $awaitStatus results to node outcomes', async (scenario) => {
    const node: WorkflowStationNode = {
      id: `subagent-${scenario.awaitStatus}`,
      type: 'station',
      prompt: 'Run role',
      role: 'reviewer',
    };
    const ctx = makeCtx({});
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: `subagent-${scenario.awaitStatus}`, status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({
        status: scenario.awaitStatus,
        ...(scenario.awaitError !== undefined ? { error: scenario.awaitError } : {}),
      });
    });

    try {
      await expect(executeStationNode(node, ctx, emptyExpressionCtx)).resolves.toEqual(scenario.expected);
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
    }
  });

  it('cancels and kills role-backed station subagents when the workflow is aborted', async () => {
    const node: WorkflowStationNode = {
      id: 'abort-role-station',
      type: 'station',
      prompt: 'Run role',
      role: 'reviewer',
    };
    const controller = new AbortController();
    const ctx = makeCtx({}, controller.signal);
    let resolveAwaitEntered!: () => void;
    const awaitEntered = new Promise<void>((resolve) => {
      resolveAwaitEntered = resolve;
    });
    let releaseAwait!: () => void;
    const awaitRelease = new Promise<void>((resolve) => {
      releaseAwait = resolve;
    });
    let killPayload: unknown;
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-abort-role-station', status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, async (requestCtx) => {
      resolveAwaitEntered();
      await awaitRelease;
      requestCtx.setResult({ status: 'cancelled' });
    });
    const unsubscribeKill = ctx.bus.on(SubagentSubjects.kill, (requestCtx) => {
      killPayload = requestCtx.payload;
      releaseAwait();
      requestCtx.setResult({ killed: true });
    });

    try {
      const outcomePromise = executeStationNode(node, ctx, emptyExpressionCtx);
      await awaitEntered;
      controller.abort();

      await expect(outcomePromise).resolves.toEqual({ status: 'cancelled' });
      expect(killPayload).toEqual({
        subagentId: 'subagent-abort-role-station',
        reason: "Workflow execution 'exec-test' cancelled station 'abort-role-station'",
      });
    } finally {
      releaseAwait();
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
      unsubscribeKill();
    }
  });

  it('returns cancelled when role-backed station child kill fails during abort cleanup', async () => {
    const node: WorkflowStationNode = {
      id: 'abort-kill-fails',
      type: 'station',
      prompt: 'Run role',
      role: 'reviewer',
    };
    const controller = new AbortController();
    const ctx = makeCtx({}, controller.signal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let resolveAwaitEntered!: () => void;
    const awaitEntered = new Promise<void>((resolve) => {
      resolveAwaitEntered = resolve;
    });
    let releaseAwait!: () => void;
    const awaitRelease = new Promise<void>((resolve) => {
      releaseAwait = resolve;
    });
    let killPayload: unknown;
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-abort-kill-fails', status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, async (requestCtx) => {
      resolveAwaitEntered();
      await awaitRelease;
      requestCtx.setResult({ status: 'cancelled' });
    });
    const unsubscribeKill = ctx.bus.on(SubagentSubjects.kill, (requestCtx) => {
      killPayload = requestCtx.payload;
      throw new Error('kill handler failed');
    });

    try {
      const outcomePromise = executeStationNode(node, ctx, emptyExpressionCtx);
      await awaitEntered;
      controller.abort();

      await expect(outcomePromise).resolves.toEqual({ status: 'cancelled' });
      expect(killPayload).toEqual({
        subagentId: 'subagent-abort-kill-fails',
        reason: "Workflow execution 'exec-test' cancelled station 'abort-kill-fails'",
      });
      expect(warn).toHaveBeenCalledWith(
        "[workflow-engine] Best-effort subagent kill failed for 'subagent-abort-kill-fails' (station 'abort-kill-fails')",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
      releaseAwait();
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
      unsubscribeKill();
    }
  });

  it('emits frame.sessionLinked after a role-backed node obtains a child session', async () => {
    const links: Array<{ executionId: string; frameId: string; sessionId: string }> = [];
    const ctx = makeCtx({});
    const cleanupLink = ctx.bus.on(WorkflowSubjects.frame.sessionLinked, (eventCtx) => {
      links.push(eventCtx.payload);
    });
    const cleanupRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({
        adapterName: 'test-adapter',
        model: 'test-model',
      });
    });
    const cleanupSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-role-station', status: 'spawning' });
    });
    const cleanupStatus = ctx.bus.on(SubagentSubjects.getStatus, (requestCtx) => {
      expect(requestCtx.payload.subagentId).toBe('subagent-role-station');
      requestCtx.setResult({
        status: 'running',
        childSessionId: 'sess-child',
        progress: [],
      });
    });
    const cleanupAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({ status: 'completed', result: 'done' });
    });

    try {
      const outcome = await executeRoleSubagentNode(
        {
          nodeId: 'analyze',
          nodeLabel: 'Station node',
          roleId: 'reviewer',
          prompt: 'Analyze',
          unresolvedRoleError: 'role missing',
          unavailableRuntimeError: 'runtime missing',
          unavailableAwaitError: 'await missing',
          cancellationLabel: 'station',
          frameId: 'frame-analyze',
        },
        ctx,
        emptyExpressionCtx,
      );

      expect(outcome).toEqual({ status: 'completed', output: 'done' });
      expect(links).toEqual([
        {
          executionId: ctx.executionId,
          frameId: 'frame-analyze',
          sessionId: 'sess-child',
        },
      ]);
    } finally {
      cleanupAwait();
      cleanupStatus();
      cleanupSpawn();
      cleanupRole();
      cleanupLink();
    }
  });

  it('emits frame.sessionLinked when the child session appears after await', async () => {
    const links: Array<{ executionId: string; frameId: string; sessionId: string }> = [];
    const ctx = makeCtx({});
    let childSessionReady = false;
    const cleanupLink = ctx.bus.on(WorkflowSubjects.frame.sessionLinked, (eventCtx) => {
      links.push(eventCtx.payload);
    });
    const cleanupRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({
        adapterName: 'test-adapter',
        model: 'test-model',
      });
    });
    const cleanupSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-delayed-session', status: 'spawning' });
    });
    const cleanupStatus = ctx.bus.on(SubagentSubjects.getStatus, (requestCtx) => {
      expect(requestCtx.payload.subagentId).toBe('subagent-delayed-session');
      requestCtx.setResult({
        status: 'running',
        ...(childSessionReady ? { childSessionId: 'sess-delayed-child' } : {}),
        progress: [],
      });
    });
    const cleanupAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      childSessionReady = true;
      requestCtx.setResult({ status: 'completed', result: 'done after delayed link' });
    });

    try {
      const outcome = await executeRoleSubagentNode(
        {
          nodeId: 'delayed-link',
          nodeLabel: 'Station node',
          roleId: 'reviewer',
          prompt: 'Analyze',
          unresolvedRoleError: 'role missing',
          unavailableRuntimeError: 'runtime missing',
          unavailableAwaitError: 'await missing',
          cancellationLabel: 'station',
          frameId: 'frame-delayed-link',
        },
        ctx,
        emptyExpressionCtx,
      );

      expect(outcome).toEqual({ status: 'completed', output: 'done after delayed link' });
      expect(links).toEqual([
        {
          executionId: ctx.executionId,
          frameId: 'frame-delayed-link',
          sessionId: 'sess-delayed-child',
        },
      ]);
    } finally {
      cleanupAwait();
      cleanupStatus();
      cleanupSpawn();
      cleanupRole();
      cleanupLink();
    }
  });

  it('continues execution when frame session status polling times out', async () => {
    vi.useFakeTimers();

    const ctx = makeCtx({});
    const cleanupRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'test-adapter' });
    });
    const cleanupSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-status-timeout', status: 'spawning' });
    });
    const cleanupStatus = ctx.bus.on(SubagentSubjects.getStatus, () => new Promise(() => undefined));
    const cleanupAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({ status: 'completed', result: 'done after timeout' });
    });

    const outcomePromise = executeRoleSubagentNode(
      {
        nodeId: 'timeout-link',
        nodeLabel: 'Station node',
        roleId: 'reviewer',
        prompt: 'Analyze',
        unresolvedRoleError: 'role missing',
        unavailableRuntimeError: 'runtime missing',
        unavailableAwaitError: 'await missing',
        cancellationLabel: 'station',
        frameId: 'frame-timeout-link',
      },
      ctx,
      emptyExpressionCtx,
    );
    let settledOutcome: unknown;
    void outcomePromise.then((outcome) => {
      settledOutcome = outcome;
    });

    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(settledOutcome).toEqual({ status: 'completed', output: 'done after timeout' });
    } finally {
      if (settledOutcome === undefined) {
        await vi.advanceTimersByTimeAsync(SESSION_LINK_TEST_CLEANUP_TIMEOUT_MS);
      }
      await outcomePromise.catch(() => undefined);
      cleanupAwait();
      cleanupStatus();
      cleanupSpawn();
      cleanupRole();
      vi.useRealTimers();
    }
  });

  it('passes the workflow abort signal to frame session status polling', async () => {
    const controller = new AbortController();
    const ctx = makeCtx({}, controller.signal);
    const requestOptionalSpy = vi.spyOn(ctx.bus, 'requestOptional');
    const cleanupRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'test-adapter' });
    });
    const cleanupSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-status-signal', status: 'spawning' });
    });
    const cleanupStatus = ctx.bus.on(SubagentSubjects.getStatus, (requestCtx) => {
      requestCtx.setResult({
        status: 'running',
        progress: [],
      });
    });
    const cleanupAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({ status: 'completed', result: 'done with signal' });
    });

    try {
      await expect(
        executeRoleSubagentNode(
          {
            nodeId: 'signal-link',
            nodeLabel: 'Station node',
            roleId: 'reviewer',
            prompt: 'Analyze',
            unresolvedRoleError: 'role missing',
            unavailableRuntimeError: 'runtime missing',
            unavailableAwaitError: 'await missing',
            cancellationLabel: 'station',
            frameId: 'frame-signal-link',
          },
          ctx,
          emptyExpressionCtx,
        ),
      ).resolves.toEqual({ status: 'completed', output: 'done with signal' });

      expect(requestOptionalSpy).toHaveBeenCalledWith(
        SubagentSubjects.getStatus,
        { subagentId: 'subagent-status-signal' },
        expect.objectContaining({ signal: controller.signal, timeout: expect.any(Number) }),
      );
    } finally {
      requestOptionalSpy.mockRestore();
      cleanupAwait();
      cleanupStatus();
      cleanupSpawn();
      cleanupRole();
    }
  });

  it('issues the subagent await request without the bus envelope timeout', async () => {
    const ctx = makeCtx({});
    const requestOptionalSpy = vi.spyOn(ctx.bus, 'requestOptional');
    const cleanupRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'test-adapter' });
    });
    const cleanupSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-await-options', status: 'spawning' });
    });
    const cleanupAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({ status: 'completed', result: 'long-running done' });
    });

    try {
      await expect(
        executeRoleSubagentNode(
          {
            nodeId: 'await-options',
            nodeLabel: 'Station node',
            roleId: 'reviewer',
            prompt: 'Analyze',
            timeoutMs: 90_000,
            unresolvedRoleError: 'role missing',
            unavailableRuntimeError: 'runtime missing',
            unavailableAwaitError: 'await missing',
            cancellationLabel: 'station',
          },
          ctx,
          emptyExpressionCtx,
        ),
      ).resolves.toEqual({ status: 'completed', output: 'long-running done' });

      // The await RPC must opt out of the bus envelope's 60s default
      // (`timeout: 0`); the semantic deadline travels in the payload and is
      // enforced by the subagent service handler. Without the option, every
      // delegate turn longer than 60s dies regardless of node.timeoutMs.
      expect(requestOptionalSpy).toHaveBeenCalledWith(
        SubagentSubjects.await,
        { subagentId: 'subagent-await-options', timeoutMs: 90_000 },
        { timeout: 0 },
      );
    } finally {
      requestOptionalSpy.mockRestore();
      cleanupAwait();
      cleanupSpawn();
      cleanupRole();
    }
  });

  it('stops frame session polling immediately when aborted between attempts', async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const ctx = makeCtx({}, controller.signal);
    let statusCalls = 0;
    const cleanupRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'test-adapter' });
    });
    const cleanupSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-status-abort-delay', status: 'spawning' });
    });
    const cleanupStatus = ctx.bus.on(SubagentSubjects.getStatus, (requestCtx) => {
      statusCalls += 1;
      requestCtx.setResult({
        status: 'running',
        progress: [],
      });
    });
    const cleanupAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({ status: 'completed', result: 'should not await' });
    });
    const cleanupKill = ctx.bus.on(SubagentSubjects.kill, (requestCtx) => {
      requestCtx.setResult({ killed: true });
    });

    const outcomePromise = executeRoleSubagentNode(
      {
        nodeId: 'abort-delay-link',
        nodeLabel: 'Station node',
        roleId: 'reviewer',
        prompt: 'Analyze',
        unresolvedRoleError: 'role missing',
        unavailableRuntimeError: 'runtime missing',
        unavailableAwaitError: 'await missing',
        cancellationLabel: 'station',
        frameId: 'frame-abort-delay-link',
      },
      ctx,
      emptyExpressionCtx,
    );
    let settledOutcome: unknown;
    void outcomePromise.then((outcome) => {
      settledOutcome = outcome;
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(statusCalls).toBe(1);

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(settledOutcome).toEqual({ status: 'cancelled' });
      expect(statusCalls).toBe(1);
    } finally {
      if (settledOutcome === undefined) {
        await vi.advanceTimersByTimeAsync(SESSION_LINK_TEST_CLEANUP_TIMEOUT_MS);
      }
      await outcomePromise.catch(() => undefined);
      cleanupKill();
      cleanupAwait();
      cleanupStatus();
      cleanupSpawn();
      cleanupRole();
      vi.useRealTimers();
    }
  });

  it('passes the bus into station step contexts', async () => {
    const bus = makeBus();
    let receivedBus: unknown;

    const node: WorkflowStationNode = {
      id: 'capture-bus',
      type: 'station',
      prompt: 'Capture bus reference',
    };
    const handler: StationHandler = (ctx) => {
      receivedBus = ctx.bus;
      return { ok: true };
    };
    const ctx = new RuntimeContext(
      'exec-bus-context',
      'workflow-bus-context',
      makeDefinition('workflow-bus-context'),
      makeExecution('workflow-bus-context'),
      new Map([['capture-bus', handler]]),
      bus,
      new AbortController().signal,
    );

    const outcome = await executeStationNode(node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(receivedBus).toBe(bus);
  });

  it('propagates handler errors as failed outcomes', async () => {
    const node: WorkflowStationNode = {
      id: 'broken',
      type: 'station',
      prompt: 'Throw',
    };

    const handler: StationHandler = () => {
      throw new Error('Handler exploded');
    };

    const ctx = makeCtx({ broken: handler });
    const outcome = await executeStationNode(node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toBe('Handler exploded');
    }
  });

  it('returns cancelled when the signal is already aborted', async () => {
    const node: WorkflowStationNode = {
      id: 'slow',
      type: 'station',
      prompt: 'Slow work',
    };

    const handler: StationHandler = () => 'should not run';
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    const ctx = makeCtx({ slow: handler }, abortCtrl.signal);
    const outcome = await executeStationNode(node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('cancelled');
  });

  it('passes the abort signal to the handler', async () => {
    const node: WorkflowStationNode = {
      id: 'check-signal',
      type: 'station',
      prompt: 'Check signal',
    };

    let capturedSignal: AbortSignal | undefined;
    const handler: StationHandler = (ctx) => {
      capturedSignal = ctx.signal;
      return null;
    };

    const abortCtrl = new AbortController();
    const ctx = makeCtx({ 'check-signal': handler }, abortCtrl.signal);
    await executeStationNode(node, ctx, emptyExpressionCtx);

    expect(capturedSignal).toBe(abortCtrl.signal);
  });

  it('passes platform context and environment from the runtime context to the handler', async () => {
    const node: WorkflowStationNode = {
      id: 'platform-context',
      type: 'station',
      prompt: 'Read platform context',
    };

    let receivedContext:
      | Pick<Parameters<StationHandler>[0], 'repoPath' | 'makaioHome' | 'os' | 'arch' | 'worktree' | 'env'>
      | undefined;
    const handler: StationHandler = (ctx) => {
      receivedContext = {
        repoPath: ctx.repoPath,
        makaioHome: ctx.makaioHome,
        os: ctx.os,
        arch: ctx.arch,
        worktree: ctx.worktree,
        env: ctx.env,
      };
      return null;
    };

    const bus = makeBus();
    const ctx = new RuntimeContext(
      'exec-platform',
      'workflow-platform',
      makeDefinition('workflow-platform'),
      makeExecution('workflow-platform'),
      new Map([['platform-context', handler]]),
      bus,
      new AbortController().signal,
      undefined,
      undefined,
      {
        context: {
          repoPath: '/repo/runtime',
          makaioHome: '/home/runtime/.makaio',
          os: 'linux',
          arch: 'arm64',
          worktree: '/repo/runtime/worktree',
        },
        env: { WORKFLOW_ENV: 'present' },
      },
    );

    await executeStationNode(node, ctx, emptyExpressionCtx);

    expect(receivedContext).toEqual({
      repoPath: '/repo/runtime',
      makaioHome: '/home/runtime/.makaio',
      os: 'linux',
      arch: 'arm64',
      worktree: '/repo/runtime/worktree',
      env: { WORKFLOW_ENV: 'present' },
    });
  });
});

describe('executeDelegateNode', () => {
  it('runs delegate-role nodes through a session turn', async () => {
    const node: WorkflowDelegateRoleNode = {
      id: 'review-delegate',
      type: 'delegate-role',
      role: 'reviewer',
      prompt: 'Review {{ ctx.inputs.title }}',
      outputSchema: { type: 'object' },
      timeoutMs: 1_000,
      completion: 'turn',
    };
    const ctx = makeCtx({});
    const createdSessions: unknown[] = [];
    const attachedAgents: unknown[] = [];
    const sentMessages: unknown[] = [];
    const awaitedTurns: unknown[] = [];
    const closedSessions: unknown[] = [];

    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      expect(requestCtx.payload.roleId).toBe('reviewer');
      requestCtx.setResult({
        adapterName: 'claude-code',
        model: 'sonnet',
        reasoningEffort: 'high',
        systemPrompt: 'Review carefully.',
        providerContext: {
          providerConfigId: 'provider-config-review',
          definitionId: 'provider-definition-review',
          credentialRefs: {},
        },
      });
    });
    const unsubscribeCreate = ctx.bus.on(SessionSubjects.create, (requestCtx) => {
      createdSessions.push(requestCtx.payload);
      requestCtx.setResult({ sessionId: requestCtx.payload.sessionId ?? 'workflow-session-review-delegate' });
    });
    const unsubscribeAttach = ctx.bus.on(SessionSubjects.agent.attach, (requestCtx) => {
      attachedAgents.push(requestCtx.payload);
      requestCtx.setResult({
        agentId: 'agent-review-delegate',
        adapterSessionId: 'adapter-session-review-delegate',
        role: 'lead',
      });
    });
    const unsubscribeSendMessage = ctx.bus.on(SessionSubjects.sendMessage, async (requestCtx) => {
      sentMessages.push(requestCtx.payload);
      await ctx.bus.emit(AgentSubjects.complete, {
        agentId: 'agent-review-delegate',
        adapterId: 'adapter-review-delegate',
        adapterName: 'claude-code',
        adapterSessionId: 'adapter-session-review-delegate',
        sessionId: requestCtx.payload.sessionId,
        messageId: 'message-review-delegate',
        turnId: 'turn-review-delegate',
        message: '{"approved":true}',
      });
      requestCtx.setResult({
        sessionId: requestCtx.payload.sessionId,
        messageId: 'message-review-delegate',
        turnId: 'turn-review-delegate',
      });
    });
    const unsubscribeTurnAwait = ctx.bus.on(SessionSubjects.turn.await, (requestCtx) => {
      awaitedTurns.push(requestCtx.payload);
      requestCtx.setResult({
        completion: {
          sessionId: requestCtx.payload.sessionId,
          turnId: requestCtx.payload.turnId,
          turnNumber: 1,
          success: true,
        },
      });
    });
    const unsubscribeClose = ctx.bus.on(SessionSubjects.close, (requestCtx) => {
      closedSessions.push(requestCtx.payload);
      requestCtx.setResult({ success: true });
    });

    try {
      const outcome = await executeDelegateRoleNode(
        node,
        ctx,
        {
          ...emptyExpressionCtx,
          inputs: { title: 'workflow runtime' },
        },
        'frame-review-delegate',
      );

      expect(outcome).toEqual({ status: 'completed', output: '{"approved":true}' });
      expect(createdSessions).toEqual([
        expect.objectContaining({
          parentSessionId: 'exec-test',
          branchKind: 'subagent',
          title: "Workflow delegate-role 'review-delegate'",
        }),
      ]);
      expect(attachedAgents).toEqual([
        expect.objectContaining({
          sessionId: expect.any(String),
          role: 'lead',
          agent: expect.objectContaining({
            kind: 'adapter',
            adapterName: 'claude-code',
            model: 'sonnet',
            reasoningEffort: 'high',
            providerConfigId: 'provider-config-review',
            systemPrompt: 'Review carefully.',
          }),
        }),
      ]);
      expect(sentMessages).toEqual([
        expect.objectContaining({
          sessionId: expect.any(String),
          message: 'Review workflow runtime',
          responseSchema: { schema: { type: 'object' } },
          source: 'system',
        }),
      ]);
      expect(sentMessages[0]).not.toHaveProperty('agent');
      expect(awaitedTurns).toEqual([
        {
          sessionId: expect.any(String),
          turnId: 'turn-review-delegate',
          timeoutMs: 1_000,
        },
      ]);
      expect(closedSessions).toEqual([{ sessionId: expect.any(String) }]);
    } finally {
      unsubscribeRole();
      unsubscribeCreate();
      unsubscribeAttach();
      unsubscribeSendMessage();
      unsubscribeTurnAwait();
      unsubscribeClose();
    }
  });

  it('closes delegate-role child sessions when attach is unavailable', async () => {
    const node: WorkflowDelegateRoleNode = {
      id: 'review-delegate-unavailable',
      type: 'delegate-role',
      role: 'reviewer',
      prompt: 'Review {{ ctx.inputs.title }}',
      completion: 'turn',
    };
    const ctx = makeCtx({});
    const closedSessions: unknown[] = [];

    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({
        adapterName: 'claude-code',
        model: 'sonnet',
      });
    });
    const unsubscribeCreate = ctx.bus.on(SessionSubjects.create, (requestCtx) => {
      requestCtx.setResult({ sessionId: requestCtx.payload.sessionId ?? 'workflow-session-review-delegate' });
    });
    const unsubscribeClose = ctx.bus.on(SessionSubjects.close, (requestCtx) => {
      closedSessions.push(requestCtx.payload);
      requestCtx.setResult({ success: true });
    });

    try {
      const outcome = await executeDelegateRoleNode(
        node,
        ctx,
        {
          ...emptyExpressionCtx,
          inputs: { title: 'workflow runtime' },
        },
        'frame-review-delegate-unavailable',
      );

      expect(outcome).toEqual({
        status: 'failed',
        error: "Session runtime cannot attach delegate-role node 'review-delegate-unavailable'",
      });
      expect(closedSessions).toEqual([
        {
          sessionId: expect.stringContaining('review-delegate-unavailable'),
        },
      ]);
    } finally {
      unsubscribeRole();
      unsubscribeCreate();
      unsubscribeClose();
    }
  });

  it('preserves subagent semantics for delegate-role nodes with default tool completion', async () => {
    const node: WorkflowDelegateRoleNode = {
      id: 'review-delegate-tool',
      type: 'delegate-role',
      role: 'reviewer',
      prompt: 'Review {{ ctx.inputs.title }}',
      outputSchema: { type: 'object' },
      timeoutMs: 1_000,
    };
    const ctx = makeCtx({});
    const spawned: unknown[] = [];
    const sentMessages: unknown[] = [];

    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      expect(requestCtx.payload.roleId).toBe('reviewer');
      requestCtx.setResult({
        adapterName: 'claude-code',
        model: 'sonnet',
        reasoningEffort: 'high',
        harnessId: 'review-harness',
        systemPrompt: 'Review carefully.',
        contextMode: 'fresh',
        providerContext: {
          providerConfigId: 'provider-config-review',
          definitionId: 'provider-definition-review',
          credentialRefs: {},
        },
      });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      spawned.push(requestCtx.payload);
      requestCtx.setResult({ subagentId: 'subagent-review-delegate-tool', status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      expect(requestCtx.payload).toEqual({ subagentId: 'subagent-review-delegate-tool', timeoutMs: 1_000 });
      requestCtx.setResult({ status: 'completed', result: '{"approved":true}' });
    });
    const unsubscribeSendMessage = ctx.bus.on(SessionSubjects.sendMessage, (requestCtx) => {
      sentMessages.push(requestCtx.payload);
      requestCtx.setResult({ sessionId: 'unexpected', messageId: 'unexpected', turnId: 'unexpected' });
    });

    try {
      const outcome = await executeDelegateRoleNode(
        node,
        ctx,
        {
          ...emptyExpressionCtx,
          inputs: { title: 'workflow runtime' },
        },
        'frame-review-delegate-tool',
      );

      expect(outcome).toEqual({ status: 'completed', output: '{"approved":true}' });
      expect(sentMessages).toEqual([]);
      expect(spawned).toEqual([
        expect.objectContaining({
          parentSessionId: 'exec-test',
          depth: 1,
          config: expect.objectContaining({
            task: 'Review workflow runtime',
            adapterName: 'claude-code',
            model: 'sonnet',
            reasoningEffort: 'high',
            harnessId: 'review-harness',
            systemPrompt: 'Review carefully.',
            contextMode: 'fresh',
            providerContext: {
              providerConfigId: 'provider-config-review',
              definitionId: 'provider-definition-review',
              credentialRefs: {},
            },
            responseSchema: { schema: { type: 'object' } },
          }),
        }),
      ]);
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
      unsubscribeSendMessage();
    }
  });

  it('fails delegate-role nodes when the role cannot resolve', async () => {
    const node: WorkflowDelegateRoleNode = {
      id: 'missing-reviewer',
      type: 'delegate-role',
      role: 'unknown-reviewer',
      prompt: 'Review',
    };
    const ctx = makeCtx({});

    const outcome = await executeDelegateRoleNode(node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain("Role 'unknown-reviewer' could not be resolved");
    }
  });

  it('runs delegate-agent nodes through the explicit agent resolver seam', async () => {
    const node: WorkflowDelegateAgentNode = {
      id: 'implement',
      type: 'delegate-agent',
      agentId: 'claude-code-implementer',
      inputExpression: '{ task: ctx.inputs.task, branch: ctx.inputs.branch }',
      outputSchema: { type: 'object' },
    };
    const ctx = makeCtx({});
    const spawned: unknown[] = [];
    const unsubscribeAgent = ctx.bus.on(WorkflowSubjects.resolveAgent, (requestCtx) => {
      expect(requestCtx.payload.agentId).toBe('claude-code-implementer');
      requestCtx.setResult({ adapterName: 'claude-code', harnessId: 'implementation-harness' });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      spawned.push(requestCtx.payload);
      requestCtx.setResult({ subagentId: 'subagent-implement', status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      expect(requestCtx.payload).toEqual({ subagentId: 'subagent-implement' });
      requestCtx.setResult({ status: 'completed', result: 'implemented' });
    });

    try {
      const outcome = await executeDelegateAgentNode(node, ctx, {
        ...emptyExpressionCtx,
        inputs: { task: 'Add tests', branch: 'workflow-api' },
      });

      expect(outcome).toEqual({ status: 'completed', output: 'implemented' });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toMatchObject({
        parentSessionId: 'exec-test',
        depth: 1,
        config: {
          task: JSON.stringify({ task: 'Add tests', branch: 'workflow-api' }, null, 2),
          adapterName: 'claude-code',
          harnessId: 'implementation-harness',
          responseSchema: { schema: { type: 'object' } },
        },
      });
    } finally {
      unsubscribeAgent();
      unsubscribeSpawn();
      unsubscribeAwait();
    }
  });

  it('fails delegate-agent nodes when the explicit agent cannot resolve', async () => {
    const node: WorkflowDelegateAgentNode = {
      id: 'missing-agent',
      type: 'delegate-agent',
      agentId: 'unknown-agent',
    };
    const ctx = makeCtx({});

    const outcome = await executeDelegateAgentNode(node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain("Agent 'unknown-agent' could not be resolved");
    }
  });
});

describe('executeSequence frame persistence', () => {
  it('persists frame lifecycle transitions through setFrame and mirrors span read-model rows', async () => {
    const persistedFrames: Array<{ nodeId: string; output?: unknown; status: WorkflowFrameState['status'] }> = [];
    const persistedSpans: Array<Pick<SpanRecord, 'frameId' | 'stepId' | 'stepType' | 'status' | 'output'>> = [];
    const handler: StationHandler = () => ({ ok: true });
    const ctx = makeCtx({ persist: handler });
    const unsubscribeFrame = ctx.bus.on(WorkflowStorageSubjects.setFrame, (requestCtx) => {
      persistedFrames.push({
        nodeId: requestCtx.payload.frame.nodeId,
        output: requestCtx.payload.frame.output,
        status: requestCtx.payload.frame.status,
      });
      requestCtx.setResult({ frameId: requestCtx.payload.frame.frameId });
    });
    const unsubscribeSpan = ctx.bus.on(WorkflowStorageSubjects.setSpan, (requestCtx) => {
      persistedSpans.push({
        frameId: requestCtx.payload.span.frameId,
        stepId: requestCtx.payload.span.stepId,
        stepType: requestCtx.payload.span.stepType,
        status: requestCtx.payload.span.status,
        output: requestCtx.payload.span.output,
      });
      requestCtx.setResult({ id: `${requestCtx.payload.span.executionId}:${requestCtx.payload.span.frameId}` });
    });

    try {
      const outcome = await executeSequence(
        {
          id: 'root',
          type: 'sequence',
          nodes: [{ id: 'persist', type: 'station', prompt: 'Persist transitions' } as WorkflowStationNode],
        },
        ctx,
        emptyExpressionCtx,
      );

      expect(outcome.status).toBe('completed');
      expect(persistedFrames.map((frame) => frame.status)).toEqual(['pending', 'running', 'completed']);
      expect(persistedFrames.at(-1)).toMatchObject({
        nodeId: 'persist',
        output: { ok: true },
      });
      expect(persistedSpans).toEqual([
        expect.objectContaining({
          stepId: 'persist',
          frameId: expect.any(String),
          stepType: 'station',
          status: 'running',
          output: undefined,
        }),
        expect.objectContaining({
          stepId: 'persist',
          frameId: expect.any(String),
          stepType: 'station',
          status: 'completed',
          output: '{"ok":true}',
        }),
      ]);
    } finally {
      unsubscribeFrame();
      unsubscribeSpan();
    }
  });

  it('mirrors repeated frames for the same node as distinct spans keyed by frame ID', async () => {
    const ctx = makeCtx({});
    const persistedSpans: Array<Pick<SpanRecord, 'frameId' | 'stepId' | 'status'>> = [];
    const unsubscribeSpan = ctx.bus.on(WorkflowStorageSubjects.setSpan, (requestCtx) => {
      persistedSpans.push({
        frameId: requestCtx.payload.span.frameId,
        stepId: requestCtx.payload.span.stepId,
        status: requestCtx.payload.span.status,
      });
      requestCtx.setResult({ id: `${requestCtx.payload.span.executionId}:${requestCtx.payload.span.frameId}` });
    });

    try {
      const firstFrame = ctx.createFrame({ nodeId: 'review', nodeType: 'station', path: [] });
      await ctx.updateFrame(firstFrame.frameId, { status: 'running', startedAt: 10 });
      await ctx.updateFrame(firstFrame.frameId, { status: 'completed', completedAt: 20 });

      const secondFrame = ctx.createFrame({ nodeId: 'review', nodeType: 'station', path: [] });
      await ctx.updateFrame(secondFrame.frameId, { status: 'running', startedAt: 30 });
      await ctx.updateFrame(secondFrame.frameId, { status: 'completed', completedAt: 40 });

      expect(persistedSpans.filter((span) => span.status === 'completed')).toEqual([
        { frameId: firstFrame.frameId, stepId: 'review', status: 'completed' },
        { frameId: secondFrame.frameId, stepId: 'review', status: 'completed' },
      ]);
    } finally {
      unsubscribeSpan();
    }
  });
});

describe('executeSequence expression output aliases', () => {
  it('evaluates when and skip expressions against the documented ctx alias', async () => {
    const ran: string[] = [];
    const handlers: Record<string, StationHandler> = {
      allowed: () => {
        ran.push('allowed');
        return { allowed: true };
      },
      skipped: () => {
        ran.push('skipped');
        return { skipped: false };
      },
    };
    const root: WorkflowSequenceNode = {
      id: 'ctx-condition-root',
      type: 'sequence',
      nodes: [
        {
          id: 'allowed',
          type: 'station',
          prompt: 'Allowed',
          when: "ctx.inputs.run == 'yes'",
        } as WorkflowStationNode,
        {
          id: 'skipped',
          type: 'station',
          prompt: 'Skipped',
          skip: 'ctx.inputs.skipSkipped == true',
        } as WorkflowStationNode,
      ],
    };

    const outcome = await executeSequence(root, makeCtx(handlers), {
      ...emptyExpressionCtx,
      inputs: { run: 'yes', skipSkipped: true },
    });

    expect(outcome.status).toBe('completed');
    expect(ran).toEqual(['allowed']);
  });

  it('evaluates when expressions against previousSteps keyed by earlier node ID', async () => {
    let fixRan = false;
    const handlers: Record<string, StationHandler> = {
      triage: () => ({ action: 'approve' }),
      fix: () => {
        fixRan = true;
        return { fixed: true };
      },
    };
    const root: WorkflowSequenceNode = {
      id: 'previous-steps-root',
      type: 'sequence',
      nodes: [
        { id: 'triage', type: 'station', prompt: 'Triage' } as WorkflowStationNode,
        {
          id: 'fix',
          type: 'station',
          prompt: 'Fix',
          when: "previousSteps['triage'].output.action == 'approve'",
        } as WorkflowStationNode,
      ],
    };

    const outcome = await executeSequence(root, makeCtx(handlers), emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(fixRan).toBe(true);
  });

  it('evaluates iterate collections against the latest completed output alias', async () => {
    const applied: unknown[] = [];
    const handlers: Record<string, StationHandler> = {
      aggregate: () => ({ findings: ['a', 'b'] }),
      'apply-item': (ctx) => {
        applied.push(ctx.item);
        return { id: ctx.item, applied: true };
      },
    };
    const iterateNode: WorkflowIterateNode = {
      id: 'apply-findings',
      type: 'iterate',
      collection: 'output.findings',
      body: {
        id: 'apply-findings__body',
        type: 'sequence',
        nodes: [{ id: 'apply-item', type: 'station', prompt: 'Apply item' } as WorkflowStationNode],
      },
    };
    const root: WorkflowSequenceNode = {
      id: 'output-root',
      type: 'sequence',
      nodes: [{ id: 'aggregate', type: 'station', prompt: 'Aggregate' } as WorkflowStationNode, iterateNode],
    };

    const outcome = await executeSequence(root, makeCtx(handlers), emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(applied).toEqual(['a', 'b']);
  });
});

// ─────────────────────────────────────────────────────────────
// Parallel node tests
// ─────────────────────────────────────────────────────────────

describe('executeParallelNode (all-settled mode)', () => {
  /**
   * Build a parallel node with the given branch IDs, each containing a
   * single station node whose handler is provided.
   * @param nodeId - Parallel node ID.
   * @param branches - Map of branch key to handler.
   */
  function makeParallelNode(
    nodeId: string,
    branches: Record<string, StationHandler>,
  ): { node: WorkflowParallelNode; handlers: Record<string, StationHandler> } {
    const branchMap: WorkflowParallelNode['branches'] = {};
    const handlers: Record<string, StationHandler> = {};

    for (const [branchKey, handler] of Object.entries(branches)) {
      const stationId = `${nodeId}__${branchKey}__station`;
      handlers[stationId] = handler;
      branchMap[branchKey] = {
        id: `${nodeId}__${branchKey}__seq`,
        type: 'sequence',
        nodes: [
          {
            id: stationId,
            type: 'station' as const,
            prompt: stationId,
          } as WorkflowStationNode,
        ],
      };
    }

    const node: WorkflowParallelNode = {
      id: nodeId,
      type: 'parallel',
      branches: branchMap,
    };

    return { node, handlers };
  }

  it('runs all branches concurrently and collects all results', async () => {
    const { node, handlers } = makeParallelNode('parallel-1', {
      spec: async () => 'spec-result',
      quality: async () => 'quality-result',
    });

    const ctx = makeCtx(handlers);
    const parallelFrame = ctx.createFrame({
      nodeId: 'parallel-1',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      node,
      ctx,
      emptyExpressionCtx,
      executeSequence,
      parallelFrame.frameId,
      parallelFrame.path,
      'all-settled',
    );

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as ParallelOutput;
      expect(output.mode).toBe('all-settled');
      expect(output.branches.spec).toMatchObject({ status: 'fulfilled', value: 'spec-result' });
      expect(output.branches.quality).toMatchObject({ status: 'fulfilled', value: 'quality-result' });
    }
  });

  it('uses the final branch station by sequence order when start timestamps tie', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(3_000);
    try {
      const node: WorkflowParallelNode = {
        id: 'parallel-order',
        type: 'parallel',
        branches: {
          alpha: {
            id: 'parallel-order__alpha',
            type: 'sequence',
            nodes: [
              { id: 'parallel-order__alpha__draft', type: 'station', prompt: 'Draft' } as WorkflowStationNode,
              { id: 'parallel-order__alpha__final', type: 'station', prompt: 'Final' } as WorkflowStationNode,
            ],
          },
        },
      };

      const ctx = makeCtx({
        'parallel-order__alpha__draft': () => 'draft-output',
        'parallel-order__alpha__final': () => 'final-output',
      });
      const parallelFrame = ctx.createFrame({
        nodeId: 'parallel-order',
        nodeType: 'parallel',
        path: [],
      });

      const outcome = await executeParallelNode(
        node,
        ctx,
        emptyExpressionCtx,
        executeSequence,
        parallelFrame.frameId,
        parallelFrame.path,
        'all-settled',
      );

      expect(outcome.status).toBe('completed');
      if (outcome.status === 'completed') {
        const output = outcome.output as ParallelOutput;
        expect(output.branches.alpha).toMatchObject({ status: 'fulfilled', value: 'final-output' });
      }
    } finally {
      dateNow.mockRestore();
    }
  });

  it('captures branch failures without failing the parallel node in all-settled mode', async () => {
    const { node, handlers } = makeParallelNode('parallel-mixed', {
      passing: async () => 'ok',
      failing: () => {
        throw new Error('Branch error');
      },
    });

    const ctx = makeCtx(handlers);
    const parallelFrame = ctx.createFrame({
      nodeId: 'parallel-mixed',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      node,
      ctx,
      emptyExpressionCtx,
      executeSequence,
      parallelFrame.frameId,
      parallelFrame.path,
      'all-settled',
    );

    // all-settled: parallel completes even when a branch fails.
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as ParallelOutput;
      expect(output.branches.passing).toMatchObject({ status: 'fulfilled', value: 'ok' });
      expect(output.branches.failing).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('Branch error'),
      });
    }
  });

  it('creates per-branch frames so each branch is independently observable', async () => {
    const persistedFrames: Array<{
      branchKey?: string;
      frameId: string;
      nodeId: string;
      output?: unknown;
      parentFrameId?: string;
      path: string[];
      status: WorkflowFrameState['status'];
    }> = [];
    const { node, handlers } = makeParallelNode('framed-parallel', {
      alpha: async () => 'a',
      beta: async () => 'b',
    });

    const ctx = makeCtx(handlers);
    const unsubscribe = ctx.bus.on(WorkflowStorageSubjects.setFrame, (requestCtx) => {
      const { frame } = requestCtx.payload;
      persistedFrames.push({
        branchKey: frame.branchKey,
        frameId: frame.frameId,
        nodeId: frame.nodeId,
        output: frame.output,
        parentFrameId: frame.parentFrameId,
        path: [...frame.path],
        status: frame.status,
      });
      requestCtx.setResult({ frameId: frame.frameId });
    });
    const parallelFrame = ctx.createFrame({
      nodeId: 'framed-parallel',
      nodeType: 'parallel',
      path: [],
    });

    try {
      const outcome = await executeParallelNode(
        node,
        ctx,
        emptyExpressionCtx,
        executeSequence,
        parallelFrame.frameId,
        parallelFrame.path,
        'all-settled',
      );

      expect(outcome.status).toBe('completed');

      const branchFrames = ctx
        .getFramesByNodeId('framed-parallel')
        .filter((frame) => frame.parentFrameId === parallelFrame.frameId);
      expect(branchFrames).toHaveLength(2);
      expect(
        branchFrames.map((frame) => ({
          branchKey: frame.branchKey,
          nodeId: frame.nodeId,
          parentFrameId: frame.parentFrameId,
          path: frame.path,
          status: frame.status,
        })),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            branchKey: 'alpha',
            nodeId: 'framed-parallel',
            parentFrameId: parallelFrame.frameId,
            path: [parallelFrame.frameId, expect.any(String)],
            status: 'completed',
          }),
          expect.objectContaining({
            branchKey: 'beta',
            nodeId: 'framed-parallel',
            parentFrameId: parallelFrame.frameId,
            path: [parallelFrame.frameId, expect.any(String)],
            status: 'completed',
          }),
        ]),
      );

      for (const frame of branchFrames) {
        const persistedBranchFrames = persistedFrames.filter((persisted) => persisted.frameId === frame.frameId);
        expect(persistedBranchFrames.map((persisted) => persisted.status)).toEqual(['pending', 'running', 'completed']);
        expect(persistedBranchFrames.at(-1)).toMatchObject({
          branchKey: frame.branchKey,
          nodeId: 'framed-parallel',
          output: frame.branchKey === 'alpha' ? 'a' : 'b',
          parentFrameId: parallelFrame.frameId,
          path: frame.path,
        });
      }
    } finally {
      unsubscribe();
    }
  });

  it('returns completed with empty branches for a parallel node with no branches', async () => {
    const node: WorkflowParallelNode = {
      id: 'empty-parallel',
      type: 'parallel',
      branches: {},
    };

    const ctx = makeCtx({});
    const parallelFrame = ctx.createFrame({
      nodeId: 'empty-parallel',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      node,
      ctx,
      emptyExpressionCtx,
      executeSequence,
      parallelFrame.frameId,
      parallelFrame.path,
    );

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as ParallelOutput;
      expect(output.branches).toEqual({});
    }
  });

  it('cancels immediately when outer signal is already aborted', async () => {
    const { node, handlers } = makeParallelNode('aborted-parallel', {
      slow: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return 'should not complete';
      },
    });

    const abortCtrl = new AbortController();
    abortCtrl.abort();

    const ctx = makeCtx(handlers, abortCtrl.signal);
    const parallelFrame = ctx.createFrame({
      nodeId: 'aborted-parallel',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      node,
      ctx,
      emptyExpressionCtx,
      executeSequence,
      parallelFrame.frameId,
      parallelFrame.path,
    );

    expect(outcome.status).toBe('cancelled');
  });
});

describe('executeParallelNode (fail-fast mode)', () => {
  it('fails the parallel node when a branch fails', async () => {
    const stationId = 'fail-fast__failing__station';
    const passingId = 'fail-fast__passing__station';
    let passingStarted = false;
    let passingCompleted = false;

    const handlers: Record<string, StationHandler> = {
      [stationId]: () => {
        throw new Error('Branch failed!');
      },
      [passingId]: async () => {
        passingStarted = true;
        // Simulate work that takes a little time.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        passingCompleted = true;
        return 'passed';
      },
    };

    const node: WorkflowParallelNode = {
      id: 'fail-fast',
      type: 'parallel',
      branches: {
        failing: {
          id: 'fail-fast__failing__seq',
          type: 'sequence',
          nodes: [{ id: stationId, type: 'station' as const, prompt: stationId } as WorkflowStationNode],
        },
        passing: {
          id: 'fail-fast__passing__seq',
          type: 'sequence',
          nodes: [{ id: passingId, type: 'station' as const, prompt: passingId } as WorkflowStationNode],
        },
      },
    };

    const ctx = makeCtx(handlers);
    const parallelFrame = ctx.createFrame({
      nodeId: 'fail-fast',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      node,
      ctx,
      emptyExpressionCtx,
      executeSequence,
      parallelFrame.frameId,
      parallelFrame.path,
      'fail-fast',
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('Branch failed!');
    }

    // The passing branch may have started (concurrent launch), but the
    // fail-fast cancellation signal should eventually abort it.
    void passingStarted;
    void passingCompleted;
  });

  it('cancels sibling branches when one branch fails', async () => {
    const cancelTracker: string[] = [];

    const fastFailId = 'ff-sibling__fast-fail__station';
    const slowId = 'ff-sibling__slow__station';

    const handlers: Record<string, StationHandler> = {
      [fastFailId]: () => {
        cancelTracker.push('fail-started');
        throw new Error('fast fail');
      },
      [slowId]: async (ctx) => {
        cancelTracker.push('slow-started');
        // Poll the signal — in real code this would be an awaitable.
        await new Promise<void>((resolve, reject) => {
          if (ctx.signal.aborted) {
            cancelTracker.push('slow-cancelled-before-wait');
            resolve();
            return;
          }
          const id = setTimeout(() => {
            cancelTracker.push('slow-completed');
            resolve();
          }, 2_000);
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(id);
              cancelTracker.push('slow-aborted');
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
        return 'slow result';
      },
    };

    const node: WorkflowParallelNode = {
      id: 'ff-sibling',
      type: 'parallel',
      branches: {
        'fast-fail': {
          id: 'ff-sibling__fast-fail__seq',
          type: 'sequence',
          nodes: [{ id: fastFailId, type: 'station' as const, prompt: fastFailId } as WorkflowStationNode],
        },
        slow: {
          id: 'ff-sibling__slow__seq',
          type: 'sequence',
          nodes: [{ id: slowId, type: 'station' as const, prompt: slowId } as WorkflowStationNode],
        },
      },
    };

    const ctx = makeCtx(handlers);
    const parallelFrame = ctx.createFrame({
      nodeId: 'ff-sibling',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      node,
      ctx,
      emptyExpressionCtx,
      executeSequence,
      parallelFrame.frameId,
      parallelFrame.path,
      'fail-fast',
    );

    expect(outcome.status).toBe('failed');
    // The slow branch was either cancelled before it started, or was
    // aborted mid-execution — but it never completed normally.
    expect(cancelTracker).not.toContain('slow-completed');
    expect(cancelTracker).toContain('fail-started');
  });
});

describe('executeSequence with serialized parallel mode', () => {
  it('uses fail-fast mode from the workflow node schema during dispatcher execution', async () => {
    const failingId = 'serialized-fail-fast__fail';
    const skippedId = 'serialized-fail-fast__slow';
    const handlers: Record<string, StationHandler> = {
      [failingId]: () => {
        throw new Error('serialized branch failed');
      },
      [skippedId]: async (ctx) => {
        if (ctx.signal.aborted) return 'cancelled before work';
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'should not decide the parallel outcome';
      },
    };
    const parallel: WorkflowParallelNode = {
      id: 'serialized-fail-fast',
      type: 'parallel',
      mode: 'fail-fast',
      branches: {
        fail: {
          id: 'serialized-fail-fast__fail__seq',
          type: 'sequence',
          nodes: [{ id: failingId, type: 'station', prompt: failingId } as WorkflowStationNode],
        },
        slow: {
          id: 'serialized-fail-fast__slow__seq',
          type: 'sequence',
          nodes: [{ id: skippedId, type: 'station', prompt: skippedId } as WorkflowStationNode],
        },
      },
    };
    const root = { id: 'serialized-root', type: 'sequence' as const, nodes: [parallel] };
    const ctx = makeCtx(handlers);

    const outcome = await executeSequence(root, ctx, emptyExpressionCtx);

    expect(outcome).toEqual({ status: 'failed', error: 'serialized branch failed' });
  });
});

// ─────────────────────────────────────────────────────────────
// Station handler state context tests
// ─────────────────────────────────────────────────────────────

describe('station handler state context', () => {
  it('provides ctx.state when workflow declares a state contract', async () => {
    const bus = makeBus();
    let currentState = { tier: 'T1', selectedReviewers: [] as string[] };
    let sequence = 0;
    let receivedPatch: unknown;

    // Register mock state handlers on the bus (public RPC subjects).
    const cleanupGet = bus.on(WorkflowSubjects.state.get, (requestCtx) => {
      requestCtx.setResult({
        executionId: 'exec-state-test',
        sequence,
        value: structuredClone(currentState),
      });
    });

    const cleanupPatch = bus.on(WorkflowSubjects.state.patch, (requestCtx) => {
      receivedPatch = requestCtx.payload.patch;
      sequence++;
      currentState = requestCtx.payload.nextValue as typeof currentState;
      requestCtx.setResult({
        executionId: 'exec-state-test',
        sequence,
        value: structuredClone(currentState),
      });
    });

    // Create a definition with a state contract.
    const definition = makeDefinition('workflow-state-test');
    definition.state = {
      schema: {
        type: 'object',
        properties: {
          tier: { type: 'string' },
          selectedReviewers: { type: 'array', items: { type: 'string' } },
        },
      },
      initial: { tier: 'T1', selectedReviewers: [] },
    };

    let capturedState: unknown;
    let capturedAfterUpdate: unknown;

    const handlers: Record<string, StationHandler> = {
      'test-state-station': async (ctx) => {
        // Verify state context exists
        expect(ctx.state).toBeDefined();

        // Read state
        capturedState = await ctx.state!.get();

        // Update state
        capturedAfterUpdate = await ctx.state!.update((draft: unknown) => {
          const d = draft as { tier: string; selectedReviewers: string[] };
          d.tier = 'T2';
          d.selectedReviewers.push('spec-compliance-reviewer');
        });

        return { ok: true };
      },
    };

    const runtimeCtx = new RuntimeContext(
      'exec-state-test',
      'workflow-state-test',
      definition,
      makeExecution('workflow-state-test'),
      new Map(Object.entries(handlers)),
      bus,
      new AbortController().signal,
    );

    const node: WorkflowStationNode = {
      id: 'test-state-station',
      type: 'station',
      prompt: 'Test state',
    };

    try {
      const outcome = await executeStationNode(node, runtimeCtx, emptyExpressionCtx);

      expect(outcome.status).toBe('completed');
      expect(capturedState).toEqual({
        tier: 'T1',
        selectedReviewers: [],
      });
      expect(capturedAfterUpdate).toEqual({
        tier: 'T2',
        selectedReviewers: ['spec-compliance-reviewer'],
      });
      expect(receivedPatch).toEqual([
        { op: 'add', path: '/selectedReviewers/0', value: 'spec-compliance-reviewer' },
        { op: 'replace', path: '/tier', value: 'T2' },
      ]);
    } finally {
      cleanupGet();
      cleanupPatch();
    }
  });

  it('does not provide ctx.state when workflow has no state contract', async () => {
    let capturedState: unknown = 'sentinel';

    const handlers: Record<string, StationHandler> = {
      'no-state-station': async (ctx) => {
        capturedState = ctx.state;
        return { ok: true };
      },
    };

    const runtimeCtx = makeCtx(handlers);
    const node: WorkflowStationNode = {
      id: 'no-state-station',
      type: 'station',
      prompt: 'No state',
    };

    await executeStationNode(node, runtimeCtx, emptyExpressionCtx);
    expect(capturedState).toBeUndefined();
  });

  it('supports multiple sequential state updates with sequence tracking', async () => {
    const bus = makeBus();
    let currentState: Record<string, unknown> = { count: 0 };
    let sequence = 0;

    const cleanupGet = bus.on(WorkflowSubjects.state.get, (requestCtx) => {
      requestCtx.setResult({
        executionId: 'exec-seq-test',
        sequence,
        value: structuredClone(currentState),
      });
    });

    const cleanupPatch = bus.on(WorkflowSubjects.state.patch, (requestCtx) => {
      // Verify expectedSequence is passed for concurrency control
      expect(requestCtx.payload.expectedSequence).toBe(sequence);
      sequence++;
      currentState = requestCtx.payload.nextValue as Record<string, unknown>;
      requestCtx.setResult({
        executionId: 'exec-seq-test',
        sequence,
        value: structuredClone(currentState),
      });
    });

    const definition = makeDefinition('workflow-seq-test');
    definition.state = {
      schema: { type: 'object' },
      initial: { count: 0 },
    };

    let finalState: unknown;

    const handlers: Record<string, StationHandler> = {
      'seq-station': async (ctx) => {
        await ctx.state!.update((draft: unknown) => {
          (draft as Record<string, number>)['count'] = 1;
        });
        finalState = await ctx.state!.update((draft: unknown) => {
          (draft as Record<string, number>)['count'] = 2;
        });
        return { ok: true };
      },
    };

    const runtimeCtx = new RuntimeContext(
      'exec-seq-test',
      'workflow-seq-test',
      definition,
      makeExecution('workflow-seq-test'),
      new Map(Object.entries(handlers)),
      bus,
      new AbortController().signal,
    );

    const node: WorkflowStationNode = {
      id: 'seq-station',
      type: 'station',
      prompt: 'Sequential updates',
    };

    try {
      const outcome = await executeStationNode(node, runtimeCtx, emptyExpressionCtx);

      expect(outcome.status).toBe('completed');
      expect(finalState).toEqual({ count: 2 });
      expect(sequence).toBe(2);
    } finally {
      cleanupGet();
      cleanupPatch();
    }
  });

  it('sends meaningful JSON Patch operations and awaits async state mutators', async () => {
    const bus = makeBus();
    const initialState = {
      flag: true,
      list: ['first', 'second'],
      'nested/key~tag': 'before',
      removeList: ['keep', 'drop'],
      tier: 'T1',
    };
    let currentState = structuredClone(initialState);
    let sequence = 0;
    const receivedPatches: unknown[] = [];

    const cleanupGet = bus.on(WorkflowSubjects.state.get, (requestCtx) => {
      requestCtx.setResult({
        executionId: 'exec-patch-test',
        sequence,
        value: structuredClone(currentState),
      });
    });

    const cleanupPatch = bus.on(WorkflowSubjects.state.patch, (requestCtx) => {
      expect(currentState).toEqual(initialState);
      receivedPatches.push(requestCtx.payload.patch);
      sequence++;
      currentState = requestCtx.payload.nextValue as typeof currentState;
      requestCtx.setResult({
        executionId: 'exec-patch-test',
        sequence,
        value: structuredClone(currentState),
      });
    });

    const state = createWorkflowStateContext('exec-patch-test', bus);

    try {
      const updated = await state.update(async (draft) => {
        await Promise.resolve();
        const mutable = draft as {
          count?: number;
          flag?: boolean;
          list: string[];
          'nested/key~tag': string;
          removeList: string[];
          tier: string;
        };
        mutable.count = 1;
        delete mutable.flag;
        mutable.list[0] = 'updated-first';
        mutable.list.push('third');
        mutable['nested/key~tag'] = 'after';
        mutable.removeList.pop();
        mutable.tier = 'T2';
      });

      expect(updated).toEqual({
        count: 1,
        list: ['updated-first', 'second', 'third'],
        'nested/key~tag': 'after',
        removeList: ['keep'],
        tier: 'T2',
      });
      expect(receivedPatches).toEqual([
        [
          { op: 'add', path: '/count', value: 1 },
          { op: 'remove', path: '/flag' },
          { op: 'replace', path: '/list/0', value: 'updated-first' },
          { op: 'add', path: '/list/2', value: 'third' },
          { op: 'replace', path: '/nested~1key~0tag', value: 'after' },
          { op: 'remove', path: '/removeList/1' },
          { op: 'replace', path: '/tier', value: 'T2' },
        ],
      ]);
    } finally {
      cleanupGet();
      cleanupPatch();
    }
  });

  it('supports replacing primitive workflow state values from state mutators', async () => {
    const bus = makeBus();
    let currentState: JsonValue = 0;
    let sequence = 0;
    const receivedPatches: unknown[] = [];

    const cleanupGet = bus.on(WorkflowSubjects.state.get, (requestCtx) => {
      requestCtx.setResult({
        executionId: 'exec-primitive-state-test',
        sequence,
        value: currentState,
      });
    });

    const cleanupPatch = bus.on(WorkflowSubjects.state.patch, (requestCtx) => {
      receivedPatches.push(requestCtx.payload.patch);
      sequence++;
      currentState = requestCtx.payload.nextValue as JsonValue;
      requestCtx.setResult({
        executionId: 'exec-primitive-state-test',
        sequence,
        value: currentState,
      });
    });

    const state = createWorkflowStateContext('exec-primitive-state-test', bus);

    try {
      const updated = await state.update(() => 1);

      expect(updated).toBe(1);
      expect(currentState).toBe(1);
      expect(receivedPatches).toEqual([[{ op: 'replace', path: '', value: 1 }]]);
    } finally {
      cleanupGet();
      cleanupPatch();
    }
  });

  it('forwards sequence conflicts from the state patch RPC', async () => {
    const bus = makeBus();
    const cleanupGet = bus.on(WorkflowSubjects.state.get, (requestCtx) => {
      requestCtx.setResult({
        executionId: 'exec-conflict-test',
        sequence: 0,
        value: { count: 0 },
      });
    });
    const cleanupPatch = bus.on(WorkflowSubjects.state.patch, () => {
      throw new Error('state sequence conflict: expected 0, got 1');
    });
    const state = createWorkflowStateContext('exec-conflict-test', bus);

    try {
      await expect(
        state.update((draft) => {
          (draft as { count: number }).count = 1;
        }),
      ).rejects.toThrow('state sequence conflict: expected 0, got 1');
    } finally {
      cleanupGet();
      cleanupPatch();
    }
  });
});
