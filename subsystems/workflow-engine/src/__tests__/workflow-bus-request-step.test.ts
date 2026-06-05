import { channelSubject, createBusInstance } from '@makaio/bus-core';
import {
  SessionNamespace,
  SessionSubjects,
  type SpanRecord,
  WorkflowNamespace,
  WorkflowSubjects,
  type WorkflowDefinition,
  type WorkflowExecution,
} from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutor } from '../workflow-executor.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';

/**
 * Minimal request namespace used to exercise bus-request step dispatch.
 *
 * Defined inline so the test is self-contained and does not depend on any
 * product-level namespace registration.
 */
const TestRequestNamespace = createBusNamespace('workflow-test', {
  create: {
    request: z.object({ title: z.string(), count: z.number() }),
    response: z.object({ id: z.string(), title: z.string() }),
  },
  event: z.object({ title: z.string() }),
  optional: {
    request: z.object({ title: z.string(), body: z.string().optional() }),
    response: z.object({ title: z.string(), hasBody: z.boolean() }),
  },
  unsafe: {
    request: z.object({}),
    response: z.any(),
  },
  secret: channelSubject({
    request: z.object({ title: z.string() }),
    response: z.object({ ok: z.boolean() }),
  }),
});

/**
 * Register in-memory storage handlers for all workflow storage subjects.
 *
 * Covers the minimal surface the {@link WorkflowExecutor} calls during inline step execution.
 * @param bus - Isolated bus instance to register handlers on.
 * @param definition - Workflow definition returned for matching ID requests.
 * @param spans - Optional accumulator for persisted step spans.
 * @returns Map that accumulates persisted executions (accessible in tests).
 */
function registerMemoryWorkflowStorage(
  bus: ReturnType<typeof createBusInstance>,
  definition: WorkflowDefinition,
  spans: SpanRecord[] = [],
): Map<string, WorkflowExecution> {
  const executions = new Map<string, WorkflowExecution>();

  bus.on(WorkflowStorageSubjects.get, (ctx) => {
    ctx.setResult({ workflow: ctx.payload.id === definition.id ? definition : null });
  });
  bus.on(WorkflowStorageSubjects.setExecution, (ctx) => {
    executions.set(ctx.payload.execution.id, ctx.payload.execution);
    ctx.setResult({ id: ctx.payload.execution.id });
  });
  bus.on(WorkflowStorageSubjects.setExecutionStart, (ctx) => {
    executions.set(ctx.payload.execution.id, ctx.payload.execution);
    ctx.setResult({ id: ctx.payload.execution.id, executionId: ctx.payload.execution.id });
  });
  bus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
    const execution = executions.get(ctx.payload.executionId);
    if (!execution) {
      ctx.setResult({ success: false });
      return;
    }
    if (ctx.payload.status !== undefined) execution.status = ctx.payload.status;
    if (ctx.payload.error !== undefined) execution.error = ctx.payload.error ?? undefined;
    if (ctx.payload.completedAt !== undefined) execution.completedAt = ctx.payload.completedAt ?? undefined;
    if (ctx.payload.stepUpdates) Object.assign(execution.steps, ctx.payload.stepUpdates);
    ctx.setResult({ success: true });
  });
  bus.on(WorkflowStorageSubjects.getExecution, (ctx) => {
    ctx.setResult({ execution: executions.get(ctx.payload.executionId) ?? null });
  });
  bus.on(WorkflowStorageSubjects.setSpan, (ctx) => {
    spans.push(ctx.payload.span);
    ctx.setResult({ id: `${ctx.payload.span.executionId}:${ctx.payload.span.stepId}` });
  });
  bus.on(WorkflowStorageSubjects.setRunContext, (ctx) => {
    ctx.setResult({ executionId: ctx.payload.runContext.executionId });
  });

  return executions;
}

/**
 * Register a minimal session stub that returns deterministic IDs.
 * @param bus - Isolated bus instance to register handlers on.
 */
function registerSessionStub(bus: ReturnType<typeof createBusInstance>): void {
  let sessionCounter = 0;
  bus.on(SessionSubjects.create, (ctx) => {
    sessionCounter += 1;
    ctx.setResult({ sessionId: `session-${String(sessionCounter)}` });
  });
  bus.on(SessionSubjects.close, (ctx) => {
    ctx.setResult({ success: true });
  });
}

/**
 * Start a one-step workflow and wait until the execution reaches a terminal state.
 * @param bus - Isolated bus instance.
 * @param definition - Workflow definition under test.
 * @param inputs - Optional workflow inputs.
 * @returns Execution state map, span records, created execution ID, and executor cleanup handle.
 */
async function runWorkflowToTerminal(
  bus: ReturnType<typeof createBusInstance>,
  definition: WorkflowDefinition,
  inputs: Record<string, unknown> = {},
): Promise<{
  executions: Map<string, WorkflowExecution>;
  spans: SpanRecord[];
  executionId: string;
  executor: WorkflowExecutor;
}> {
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  bus.registerNamespace(SessionNamespace);
  const spans: SpanRecord[] = [];
  const executions = registerMemoryWorkflowStorage(bus, definition, spans);
  registerSessionStub(bus);

  const executor = new WorkflowExecutor(bus, { stepCooldownMs: 0, stepTimeoutMs: 5_000 });
  await executor.init();

  const executionSettled = new Promise<void>((resolve) => {
    bus.on(WorkflowSubjects.execution.completed, () => {
      resolve();
    });
    bus.on(WorkflowSubjects.execution.failed, () => {
      resolve();
    });
  });

  const { executionId } = await bus.request(WorkflowSubjects.start, {
    workflowId: definition.id,
    inputs,
  });

  await vi.waitFor(() => executionSettled, { timeout: 10_000 });
  return { executions, spans, executionId, executor };
}

describe('bus-request workflow step', () => {
  it('executes a registered bus request and stores JSON output', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    bus.registerNamespace(SessionNamespace);
    bus.registerNamespace(TestRequestNamespace);

    // Register the test request handler.
    bus.on(TestRequestNamespace.subjects.create, (ctx) => {
      ctx.setResult({ id: 'issue-1', title: ctx.payload.title });
    });

    const definition: WorkflowDefinition = {
      id: 'bus-request-flow',
      name: 'Bus Request Flow',
      scope: { type: 'global' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          type: 'bus-request',
          id: 'create',
          subject: 'workflow-test.create',
          payload: { title: 'Plan: {{ inputs.title }}', count: '{{ inputs.count }}' },
        },
      ],
    };
    const executions = registerMemoryWorkflowStorage(bus, definition);
    registerSessionStub(bus);

    const executor = new WorkflowExecutor(bus, { stepCooldownMs: 0, stepTimeoutMs: 5_000 });
    await executor.init();

    let completedEvent = false;
    const executionSettled = new Promise<void>((resolve) => {
      bus.on(WorkflowSubjects.execution.completed, () => {
        completedEvent = true;
        resolve();
      });
      bus.on(WorkflowSubjects.execution.failed, () => {
        resolve();
      });
    });

    const { executionId } = await bus.request(WorkflowSubjects.start, {
      workflowId: definition.id,
      inputs: { title: 'Alpha', count: 3 },
    });

    await vi.waitFor(() => executionSettled, { timeout: 10_000 });
    expect(completedEvent).toBe(true);

    const stored = executions.get(executionId);
    expect(stored?.steps.create).toMatchObject({
      kind: 'executable',
      status: 'completed',
      result: { id: 'issue-1', title: 'Plan: Alpha' },
    });

    await executor.destroy();
  });

  it('fails clearly when the subject is not registered as a request', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    bus.registerNamespace(SessionNamespace);

    const definition: WorkflowDefinition = {
      id: 'missing-subject-flow',
      name: 'Missing Subject Flow',
      scope: { type: 'global' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          type: 'bus-request',
          id: 'missing',
          subject: 'missing.create',
          payload: {},
        },
      ],
    };
    const executions = registerMemoryWorkflowStorage(bus, definition);
    registerSessionStub(bus);

    const executor = new WorkflowExecutor(bus, { stepCooldownMs: 0, stepTimeoutMs: 5_000 });
    await executor.init();

    const executionSettled = new Promise<void>((resolve) => {
      bus.on(WorkflowSubjects.execution.failed, () => {
        resolve();
      });
    });

    const { executionId } = await bus.request(WorkflowSubjects.start, {
      workflowId: definition.id,
    });

    await vi.waitFor(() => executionSettled, { timeout: 10_000 });

    const stored = executions.get(executionId);
    expect(stored?.status).toBe('failed');
    expect(stored?.steps.missing).toMatchObject({
      kind: 'executable',
      status: 'failed',
      error: 'Bus request subject is not registered: missing.create',
    });

    await executor.destroy();
  });

  it('omits missing optional whole-value payload properties before request validation', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(TestRequestNamespace);
    let receivedPayload: unknown;

    bus.on(TestRequestNamespace.subjects.optional, (ctx) => {
      receivedPayload = ctx.payload;
      ctx.setResult({ title: ctx.payload.title, hasBody: 'body' in ctx.payload });
    });

    const definition: WorkflowDefinition = {
      id: 'optional-payload-flow',
      name: 'Optional Payload Flow',
      scope: { type: 'global' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          type: 'bus-request',
          id: 'optional',
          subject: 'workflow-test.optional',
          payload: { title: '{{ inputs.title }}', body: '{{ inputs.body }}' },
        },
      ],
    };

    const { executions, executionId, executor } = await runWorkflowToTerminal(bus, definition, { title: 'Plan' });

    expect(receivedPayload).toEqual({ title: 'Plan' });
    expect(executions.get(executionId)?.steps.optional).toMatchObject({
      kind: 'executable',
      status: 'completed',
      result: { title: 'Plan', hasBody: false },
    });

    await executor.destroy();
  });

  it('fails clearly when the registered subject is an event subject', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(TestRequestNamespace);
    const definition: WorkflowDefinition = {
      id: 'event-subject-flow',
      name: 'Event Subject Flow',
      scope: { type: 'global' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [{ type: 'bus-request', id: 'event', subject: 'workflow-test.event', payload: { title: 'Plan' } }],
    };

    const { executions, executionId, executor } = await runWorkflowToTerminal(bus, definition);

    expect(executions.get(executionId)?.steps.event).toMatchObject({
      kind: 'executable',
      status: 'failed',
      error: 'Bus request subject is not a request subject: workflow-test.event',
    });

    await executor.destroy();
  });

  it('fails clearly when the registered request subject is channel-only', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(TestRequestNamespace);
    const definition: WorkflowDefinition = {
      id: 'channel-subject-flow',
      name: 'Channel Subject Flow',
      scope: { type: 'global' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [{ type: 'bus-request', id: 'secret', subject: 'workflow-test.secret', payload: { title: 'Plan' } }],
    };

    const { executions, executionId, executor } = await runWorkflowToTerminal(bus, definition);

    expect(executions.get(executionId)?.steps.secret).toMatchObject({
      kind: 'executable',
      status: 'failed',
      error: 'Bus request subject is channel-only and cannot be used in a bus-request step: workflow-test.secret',
    });

    await executor.destroy();
  });

  it('fails when the bus request response is not JSON-serializable', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(TestRequestNamespace);
    bus.on(TestRequestNamespace.subjects.unsafe, (ctx) => {
      ctx.setResult({ createdAt: new Date(0) });
    });
    const definition: WorkflowDefinition = {
      id: 'unsafe-response-flow',
      name: 'Unsafe Response Flow',
      scope: { type: 'global' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [{ type: 'bus-request', id: 'unsafe', subject: 'workflow-test.unsafe', payload: {} }],
    };

    const { executions, spans, executionId, executor } = await runWorkflowToTerminal(bus, definition);

    expect(executions.get(executionId)?.steps.unsafe).toMatchObject({
      kind: 'executable',
      status: 'failed',
      error: "Bus-request step 'unsafe' response is not JSON-serializable",
    });
    expect(spans).toEqual([expect.objectContaining({ executionId, stepId: 'unsafe', status: 'failed' })]);

    await executor.destroy();
  });

  it('persists a failed span when the bus request rejects', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(TestRequestNamespace);
    bus.on(TestRequestNamespace.subjects.unsafe, () => {
      throw new Error('request exploded');
    });
    const definition: WorkflowDefinition = {
      id: 'rejected-request-flow',
      name: 'Rejected Request Flow',
      scope: { type: 'global' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [{ type: 'bus-request', id: 'unsafe', subject: 'workflow-test.unsafe', payload: {} }],
    };

    const { executions, spans, executionId, executor } = await runWorkflowToTerminal(bus, definition);

    expect(executions.get(executionId)?.steps.unsafe).toMatchObject({
      kind: 'executable',
      status: 'failed',
      error: 'Request to "unsafe" failed: request exploded',
    });
    expect(spans).toEqual([expect.objectContaining({ executionId, stepId: 'unsafe', status: 'failed' })]);

    await executor.destroy();
  });
});
