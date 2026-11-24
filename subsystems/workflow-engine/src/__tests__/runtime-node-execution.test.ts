import * as fsPromises from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance, ValidationError } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import {
  AgentSubjects,
  createWorkflowDelegateResultFinalizerNamespace,
  SessionSubjects,
  SubagentSubjects,
  WorkflowNamespace,
  WorkflowSchemas,
  WorkflowSubjects,
  type CodeStepHandler,
  type JsonValue,
  type ProviderContext,
  type SpanRecord,
  type WorkflowAgentStepNode,
  type WorkflowCodeStepNode,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowFrameState,
  type WorkflowIterateNode,
  type WorkflowParallelNode,
  type WorkflowSequenceNode,
} from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { RuntimeContext } from '../runtime/runtime-context.js';
import { executeCodeStepNode } from '../runtime/code-step-node.js';
import { executeAgentStepNode } from '../runtime/delegate-node.js';
import { elapsedDelegateDuration } from '../runtime/role-subagent-node.js';
import { executeParallelNode, type ParallelOutput } from '../runtime/parallel-node.js';
import { executeSequence } from '../runtime/primitive-runtime.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { runWorkflowOrchestrator } from '../workflow-orchestrator.js';
import { registerInMemoryFrameStore } from './shared.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

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
 * Create a fresh isolated bus with the workflow and storage namespaces registered.
 *
 * Each test gets its own bus instance so handler registrations do not bleed
 * across tests (no shared global state from the test-global MakaioBus).
 */
function makeBus(): ReturnType<typeof createBusInstance> {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  return bus;
}

/** Create a host bus with the in-memory frame handlers installed. */
function makeBusWithFrames(): ReturnType<typeof makeBus> {
  const bus = makeBus();
  registerInMemoryFrameStore(bus);
  return bus;
}

/**
 * Create a fresh RuntimeContext with in-memory frame storage by default.
 * @param handlers - Code step handlers keyed by node ID.
 * @param signal - Optional abort signal.
 * @param bus - Optional bus for tests that manage storage handlers directly.
 */
function makeCtx(
  handlers: Record<string, CodeStepHandler>,
  signal: AbortSignal = new AbortController().signal,
  bus?: ReturnType<typeof makeBus>,
): RuntimeContext {
  const runtimeBus = bus ?? makeBusWithFrames();
  return new RuntimeContext(
    'exec-test',
    'workflow-test',
    makeDefinition('workflow-test'),
    makeExecution('workflow-test'),
    new Map(Object.entries(handlers)),
    runtimeBus,
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

const StepRequestTestNamespace = createBusNamespace('runtime-step-test', {
  progress: {
    request: WorkflowSchemas['execution.progress'],
    response: z.object({ accepted: z.boolean() }),
  },
  pending: { request: z.object({}), response: z.object({ completed: z.boolean() }) },
});

const SESSION_LINK_TEST_CLEANUP_TIMEOUT_MS = 60_000;

const REVIEW_PROVIDER_CONTEXT = {
  state: 'resolved',
  providerConfigId: 'provider-config-review',
  definitionId: 'provider-definition-review',
  auth: {
    mode: 'none',
    method: {
      owner: 'provider',
      providerDefinitionId: 'provider-definition-review',
      methodId: 'none',
    },
    definition: { id: 'none', mode: 'none', label: 'No authentication' },
  },
  capabilities: {
    structuredOutput: {
      responseFormatWithTools: true,
    },
  },
} satisfies ProviderContext;

const REVIEW_PROVIDER_CONTEXT_WITHOUT_CAPABILITIES = {
  state: 'resolved',
  providerConfigId: 'provider-config-review',
  definitionId: 'provider-definition-review',
  auth: REVIEW_PROVIDER_CONTEXT.auth,
} satisfies ProviderContext;

// ─────────────────────────────────────────────────────────────
// Code step and agent step node tests
// ─────────────────────────────────────────────────────────────

describe('code step and agent step execution', () => {
  it('calls the registered handler and returns its output', async () => {
    const node: WorkflowCodeStepNode = {
      id: 'greet',
      type: 'code-step',
    };

    const handler: CodeStepHandler = async (ctx) => {
      const inputs =
        ctx.inputs !== null && typeof ctx.inputs === 'object' && !Array.isArray(ctx.inputs)
          ? (ctx.inputs as Record<string, unknown>)
          : {};
      const name = (inputs['name'] as string | undefined) ?? 'world';
      return `Hello, ${name}!`;
    };

    const ctx = makeCtx({ greet: handler });
    const outcome = await executeCodeStepNode(createTestCall(), node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.output).toBe('Hello, world!');
    }
  });

  it('passes execution inputs and config to the handler', async () => {
    const node: WorkflowCodeStepNode = {
      id: 'echo-input',
      type: 'code-step',
    };

    const received: unknown[] = [];
    const handler: CodeStepHandler = (ctx) => {
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

    await executeCodeStepNode(createTestCall(), node, ctx, emptyExpressionCtx);

    expect(received[0]).toEqual({ inputs: { key: 'value' }, config: { mode: 'strict' } });
  });

  it('passes previousSteps from completed frames in the expression context', async () => {
    const node: WorkflowCodeStepNode = {
      id: 'consumer',
      type: 'code-step',
    };

    let receivedPreviousSteps: unknown;
    const handler: CodeStepHandler = (ctx) => {
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
    await executeCodeStepNode(createTestCall(), node, ctx, expressionCtx);

    expect(receivedPreviousSteps).toMatchObject({
      'prior-step': { status: 'completed', output: { result: 42 } },
      'skipped-step': { status: 'skipped' },
    });
    // Failed frames are excluded from previousSteps.
    expect((receivedPreviousSteps as Record<string, unknown>)['failed-step']).toBeUndefined();
  });

  it.each([
    'success',
    'invalid',
    'observer-failure',
    'observer-validation-failure',
  ] as const)('uses the declared progress request with a %s outcome', async (scenario) => {
    const node: WorkflowCodeStepNode = { id: 'progress-step', type: 'code-step' };
    const handler: CodeStepHandler = async (step) =>
      step.request({
        subject: 'runtime-step-test.progress',
        payload: {
          executionId: step.executionId,
          workflowId: step.workflowId,
          frameId: 'frame-progress',
          nodeId: node.id,
          progress: {
            message: scenario === 'invalid' ? '' : 'Review draft ready',
            kind: 'checkpoint',
            metadata: { percent: 50 },
          },
          emittedAt: Date.now(),
        },
      });
    const hostBus = makeBusWithFrames();
    const ctx = makeCtx({ [node.id]: handler }, undefined, hostBus);
    const { subjects } = hostBus.registerNamespace(StepRequestTestNamespace);
    const principal = { kind: 'makaio.user', id: 'progress-user' };
    const observed: unknown[] = [];
    const cleanupProgress = ctx.bus.on(WorkflowSubjects.execution.progress, (event) => {
      observed.push(event.payload);
      if (scenario === 'observer-failure') throw new Error('Synthetic observer failure');
      if (scenario === 'observer-validation-failure') {
        const parsed = z.string().safeParse(1);
        if (!parsed.success) throw new ValidationError('subscriber.validation', parsed.error);
      }
    });
    const cleanupRequest = ctx.bus.on(subjects.progress, async (request) => {
      expect(request.call.principal).toEqual(principal);
      await ctx.bus.emit(request.call, WorkflowSubjects.execution.progress, request.payload);
      request.setResult({ accepted: true });
    });

    try {
      const outcome = await executeCodeStepNode(createTestCall({ principal }), node, ctx, emptyExpressionCtx);
      const expected = {
        success: { ok: true, response: { accepted: true } },
        invalid: { ok: false, code: 'request-rejected' },
        'observer-failure': { ok: false, code: 'request-failed' },
        'observer-validation-failure': { ok: false },
      }[scenario];
      expect(outcome).toMatchObject({ status: 'completed', output: expected });
      expect(observed).toEqual(
        scenario === 'invalid'
          ? []
          : [
              {
                executionId: 'exec-test',
                workflowId: 'workflow-test',
                frameId: 'frame-progress',
                nodeId: 'progress-step',
                progress: { message: 'Review draft ready', kind: 'checkpoint', metadata: { percent: 50 } },
                emittedAt: expect.any(Number),
              },
            ],
      );
    } finally {
      cleanupRequest();
      cleanupProgress();
    }
  });

  it.each([
    { label: 'no extra fields', fields: {} },
    { label: 'a stored role', fields: { role: 'reviewer' } },
    { label: 'a stored prompt', fields: { prompt: 'Review the implementation' } },
    { label: 'a stored role and prompt', fields: { role: 'reviewer', prompt: 'Review the implementation' } },
  ])('fails visibly without a registered code handler with $label', async ({ fields }) => {
    const node: WorkflowCodeStepNode = {
      ...fields,
      id: 'no-handler',
      type: 'code-step',
    };
    const ctx = makeCtx({});
    const resolveRole = vi.fn();
    const spawn = vi.fn();
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, resolveRole);
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, spawn);

    try {
      await expect(executeCodeStepNode(createTestCall(), node, ctx, emptyExpressionCtx)).resolves.toEqual({
        status: 'failed',
        error: "No handler registered for code step 'no-handler'",
      });
      expect(resolveRole).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
    }
  });

  it.each([
    { label: 'object', value: { title: 'Implementation', approved: true } },
    { label: 'array', value: ['first', 'second'] },
  ])('renders an agent-step $label placeholder as JSON before spawning', async ({ value }) => {
    const node: WorkflowAgentStepNode = {
      id: 'structured-prompt',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review {{ input.details }}',
    };
    const ctx = makeCtx({});
    const spawned: unknown[] = [];
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      spawned.push(requestCtx.payload);
      requestCtx.setResult({ subagentId: 'subagent-structured-prompt', status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({ status: 'completed', result: 'review complete' });
    });

    try {
      await expect(
        executeAgentStepNode(createTestCall(), node, ctx, {
          ...emptyExpressionCtx,
          inputs: { details: value },
        }),
      ).resolves.toEqual({ status: 'completed', output: 'review complete' });
      expect(spawned).toEqual([
        expect.objectContaining({
          config: expect.objectContaining({ task: `Review ${JSON.stringify(value, null, 2)}` }),
        }),
      ]);
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
    }
  });

  it('fails an agent step on a prompt placeholder error before spawning a subagent', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'invalid-prompt',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review {{ input.title + }}',
    };
    const ctx = makeCtx({});
    const spawn = vi.fn();
    const awaitSubagent = vi.fn();
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, spawn);
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, awaitSubagent);

    try {
      const outcome = await executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx);
      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.error).toContain(
          "agent step 'invalid-prompt': Template placeholder {{ input.title + }} failed to evaluate:",
        );
      }
      expect(spawn).not.toHaveBeenCalled();
      expect(awaitSubagent).not.toHaveBeenCalled();
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
    }
  });

  it('runs agent steps through the subagent seam when no handler is registered', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'role-step',
      type: 'agent-step',
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
      requestCtx.setResult({ subagentId: 'subagent-role-step', status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      expect(requestCtx.payload).toEqual({ subagentId: 'subagent-role-step', timeoutMs: 1_000 });
      requestCtx.setResult({ status: 'completed', result: 'review complete' });
    });

    try {
      const outcome = await executeAgentStepNode(createTestCall(), node, ctx, {
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
      // agent steps fall back to the execution ID for subagent lineage.
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

  it('fails agent steps when the role cannot resolve', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'missing-role',
      type: 'agent-step',
      prompt: 'Resolve role',
      role: 'unknown-role',
    };
    const ctx = makeCtx({});

    const outcome = await executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain("Role 'unknown-role' could not be resolved");
    }
  });

  it('fails agent steps when subagent runtime is unavailable', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'missing-subagent',
      type: 'agent-step',
      prompt: 'Run role',
      role: 'reviewer',
    };
    const ctx = makeCtx({});
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });

    try {
      const outcome = await executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx);

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.error).toContain('Subagent runtime is not available');
      }
    } finally {
      unsubscribeRole();
    }
  });

  it('fails agent steps when the subagent runtime cannot await', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'missing-await',
      type: 'agent-step',
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
      const outcome = await executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx);

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.error).toContain("Subagent runtime cannot await agent step 'missing-await'");
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
      expected: { status: 'failed' as const, error: "Agent step 'subagent-failed' subagent failed: review failed" },
    },
    {
      awaitStatus: 'cancelled' as const,
      awaitError: undefined,
      expected: { status: 'cancelled' as const },
    },
  ])('maps agent step subagent $awaitStatus results to node outcomes', async (scenario) => {
    const node: WorkflowAgentStepNode = {
      id: `subagent-${scenario.awaitStatus}`,
      type: 'agent-step',
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
      await expect(executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx)).resolves.toEqual(
        scenario.expected,
      );
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
    }
  });

  it('cancels and kills agent step subagents when the workflow is aborted', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'abort-role-step',
      type: 'agent-step',
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
      requestCtx.setResult({ subagentId: 'subagent-abort-role-step', status: 'spawning' });
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
      const outcomePromise = executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx);
      await awaitEntered;
      controller.abort();

      await expect(outcomePromise).resolves.toEqual({ status: 'cancelled' });
      expect(killPayload).toEqual({
        subagentId: 'subagent-abort-role-step',
        reason: "Workflow execution 'exec-test' cancelled agent-step 'abort-role-step'",
      });
    } finally {
      releaseAwait();
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
      unsubscribeKill();
    }
  });

  it('returns cancelled when agent step child kill fails during abort cleanup', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'abort-kill-fails',
      type: 'agent-step',
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
      const outcomePromise = executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx);
      await awaitEntered;
      controller.abort();

      await expect(outcomePromise).resolves.toEqual({ status: 'cancelled' });
      expect(killPayload).toEqual({
        subagentId: 'subagent-abort-kill-fails',
        reason: "Workflow execution 'exec-test' cancelled agent-step 'abort-kill-fails'",
      });
      expect(warn).toHaveBeenCalledWith(
        "[workflow-engine] Best-effort subagent kill failed for 'subagent-abort-kill-fails' (agent-step 'abort-kill-fails')",
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

  it.each([
    { status: 'timeout' as const },
    {
      status: 'waiting_input' as const,
      pendingRequest: { messageId: 'request-1', question: 'Continue?' },
    },
  ])('kills an agent-step child after non-terminal await status $status', async (awaitResponse) => {
    const ctx = makeCtx({});
    const killPayloads: unknown[] = [];
    const cleanupRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'test-adapter' });
    });
    const cleanupSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-abandoned', status: 'spawning' });
    });
    const cleanupAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => requestCtx.setResult(awaitResponse));
    const cleanupKill = ctx.bus.on(SubagentSubjects.kill, (requestCtx) => {
      killPayloads.push(requestCtx.payload);
      requestCtx.setResult({ killed: true });
    });

    try {
      const outcome = await executeAgentStepNode(
        createTestCall(),
        {
          type: 'agent-step',
          id: 'abandoned-role-step',
          role: 'reviewer',
          prompt: 'Analyze',
        },
        ctx,
        emptyExpressionCtx,
      );

      expect(outcome).toMatchObject({ status: 'failed' });
      expect(killPayloads).toEqual([
        {
          subagentId: 'subagent-abandoned',
          reason: "Workflow execution 'exec-test' abandoned non-terminal agent-step 'abandoned-role-step'",
        },
      ]);
    } finally {
      cleanupKill();
      cleanupAwait();
      cleanupSpawn();
      cleanupRole();
    }
  });

  it('kills an agent-step child when the await request rejects', async () => {
    const ctx = makeCtx({});
    const killPayloads: unknown[] = [];
    const cleanupRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'test-adapter' });
    });
    const cleanupSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-await-failed', status: 'spawning' });
    });
    const cleanupAwait = ctx.bus.on(SubagentSubjects.await, () => {
      throw new Error('await transport failed');
    });
    const cleanupKill = ctx.bus.on(SubagentSubjects.kill, (requestCtx) => {
      killPayloads.push(requestCtx.payload);
      requestCtx.setResult({ killed: true });
    });

    try {
      await expect(
        executeAgentStepNode(
          createTestCall(),
          {
            type: 'agent-step',
            id: 'await-failed-role-step',
            role: 'reviewer',
            prompt: 'Analyze',
          },
          ctx,
          emptyExpressionCtx,
        ),
      ).rejects.toThrow('await transport failed');
      expect(killPayloads).toEqual([
        {
          subagentId: 'subagent-await-failed',
          reason: "Workflow execution 'exec-test' failed awaiting agent-step 'await-failed-role-step'",
        },
      ]);
    } finally {
      cleanupKill();
      cleanupAwait();
      cleanupSpawn();
      cleanupRole();
    }
  });

  it('emits frame.sessionLinked after an agent step obtains a child session', async () => {
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
      requestCtx.setResult({ subagentId: 'subagent-role-step', status: 'spawning' });
    });
    const cleanupStatus = ctx.bus.on(SubagentSubjects.getStatus, (requestCtx) => {
      expect(requestCtx.payload.subagentId).toBe('subagent-role-step');
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
      const outcome = await executeAgentStepNode(
        createTestCall(),
        {
          type: 'agent-step',
          id: 'analyze',
          role: 'reviewer',
          prompt: 'Analyze',
        },
        ctx,
        emptyExpressionCtx,
        'frame-analyze',
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
      const outcome = await executeAgentStepNode(
        createTestCall(),
        {
          type: 'agent-step',
          id: 'delayed-link',
          role: 'reviewer',
          prompt: 'Analyze',
        },
        ctx,
        emptyExpressionCtx,
        'frame-delayed-link',
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

    const outcomePromise = executeAgentStepNode(
      createTestCall(),
      {
        type: 'agent-step',
        id: 'timeout-link',
        role: 'reviewer',
        prompt: 'Analyze',
      },
      ctx,
      emptyExpressionCtx,
      'frame-timeout-link',
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
    const call = createTestCall();
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
        executeAgentStepNode(
          call,
          {
            type: 'agent-step',
            id: 'signal-link',
            role: 'reviewer',
            prompt: 'Analyze',
          },
          ctx,
          emptyExpressionCtx,
          'frame-signal-link',
        ),
      ).resolves.toEqual({ status: 'completed', output: 'done with signal' });

      expect(requestOptionalSpy).toHaveBeenCalledWith(
        call,
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
    const call = createTestCall();
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
        executeAgentStepNode(
          call,
          {
            type: 'agent-step',
            id: 'await-options',
            role: 'reviewer',
            prompt: 'Analyze',
            timeoutMs: 90_000,
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
        call,
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

    const outcomePromise = executeAgentStepNode(
      createTestCall(),
      {
        type: 'agent-step',
        id: 'abort-delay-link',
        role: 'reviewer',
        prompt: 'Analyze',
      },
      ctx,
      emptyExpressionCtx,
      'frame-abort-delay-link',
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

  it('refuses unregistered subjects and registered events as requests', async () => {
    const node: WorkflowCodeStepNode = { id: 'unknown-request', type: 'code-step' };
    const handler: CodeStepHandler = async (step) => ({
      unknown: await step.request({ subject: 'unregistered.request', payload: {} }),
      event: await step.request({ subject: 'workflow.execution.progress', payload: {} }),
    });
    const ctx = makeCtx({ [node.id]: handler });
    const outcome = await executeCodeStepNode(createTestCall(), node, ctx, emptyExpressionCtx);

    expect(outcome).toMatchObject({
      status: 'completed',
      output: {
        unknown: { ok: false, code: 'request-not-granted' },
        event: { ok: false, code: 'request-not-granted' },
      },
    });
  });

  it('propagates handler errors as failed outcomes', async () => {
    const node: WorkflowCodeStepNode = {
      id: 'broken',
      type: 'code-step',
    };

    const handler: CodeStepHandler = () => {
      throw new Error('Handler exploded');
    };

    const ctx = makeCtx({ broken: handler });
    const outcome = await executeCodeStepNode(createTestCall(), node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toBe('Handler exploded');
    }
  });

  it('returns cancelled when the signal is already aborted', async () => {
    const node: WorkflowCodeStepNode = {
      id: 'slow',
      type: 'code-step',
    };

    const handler: CodeStepHandler = () => 'should not run';
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    const ctx = makeCtx({ slow: handler }, abortCtrl.signal);
    const outcome = await executeCodeStepNode(createTestCall(), node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('cancelled');
  });

  it('cancels a running local handler and ignores its late result', async () => {
    const node: WorkflowCodeStepNode = { id: 'running', type: 'code-step' };
    const controller = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<JsonValue>();
    const handler: CodeStepHandler = async (step) => {
      await step.launchProcess({ program: process.execPath, args: [], cwd: '..', stdin: 'none' });
      started.resolve(step.signal);
      return release.promise;
    };
    const ctx = makeCtx({ [node.id]: handler }, controller.signal);
    const previousRemovals = vi.mocked(fsPromises.rm).mock.calls.length;
    let status: string | undefined;
    const outcome = executeCodeStepNode(createTestCall(), node, ctx, emptyExpressionCtx).then((value) => {
      status = value.status;
    });

    const signal = await started.promise;
    controller.abort();
    try {
      expect(signal).toBe(controller.signal);
      await expect.poll(() => status).toBe('cancelled');
      const removals = vi.mocked(fsPromises.rm).mock.calls.slice(previousRemovals);
      expect(removals).toEqual([[expect.stringContaining('makaio-local-step-'), { recursive: true, force: true }]]);
      await expect(fsPromises.access(removals[0][0])).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release.resolve('late result');
      await outcome;
    }
  });

  it('passes only portable data and scoped operations to the local handler', async () => {
    const node: WorkflowCodeStepNode = { id: 'restricted-context', type: 'code-step' };
    const handler: CodeStepHandler = (step) => Object.keys(step).sort();
    const ctx = makeCtx({ [node.id]: handler });
    const outcome = await executeCodeStepNode(createTestCall(), node, ctx, {
      ...emptyExpressionCtx,
      item: 'review',
      index: 0,
      previous: null,
    });

    expect(outcome).toEqual({
      status: 'completed',
      output: [
        'config',
        'executionId',
        'index',
        'inputs',
        'item',
        'launchProcess',
        'previous',
        'previousSteps',
        'request',
        'signal',
        'workflowId',
      ],
    });
  });

  it.each([
    { cwd: '..', program: process.execPath, code: 'cwd-outside-workspace' },
    { cwd: '.', program: './missing-code-step-program', code: 'command-not-found' },
  ])('returns $code before supplying a process handle', async ({ cwd, program, code }) => {
    const node: WorkflowCodeStepNode = { id: 'refused-process', type: 'code-step' };
    const handler: CodeStepHandler = async (step) => {
      const decision = await step.launchProcess({ program, args: [], cwd, stdin: 'none' });
      return decision.ok ? { ok: true } : decision;
    };
    const outcome = await executeCodeStepNode(
      createTestCall(),
      node,
      makeCtx({ [node.id]: handler }),
      emptyExpressionCtx,
    );
    expect(outcome).toEqual({
      status: 'completed',
      output: { ok: false, code: process.platform === 'win32' ? 'unsupported-site' : code },
    });
  });

  it('reports a fixed failure when the local step workspace cannot be cleaned up', async () => {
    const { rm: originalRemove } = await vi.importActual<typeof fsPromises>('node:fs/promises');
    const directories: Parameters<typeof originalRemove>[0][] = [];
    const remove = vi.spyOn(fsPromises, 'rm').mockImplementationOnce(async (path) => {
      directories.push(path);
      throw new Error('private cleanup detail');
    });
    const node: WorkflowCodeStepNode = { id: 'cleanup-process', type: 'code-step' };
    const handler: CodeStepHandler = async (step) => {
      await step.launchProcess({ program: process.execPath, args: [], cwd: '..', stdin: 'none' });
      return null;
    };
    try {
      await expect(
        executeCodeStepNode(createTestCall(), node, makeCtx({ [node.id]: handler }), emptyExpressionCtx),
      ).resolves.toEqual({ status: 'failed', error: 'makaio.step-process-cleanup-failed' });
    } finally {
      remove.mockRestore();
      await Promise.all(directories.map((path) => originalRemove(path, { recursive: true, force: true })));
    }
  });

  it('uses the caller-local launch configuration for child environment and timeout', async () => {
    const node: WorkflowCodeStepNode = { id: 'configured-process', type: 'code-step' };
    const handler: CodeStepHandler = async (step) => {
      const started = await step.launchProcess({
        program: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.STEP_TEST_SETTING ?? "missing"); setTimeout(() => {}, 500)'],
        cwd: '.',
        stdin: 'none',
      });
      if (!started.ok) return started;
      const reader = started.handle.stdout?.getReader();
      const chunk = await reader?.read();
      const result = await started.handle.result;
      return { value: new TextDecoder().decode(chunk?.value), status: result.status };
    };
    const original = makeCtx({ [node.id]: handler });
    const ctx = new RuntimeContext(
      original.executionId,
      original.workflowId,
      original.definition,
      original.execution,
      original.runtimeHandlers,
      original.bus,
      original.signal,
      undefined,
      undefined,
      { context: original.platformContext, env: { STEP_TEST_SETTING: 'configured' } },
      { stepTimeoutMs: 200 },
    );
    const result = await executeCodeStepNode(createTestCall(), node, ctx, emptyExpressionCtx);
    expect(result).toEqual({ status: 'completed', output: { value: 'configured', status: 'timed-out' } });
  });

  it('launches a real local child and exposes only the portable handle', async () => {
    const node: WorkflowCodeStepNode = { id: 'local-process', type: 'code-step' };
    const handler: CodeStepHandler = async (step) => {
      const started = await step.launchProcess({
        program: process.execPath,
        args: ['-e', 'process.stdout.write("pipe-proof")'],
        cwd: '.',
        stdin: 'none',
      });
      if (!started.ok) return started;
      const result = await started.handle.result;
      expect(started.handle).not.toHaveProperty('pid');
      expect(started.handle).not.toHaveProperty('signal');
      expect(started.handle).not.toHaveProperty('cwd');
      expect(started.handle).not.toHaveProperty('path');
      return { status: result.status, exitCode: result.exitCode ?? null };
    };
    const ctx = makeCtx({ [node.id]: handler });
    const outcome = await executeCodeStepNode(createTestCall(), node, ctx, emptyExpressionCtx);

    expect(outcome).toEqual({ status: 'completed', output: { status: 'completed', exitCode: 0 } });
  });
});

describe('executeAgentStepNode', () => {
  it('normalizes monotonic delegate duration to safe integer milliseconds', () => {
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(10.6)
      .mockReturnValueOnce(9)
      .mockReturnValueOnce(Number.POSITIVE_INFINITY)
      .mockReturnValueOnce(Number.MAX_SAFE_INTEGER + 1_000);
    try {
      expect(elapsedDelegateDuration(0)).toBe(11);
      expect(elapsedDelegateDuration(10)).toBe(0);
      expect(elapsedDelegateDuration(0)).toBe(0);
      expect(elapsedDelegateDuration(0)).toBe(Number.MAX_SAFE_INTEGER);
    } finally {
      now.mockRestore();
    }
  });

  it('runs turn-completed agent steps through a fresh-context subagent', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'review-delegate',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review {{ ctx.inputs.title }}',
      outputSchema: { type: 'object' },
      timeoutMs: 1_000,
      completion: 'turn',
      resultFinalizerId: 'artifact.read-wrap',
    };
    const hostBus = makeBusWithFrames();
    const ctx = makeCtx({}, undefined, hostBus);
    const createdSessions: unknown[] = [];
    const attachedAgents: unknown[] = [];
    const sentMessages: unknown[] = [];
    const awaitedTurns: unknown[] = [];
    const closedSessions: unknown[] = [];
    const finalizedResults: unknown[] = [];
    const spawned: unknown[] = [];
    let parentSessionReads = 0;
    const resultFinalizer = createWorkflowDelegateResultFinalizerNamespace('artifact.read-wrap');
    hostBus.registerNamespace(resultFinalizer.namespace);
    const unsubscribeFinalizer = ctx.bus.on(resultFinalizer.subjects.finalize, (requestCtx) => {
      finalizedResults.push(requestCtx.payload);
      requestCtx.setResult({ output: requestCtx.payload.rawResult as JsonValue });
    });

    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      expect(requestCtx.payload.roleId).toBe('reviewer');
      requestCtx.setResult({
        adapterName: 'claude-code',
        model: 'sonnet',
        reasoningEffort: 'high',
        systemPrompt: 'Review carefully.',
        providerContext: REVIEW_PROVIDER_CONTEXT,
      });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      spawned.push(requestCtx.payload);
      requestCtx.setResult({ subagentId: 'subagent-review-delegate', status: 'spawning' });
    });
    const unsubscribeSubagentAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({
        status: 'completed',
        result: '{"approved":true}',
        usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, toolCallCount: 2 },
      });
    });
    const unsubscribeCreate = ctx.bus.on(SessionSubjects.create, (requestCtx) => {
      createdSessions.push(requestCtx.payload);
      requestCtx.setResult({ sessionId: requestCtx.payload.sessionId ?? 'workflow-session-review-delegate' });
    });
    const unsubscribeParentSession = ctx.bus.on(SessionSubjects.get, (requestCtx) => {
      parentSessionReads++;
      expect(requestCtx.payload).toEqual({ sessionId: 'exec-test' });
      requestCtx.setResult({
        session: {
          sessionId: 'exec-test',
          createdAt: 0,
          lastActivityAt: 0,
          status: 'active',
          agents: [],
        },
      });
    });
    const unsubscribeAttach = ctx.bus.on(SessionSubjects.agent.attachResolved, (requestCtx) => {
      attachedAgents.push(requestCtx.payload);
      requestCtx.setResult({
        agentId: 'agent-review-delegate',
        adapterSessionId: 'adapter-session-review-delegate',
        role: 'lead',
      });
    });
    const unsubscribeSendMessage = ctx.bus.on(SessionSubjects.sendMessage, async (requestCtx) => {
      sentMessages.push(requestCtx.payload);
      await ctx.bus.emit(requestCtx.call, AgentSubjects.complete, {
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
      const outcome = await executeAgentStepNode(
        createTestCall(),
        node,
        ctx,
        {
          ...emptyExpressionCtx,
          inputs: { title: 'workflow runtime' },
        },
        'frame-review-delegate',
      );

      expect(outcome).toEqual({ status: 'completed', output: '{"approved":true}' });
      expect(spawned).toEqual([
        expect.objectContaining({
          parentSessionId: 'exec-test',
          depth: 1,
          config: expect.objectContaining({
            task: 'Review workflow runtime',
            adapterName: 'claude-code',
            model: 'sonnet',
            completion: 'turn',
            contextMode: 'fresh',
            responseSchema: { schema: { type: 'object' } },
          }),
        }),
      ]);
      expect(createdSessions).toEqual([]);
      expect(attachedAgents).toEqual([]);
      expect(sentMessages).toEqual([]);
      expect(awaitedTurns).toEqual([]);
      expect(closedSessions).toEqual([]);
      expect(parentSessionReads).toBe(0);
      expect(finalizedResults).toEqual([
        expect.objectContaining({
          frameId: 'frame-review-delegate',
          nodeId: 'review-delegate',
          economics: {
            durationMs: expect.any(Number),
            inputTokens: 100,
            cachedInputTokens: 20,
            outputTokens: 30,
            toolCallCount: 2,
            binding: {
              adapterName: 'claude-code',
              providerConfigId: 'provider-config-review',
              providerDefinitionId: REVIEW_PROVIDER_CONTEXT.definitionId,
              model: 'sonnet',
              auth: {
                mode: REVIEW_PROVIDER_CONTEXT.auth.mode,
                owner: REVIEW_PROVIDER_CONTEXT.auth.method.owner,
                methodId: REVIEW_PROVIDER_CONTEXT.auth.method.methodId,
              },
            },
          },
        }),
      ]);
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeSubagentAwait();
      unsubscribeCreate();
      unsubscribeParentSession();
      unsubscribeAttach();
      unsubscribeSendMessage();
      unsubscribeTurnAwait();
      unsubscribeClose();
      unsubscribeFinalizer();
    }
  });

  it('fails agent-step execution when the unified subagent runtime is unavailable', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'review-delegate-unavailable',
      type: 'agent-step',
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
      const outcome = await executeAgentStepNode(
        createTestCall(),
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
        error: "Subagent runtime is not available for agent step 'review-delegate-unavailable'",
      });
      expect(closedSessions).toEqual([]);
    } finally {
      unsubscribeRole();
      unsubscribeCreate();
      unsubscribeClose();
    }
  });

  it('preserves subagent semantics for agent steps with default tool completion', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'review-delegate-tool',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review {{ ctx.inputs.title }}',
      outputSchema: { type: 'object' },
      timeoutMs: 1_000,
      allowedTools: ['artifact.read'],
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
        providerConfigId: 'provider-config-review',
        adapterConfig: {},
        tools: ['filesystem.write'],
        disallowedTools: ['artifact.read'],
        allowedDirectories: [],
        providerContext: REVIEW_PROVIDER_CONTEXT_WITHOUT_CAPABILITIES,
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
      const outcome = await executeAgentStepNode(
        createTestCall(),
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
            providerConfigId: 'provider-config-review',
            adapterConfig: {},
            tools: ['artifact.read'],
            allowedDirectories: [],
            providerContext: REVIEW_PROVIDER_CONTEXT_WITHOUT_CAPABILITIES,
            responseSchema: { schema: { type: 'object' } },
          }),
        }),
      ]);
      expect((spawned[0] as { config: Record<string, unknown> }).config).not.toHaveProperty('disallowedTools');
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
      unsubscribeSendMessage();
    }
  });

  it('fails agent steps when the role cannot resolve', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'missing-reviewer',
      type: 'agent-step',
      role: 'unknown-reviewer',
      prompt: 'Review',
    };
    const ctx = makeCtx({});

    const outcome = await executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain("Role 'unknown-reviewer' could not be resolved");
    }
  });

  it('applies exact node tools and authority finalization before returning an agent-step result', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'read-artifact',
      type: 'agent-step',
      role: 'artifact-reader',
      prompt: 'Read the artifact',
      allowedTools: ['artifact.read'],
      completion: 'tool',
      resultFinalizerId: 'artifact.read-wrap',
    };
    const hostBus = makeBusWithFrames();
    const ctx = makeCtx({}, undefined, hostBus);
    const finalizer = createWorkflowDelegateResultFinalizerNamespace('artifact.read-wrap');
    hostBus.registerNamespace(finalizer.namespace);
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({
        adapterName: 'claude-code',
        tools: ['filesystem.write'],
        disallowedTools: ['artifact.read'],
      });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      expect(requestCtx.payload.config.tools).toEqual(['artifact.read']);
      expect(requestCtx.payload.config.disallowedTools).toBeUndefined();
      expect(requestCtx.payload.config.completion).toBe('tool');
      requestCtx.setResult({ subagentId: 'subagent-read', status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({
        status: 'completed',
        result: 'model summary',
        toolObservations: [
          {
            toolName: 'artifact.read',
            outcome: 'success',
            artifact: { kind: 'solution-design', id: 'design-1', revision: '3' },
          },
        ],
      });
    });
    const unsubscribeFinalizer = ctx.bus.on(finalizer.subjects.finalize, (requestCtx) => {
      expect(requestCtx.payload).toEqual({
        executionId: 'exec-test',
        workflowId: 'workflow-test',
        frameId: 'frame-read',
        nodeId: 'read-artifact',
        rawResult: 'model summary',
        toolObservations: [
          {
            toolName: 'artifact.read',
            outcome: 'success',
            artifact: { kind: 'solution-design', id: 'design-1', revision: '3' },
          },
        ],
        economics: {
          durationMs: expect.any(Number),
          binding: { adapterName: 'claude-code' },
        },
      });
      requestCtx.setResult({ output: { artifact: { id: 'artifact-1' }, summary: 'model summary' } });
    });

    try {
      await expect(
        executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx, 'frame-read'),
      ).resolves.toEqual({
        status: 'completed',
        output: { artifact: { id: 'artifact-1' }, summary: 'model summary' },
      });
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
      unsubscribeFinalizer();
    }
  });

  it('fails an agent step when its selected authority finalizer rejects', async () => {
    const node: WorkflowAgentStepNode = {
      id: 'read-artifact',
      type: 'agent-step',
      role: 'artifact-reader',
      prompt: 'Read the artifact',
      resultFinalizerId: 'artifact.read-wrap',
    };
    const hostBus = makeBusWithFrames();
    const ctx = makeCtx({}, undefined, hostBus);
    const finalizer = createWorkflowDelegateResultFinalizerNamespace('artifact.read-wrap');
    hostBus.registerNamespace(finalizer.namespace);
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-read', status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({ status: 'completed', result: 'model summary' });
    });
    const unsubscribeFinalizer = ctx.bus.on(finalizer.subjects.finalize, () => {
      throw new Error('authority unavailable');
    });

    try {
      await expect(executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx, 'frame-read')).rejects.toThrow(
        'authority unavailable',
      );
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
      unsubscribeFinalizer();
    }
  });

  it('cancels a spawned agent step while its authority finalizer is pending', async () => {
    const controller = new AbortController();
    const node: WorkflowAgentStepNode = {
      id: 'read-artifact',
      type: 'agent-step',
      role: 'artifact-reader',
      prompt: 'Read the artifact',
      resultFinalizerId: 'artifact.read-wrap',
    };
    const hostBus = makeBusWithFrames();
    const ctx = makeCtx({}, controller.signal, hostBus);
    const finalizer = createWorkflowDelegateResultFinalizerNamespace('artifact.read-wrap');
    hostBus.registerNamespace(finalizer.namespace);
    let markFinalizerStarted: () => void = () => undefined;
    const finalizerStarted = new Promise<void>((resolve) => {
      markFinalizerStarted = resolve;
    });
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-read', status: 'spawning' });
    });
    const unsubscribeAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({ status: 'completed', result: 'model summary' });
    });
    const unsubscribeFinalizer = ctx.bus.on(finalizer.subjects.finalize, async () => {
      markFinalizerStarted();
      await new Promise<void>(() => undefined);
    });

    try {
      const outcome = executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx, 'frame-read');
      await finalizerStarted;
      controller.abort();
      await expect(outcome).resolves.toEqual({ status: 'cancelled' });
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeAwait();
      unsubscribeFinalizer();
    }
  });

  it('cancels a turn-completed agent step while its authority finalizer is pending', async () => {
    const controller = new AbortController();
    const node: WorkflowAgentStepNode = {
      id: 'review-delegate',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review',
      completion: 'turn',
      resultFinalizerId: 'artifact.read-wrap',
    };
    const hostBus = makeBusWithFrames();
    const ctx = makeCtx({}, controller.signal, hostBus);
    const finalizer = createWorkflowDelegateResultFinalizerNamespace('artifact.read-wrap');
    hostBus.registerNamespace(finalizer.namespace);
    let markFinalizerStarted: () => void = () => undefined;
    const finalizerStarted = new Promise<void>((resolve) => {
      markFinalizerStarted = resolve;
    });
    const unsubscribeRole = ctx.bus.on(WorkflowSubjects.resolveRole, (requestCtx) => {
      requestCtx.setResult({ adapterName: 'claude-code' });
    });
    const unsubscribeSpawn = ctx.bus.on(SubagentSubjects.spawn, (requestCtx) => {
      requestCtx.setResult({ subagentId: 'subagent-review', status: 'spawning' });
    });
    const unsubscribeSubagentAwait = ctx.bus.on(SubagentSubjects.await, (requestCtx) => {
      requestCtx.setResult({ status: 'completed', result: 'model summary' });
    });
    const unsubscribeCreate = ctx.bus.on(SessionSubjects.create, (requestCtx) => {
      requestCtx.setResult({ sessionId: requestCtx.payload.sessionId ?? 'delegate-session' });
    });
    const unsubscribeAttach = ctx.bus.on(SessionSubjects.agent.attachResolved, (requestCtx) => {
      requestCtx.setResult({ agentId: 'agent-review', adapterSessionId: 'adapter-session-review', role: 'lead' });
    });
    const unsubscribeSend = ctx.bus.on(SessionSubjects.sendMessage, async (requestCtx) => {
      await ctx.bus.emit(requestCtx.call, AgentSubjects.complete, {
        agentId: 'agent-review',
        adapterId: 'adapter-review',
        adapterName: 'claude-code',
        adapterSessionId: 'adapter-session-review',
        sessionId: requestCtx.payload.sessionId,
        messageId: 'message-review',
        turnId: 'turn-review',
        message: 'model summary',
      });
      requestCtx.setResult({
        sessionId: requestCtx.payload.sessionId,
        messageId: 'message-review',
        turnId: 'turn-review',
      });
    });
    const unsubscribeAwait = ctx.bus.on(SessionSubjects.turn.await, (requestCtx) => {
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
      requestCtx.setResult({ success: true });
    });
    const unsubscribeFinalizer = ctx.bus.on(finalizer.subjects.finalize, async () => {
      markFinalizerStarted();
      await new Promise<void>(() => undefined);
    });

    try {
      const outcome = executeAgentStepNode(createTestCall(), node, ctx, emptyExpressionCtx, 'frame-review');
      await finalizerStarted;
      controller.abort();
      await expect(outcome).resolves.toEqual({ status: 'cancelled' });
    } finally {
      unsubscribeRole();
      unsubscribeSpawn();
      unsubscribeSubagentAwait();
      unsubscribeCreate();
      unsubscribeAttach();
      unsubscribeSend();
      unsubscribeAwait();
      unsubscribeClose();
      unsubscribeFinalizer();
    }
  });
});

describe('runtime frame persistence', () => {
  it.each([
    {
      scenario: 'frame storage has no handler',
      failFirstWrite: false,
      error: 'No handler registered for request subject "storage:workflow.setFrame"',
    },
    {
      scenario: 'the first frame write fails and later writes could succeed',
      failFirstWrite: true,
      error: 'Request to "setFrame" failed: First frame write failed',
    },
  ])('fails the workflow before executing a step when $scenario', async ({ failFirstWrite, error }) => {
    const bus = makeBus();
    const unsubscribeFrames = failFirstWrite ? registerInMemoryFrameStore(bus, { failFirstWrite }) : undefined;
    const unsubscribeBootstrap = bus.on(WorkflowSubjects.bootstrapAuthorityState, (ctx) => {
      ctx.setResult({ persisted: true });
    });
    const handler = vi.fn(() => ({ ok: true }));
    const definition = makeDefinition('frame-storage-failure');
    definition.root.nodes.push({ id: 'persist', type: 'code-step' });
    const call = createTestCall();
    const executionId = 'exec-frame-storage-failure';

    try {
      const result = await runWorkflowOrchestrator({
        call,
        config: {
          executionId,
          workflowId: definition.id,
          source: { kind: 'definition', workflowId: definition.id },
          coordinatorSessionId: 'coordinator-frame-storage',
          cancelSubject: 'workflow.exec-frame-storage-failure.cancel',
          terminalAuthority: 'authority',
          inputs: {},
          triggerPayload: {},
          scope: definition.scope,
          busAuth: { kind: 'none' },
          env: {},
        },
        loaded: { definition, runtimeHandlers: new Map([['persist', handler]]) },
        bus,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: 'failed', error });
      expect(handler).not.toHaveBeenCalled();
      if (failFirstWrite) {
        await expect(bus.request(call, WorkflowStorageSubjects.listFrames, { executionId })).resolves.toEqual({
          frames: [],
        });
      }
    } finally {
      unsubscribeBootstrap();
      unsubscribeFrames?.();
    }
  });

  it('persists frame lifecycle transitions through setFrame and mirrors span read-model rows', async () => {
    const persistedFrames: Array<{ nodeId: string; output?: unknown; status: WorkflowFrameState['status'] }> = [];
    const persistedSpans: Array<Pick<SpanRecord, 'frameId' | 'stepId' | 'stepType' | 'status' | 'output'>> = [];
    const handler: CodeStepHandler = () => ({ ok: true });
    const ctx = makeCtx({ persist: handler }, undefined, makeBus());
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
        createTestCall(),
        {
          id: 'root',
          type: 'sequence',
          nodes: [{ id: 'persist', type: 'code-step' } as WorkflowCodeStepNode],
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
          stepType: 'code-step',
          status: 'running',
          output: undefined,
        }),
        expect.objectContaining({
          stepId: 'persist',
          frameId: expect.any(String),
          stepType: 'code-step',
          status: 'completed',
          output: '{"ok":true}',
        }),
      ]);
    } finally {
      unsubscribeFrame();
      unsubscribeSpan();
    }
  });

  it('persists the completed frame when the running span mirror fails', async () => {
    const ctx = makeCtx({ persist: () => ({ ok: true }) });
    const call = createTestCall();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unsubscribe = ctx.bus.on(WorkflowStorageSubjects.setSpan, (requestCtx) => {
      if (requestCtx.payload.span.status === 'running') throw new Error('Span mirror unavailable');
      requestCtx.setResult({ id: requestCtx.payload.span.frameId });
    });

    try {
      const definition = makeDefinition('span-storage-failure');
      definition.root.nodes.push({ id: 'persist', type: 'code-step' });
      const result = await executeSequence(call, definition.root, ctx, emptyExpressionCtx);

      expect(result.status).toBe('completed');
      await expect(
        ctx.bus.request(call, WorkflowStorageSubjects.listFrames, { executionId: ctx.executionId }),
      ).resolves.toMatchObject({
        frames: [{ nodeId: 'persist', status: 'completed', output: { ok: true } }],
      });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      warn.mockRestore();
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
      const firstFrame = ctx.createFrame(createTestCall(), { nodeId: 'review', nodeType: 'code-step', path: [] });
      await ctx.updateFrame(createTestCall(), firstFrame.frameId, { status: 'running', startedAt: 10 });
      await ctx.updateFrame(createTestCall(), firstFrame.frameId, { status: 'completed', completedAt: 20 });

      const secondFrame = ctx.createFrame(createTestCall(), { nodeId: 'review', nodeType: 'code-step', path: [] });
      await ctx.updateFrame(createTestCall(), secondFrame.frameId, { status: 'running', startedAt: 30 });
      await ctx.updateFrame(createTestCall(), secondFrame.frameId, { status: 'completed', completedAt: 40 });

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
    const handlers: Record<string, CodeStepHandler> = {
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
          type: 'code-step',
          when: "ctx.inputs.run == 'yes'",
        } as WorkflowCodeStepNode,
        {
          id: 'skipped',
          type: 'code-step',
          skip: 'ctx.inputs.skipSkipped == true',
        } as WorkflowCodeStepNode,
      ],
    };

    const outcome = await executeSequence(createTestCall(), root, makeCtx(handlers), {
      ...emptyExpressionCtx,
      inputs: { run: 'yes', skipSkipped: true },
    });

    expect(outcome.status).toBe('completed');
    expect(ran).toEqual(['allowed']);
  });

  it('evaluates when expressions against previousSteps keyed by earlier node ID', async () => {
    let fixRan = false;
    const handlers: Record<string, CodeStepHandler> = {
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
        { id: 'triage', type: 'code-step' } as WorkflowCodeStepNode,
        {
          id: 'fix',
          type: 'code-step',
          when: "previousSteps['triage'].output.action == 'approve'",
        } as WorkflowCodeStepNode,
      ],
    };

    const outcome = await executeSequence(createTestCall(), root, makeCtx(handlers), emptyExpressionCtx);

    expect(outcome.status).toBe('completed');
    expect(fixRan).toBe(true);
  });

  it('evaluates iterate collections against the latest completed output alias', async () => {
    const applied: unknown[] = [];
    const handlers: Record<string, CodeStepHandler> = {
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
        nodes: [{ id: 'apply-item', type: 'code-step' } as WorkflowCodeStepNode],
      },
    };
    const root: WorkflowSequenceNode = {
      id: 'output-root',
      type: 'sequence',
      nodes: [{ id: 'aggregate', type: 'code-step' } as WorkflowCodeStepNode, iterateNode],
    };

    const outcome = await executeSequence(createTestCall(), root, makeCtx(handlers), emptyExpressionCtx);

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
   * single code step whose handler is provided.
   * @param nodeId - Parallel node ID.
   * @param branches - Map of branch key to handler.
   */
  function makeParallelNode(
    nodeId: string,
    branches: Record<string, CodeStepHandler>,
  ): { node: WorkflowParallelNode; handlers: Record<string, CodeStepHandler> } {
    const branchMap: WorkflowParallelNode['branches'] = {};
    const handlers: Record<string, CodeStepHandler> = {};

    for (const [branchKey, handler] of Object.entries(branches)) {
      const codeStepId = `${nodeId}__${branchKey}__step`;
      handlers[codeStepId] = handler;
      branchMap[branchKey] = {
        id: `${nodeId}__${branchKey}__seq`,
        type: 'sequence',
        nodes: [
          {
            id: codeStepId,
            type: 'code-step' as const,
          } as WorkflowCodeStepNode,
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
    const parallelFrame = ctx.createFrame(createTestCall(), {
      nodeId: 'parallel-1',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      createTestCall(),
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

  it('uses the final branch code step by sequence order when start timestamps tie', async () => {
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
              { id: 'parallel-order__alpha__draft', type: 'code-step' } as WorkflowCodeStepNode,
              { id: 'parallel-order__alpha__final', type: 'code-step' } as WorkflowCodeStepNode,
            ],
          },
        },
      };

      const ctx = makeCtx({
        'parallel-order__alpha__draft': () => 'draft-output',
        'parallel-order__alpha__final': () => 'final-output',
      });
      const parallelFrame = ctx.createFrame(createTestCall(), {
        nodeId: 'parallel-order',
        nodeType: 'parallel',
        path: [],
      });

      const outcome = await executeParallelNode(
        createTestCall(),
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
    const parallelFrame = ctx.createFrame(createTestCall(), {
      nodeId: 'parallel-mixed',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      createTestCall(),
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

    const ctx = makeCtx(handlers, undefined, makeBus());
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
    const parallelFrame = ctx.createFrame(createTestCall(), {
      nodeId: 'framed-parallel',
      nodeType: 'parallel',
      path: [],
    });

    try {
      const outcome = await executeParallelNode(
        createTestCall(),
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
    const parallelFrame = ctx.createFrame(createTestCall(), {
      nodeId: 'empty-parallel',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      createTestCall(),
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
    const parallelFrame = ctx.createFrame(createTestCall(), {
      nodeId: 'aborted-parallel',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      createTestCall(),
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
    const codeStepId = 'fail-fast__failing__step';
    const passingId = 'fail-fast__passing__step';
    let passingStarted = false;
    let passingCompleted = false;

    const handlers: Record<string, CodeStepHandler> = {
      [codeStepId]: () => {
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
          nodes: [{ id: codeStepId, type: 'code-step' as const } as WorkflowCodeStepNode],
        },
        passing: {
          id: 'fail-fast__passing__seq',
          type: 'sequence',
          nodes: [{ id: passingId, type: 'code-step' as const } as WorkflowCodeStepNode],
        },
      },
    };

    const ctx = makeCtx(handlers);
    const parallelFrame = ctx.createFrame(createTestCall(), {
      nodeId: 'fail-fast',
      nodeType: 'parallel',
      path: [],
    });

    const outcome = await executeParallelNode(
      createTestCall(),
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

    const fastFailId = 'ff-sibling__fast-fail__step';
    const slowId = 'ff-sibling__slow__step';

    const requestStarted = Promise.withResolvers<void>();
    const releaseRequest = Promise.withResolvers<void>();
    const handlers: Record<string, CodeStepHandler> = {
      [fastFailId]: async () => {
        await requestStarted.promise;
        cancelTracker.push('fail-started');
        throw new Error('fast fail');
      },
      [slowId]: async (step) => {
        const result = await step.request({ subject: 'runtime-step-test.pending', payload: {} });
        cancelTracker.push(result.ok ? 'slow-completed' : 'slow-aborted');
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
          nodes: [{ id: fastFailId, type: 'code-step' as const } as WorkflowCodeStepNode],
        },
        slow: {
          id: 'ff-sibling__slow__seq',
          type: 'sequence',
          nodes: [{ id: slowId, type: 'code-step' as const } as WorkflowCodeStepNode],
        },
      },
    };

    const hostBus = makeBusWithFrames();
    const ctx = makeCtx(handlers, undefined, hostBus);
    const { subjects } = hostBus.registerNamespace(StepRequestTestNamespace);
    const cleanup = ctx.bus.on(subjects.pending, async (request) => {
      requestStarted.resolve();
      await releaseRequest.promise;
      request.setResult({ completed: true });
    });
    const parallelFrame = ctx.createFrame(createTestCall(), {
      nodeId: 'ff-sibling',
      nodeType: 'parallel',
      path: [],
    });

    try {
      const outcome = await executeParallelNode(
        createTestCall(),
        node,
        ctx,
        emptyExpressionCtx,
        executeSequence,
        parallelFrame.frameId,
        parallelFrame.path,
        'fail-fast',
      );

      expect(outcome.status).toBe('failed');
      expect(cancelTracker).toEqual(['fail-started', 'slow-aborted']);
    } finally {
      releaseRequest.resolve();
      cleanup();
    }
  });
});

describe('executeSequence with serialized parallel mode', () => {
  it('uses fail-fast mode from the workflow node schema during dispatcher execution', async () => {
    const failingId = 'serialized-fail-fast__fail';
    const skippedId = 'serialized-fail-fast__slow';
    const handlers: Record<string, CodeStepHandler> = {
      [failingId]: () => {
        throw new Error('serialized branch failed');
      },
      [skippedId]: async () => {
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
          nodes: [{ id: failingId, type: 'code-step' } as WorkflowCodeStepNode],
        },
        slow: {
          id: 'serialized-fail-fast__slow__seq',
          type: 'sequence',
          nodes: [{ id: skippedId, type: 'code-step' } as WorkflowCodeStepNode],
        },
      },
    };
    const root = { id: 'serialized-root', type: 'sequence' as const, nodes: [parallel] };
    const ctx = makeCtx(handlers);

    const outcome = await executeSequence(createTestCall(), root, ctx, emptyExpressionCtx);

    expect(outcome).toEqual({ status: 'failed', error: 'serialized branch failed' });
  });
});

// ─────────────────────────────────────────────────────────────
// Code step handler state context tests
// ─────────────────────────────────────────────────────────────

describe('workflow state requests', () => {
  it('reads and patches declared workflow state through scoped requests', async () => {
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

    const handlers: Record<string, CodeStepHandler> = {
      'test-state-step': async (ctx) => {
        const fetched = await ctx.request({ subject: 'workflow.state.get', payload: { executionId: ctx.executionId } });
        if (!fetched.ok) throw new Error(fetched.code);
        const snapshot = WorkflowSchemas['state.get'].response.parse(fetched.response);
        capturedState = snapshot.value;

        const patched = await ctx.request({
          subject: 'workflow.state.patch',
          payload: {
            executionId: ctx.executionId,
            expectedSequence: snapshot.sequence,
            patch: [
              { op: 'add', path: '/selectedReviewers/0', value: 'spec-compliance-reviewer' },
              { op: 'replace', path: '/tier', value: 'T2' },
            ],
            nextValue: { tier: 'T2', selectedReviewers: ['spec-compliance-reviewer'] },
          },
        });
        if (!patched.ok) throw new Error(patched.code);
        capturedAfterUpdate = WorkflowSchemas['state.patch'].response.parse(patched.response).value;

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

    const node: WorkflowCodeStepNode = {
      id: 'test-state-step',
      type: 'code-step',
    };

    try {
      const outcome = await executeCodeStepNode(createTestCall(), node, runtimeCtx, emptyExpressionCtx);

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

  it('keeps state off the handler context', async () => {
    let exposesState: boolean | undefined;

    const handlers: Record<string, CodeStepHandler> = {
      'no-state-step': async (ctx) => {
        exposesState = 'state' in ctx;
        return { ok: true };
      },
    };

    const runtimeCtx = makeCtx(handlers);
    const node: WorkflowCodeStepNode = {
      id: 'no-state-step',
      type: 'code-step',
    };

    await executeCodeStepNode(createTestCall(), node, runtimeCtx, emptyExpressionCtx);
    expect(exposesState).toBe(false);
  });
});
