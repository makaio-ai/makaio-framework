import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { WorkflowSubjects } from '@makaio/contracts';
import { BusEventTriggerEvaluator } from '../bus-event-trigger-evaluator.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createTestDb, createWorkflowDefinition, type TestDbContext } from './shared.js';

// ─────────────────────────────────────────────────────────────
// Test-only namespaces
//
// Use 'test-' prefixed names to avoid colliding with namespaces
// already registered by @makaio/contracts or other packages.
// ─────────────────────────────────────────────────────────────

/** Simulates git-style worktree/branch events for trigger evaluation tests. */
const { subjects: TestRepoSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('testRepo', {
    worktree: z.object({ path: z.string(), event: z.string() }),
    branch: z.object({ name: z.string(), event: z.string() }),
  }),
);

/**
 * Simulates github-style issue events with dotted sub-subject keys.
 * Dotted keys produce nested accessors: testHub.issues.opened
 */
const { subjects: TestHubSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('testHub', {
    'issues.opened': z.object({ number: z.number(), title: z.string() }),
    'issues.closed': z.object({ number: z.number() }),
    'pr.merged': z.object({ number: z.number() }),
  }),
);

/** Simulates an unrelated namespace to verify non-matching. */
const { subjects: TestSessionSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('testSession', {
    closed: z.object({ sessionId: z.string() }),
  }),
);

/** Simulates build events with numeric fields for filterExpression tests. */
const { subjects: TestBuildSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('testBuild', {
    completed: z.object({ branch: z.string(), count: z.number(), status: z.string() }),
  }),
);

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

/**
 * Result captured from a WorkflowSubjects.start request.
 */
interface CapturedStart {
  workflowId: string;
  triggerPayload: Record<string, unknown> | undefined;
}

const NEGATIVE_START_OBSERVATION_MS = 100;

async function expectNoCapturedStarts(
  capturedStarts: readonly CapturedStart[],
  initialStartCount: number,
): Promise<void> {
  let observedStart = false;

  try {
    await vi.waitUntil(() => capturedStarts.length !== initialStartCount, {
      timeout: NEGATIVE_START_OBSERVATION_MS,
      interval: 5,
    });
    observedStart = true;
  } catch {
    observedStart = false;
  }

  expect(observedStart).toBe(false);
  expect(capturedStarts).toHaveLength(initialStartCount);
}

// ─────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────

describe('BusEventTriggerEvaluator', () => {
  let dbContext: TestDbContext;
  let evaluator: BusEventTriggerEvaluator;
  let cleanupFns: Array<() => void> = [];
  let capturedStarts: CapturedStart[] = [];

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];
    capturedStarts = [];

    dbContext = await createTestDb();

    // Register a minimal WorkflowSubjects.start handler so the evaluator can
    // fire workflows without needing the full WorkflowExecutor stack.
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.start, (ctx) => {
        capturedStarts.push({
          workflowId: ctx.payload.workflowId,
          triggerPayload: ctx.payload.triggerPayload,
        });
        ctx.setResult({ executionId: `exec-${Math.random().toString(36).slice(2)}` });
      }),
    );

    evaluator = new BusEventTriggerEvaluator(MakaioBus);
    await evaluator.init();
  });

  afterEach(() => {
    evaluator.destroy();
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
    dbContext.cleanup();
  });

  // ─────────────────────────────────────────────────────────────
  // Subject matching
  // ─────────────────────────────────────────────────────────────

  it('fires workflow on exact subject match', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [{ type: 'bus-event', subject: 'testRepo.worktree' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    await MakaioBus.emit(TestRepoSubjects.worktree, { path: '/repo', event: 'added' });

    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));
    expect(capturedStarts[0].workflowId).toBe(workflow.id);
  });

  it('fires workflow on wildcard subject match', async () => {
    // 'testHub.issues.*' should match 'testHub.issues.opened' and 'testHub.issues.closed'
    const workflow = createWorkflowDefinition({
      triggers: [{ type: 'bus-event', subject: 'testHub.issues.*' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    await MakaioBus.emit(TestHubSubjects.issues.opened, { number: 42, title: 'Bug' });

    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));
    expect(capturedStarts[0].workflowId).toBe(workflow.id);
  });

  it('does not fire workflow when subject does not match', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [{ type: 'bus-event', subject: 'testRepo.worktree' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    const initialStartCount = capturedStarts.length;
    await MakaioBus.emit(TestSessionSubjects.closed, { sessionId: 'sess-1' });

    await expectNoCapturedStarts(capturedStarts, initialStartCount);
  });

  // ─────────────────────────────────────────────────────────────
  // Shallow filter
  // ─────────────────────────────────────────────────────────────

  it('fires workflow when payload matches shallow filter', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [{ type: 'bus-event', subject: 'testRepo.worktree', filter: { event: 'added' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    await MakaioBus.emit(TestRepoSubjects.worktree, { path: '/repo', event: 'added' });

    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));
    expect(capturedStarts[0].workflowId).toBe(workflow.id);
  });

  it('does not fire workflow when payload fails shallow filter', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [{ type: 'bus-event', subject: 'testRepo.worktree', filter: { event: 'removed' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    const initialStartCount = capturedStarts.length;
    await MakaioBus.emit(TestRepoSubjects.worktree, { path: '/repo', event: 'added' });

    await expectNoCapturedStarts(capturedStarts, initialStartCount);
  });

  it('fires workflow when no filter is specified (matches any payload)', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [{ type: 'bus-event', subject: 'testRepo.worktree' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    await MakaioBus.emit(TestRepoSubjects.worktree, { path: '/any-path', event: 'deleted' });

    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));
  });

  // ─────────────────────────────────────────────────────────────
  // Trigger payload forwarding
  // ─────────────────────────────────────────────────────────────

  it('forwards event payload as triggerPayload in start request', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [{ type: 'bus-event', subject: 'testRepo.worktree' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    const eventPayload = { path: '/my-repo', event: 'added' };
    await MakaioBus.emit(TestRepoSubjects.worktree, eventPayload);

    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));
    expect(capturedStarts[0].triggerPayload).toEqual(eventPayload);
  });

  // ─────────────────────────────────────────────────────────────
  // Dynamic subscription (after init)
  // ─────────────────────────────────────────────────────────────

  it('picks up workflow added after init via definition.created event', async () => {
    // Evaluator is initialized with no workflows in the DB.
    // Store the workflow, then emit the CRUD event manually.
    const workflow = createWorkflowDefinition({
      triggers: [{ type: 'bus-event', subject: 'testRepo.branch' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    // Simulate the storage emitting a definition.created event so the evaluator
    // picks up the new trigger without restarting.
    await MakaioBus.emit(WorkflowSubjects.definition.created, {
      ...workflow,
      steps: [{ id: 'step', type: 'agent', prompt: 'Do work' }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Retry: the evaluator processes events asynchronously.
    await vi.waitFor(async () => {
      await MakaioBus.emit(TestRepoSubjects.branch, { name: 'feature/x', event: 'created' });
      expect(capturedStarts.length).toBeGreaterThan(0);
    });

    expect(capturedStarts[0].workflowId).toBe(workflow.id);
  });

  it('stops firing after workflow is deleted via definition.deleted event', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [{ type: 'bus-event', subject: 'testRepo.worktree' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    // Confirm it fires initially.
    await MakaioBus.emit(TestRepoSubjects.worktree, { path: '/repo', event: 'added' });
    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));

    // Emit the delete event so the evaluator removes the trigger.
    await MakaioBus.emit(WorkflowSubjects.definition.deleted, { id: workflow.id });

    // Reset captures and confirm no more fires.
    capturedStarts.length = 0;
    const initialStartCount = capturedStarts.length;
    await MakaioBus.emit(TestRepoSubjects.worktree, { path: '/repo', event: 'removed' });
    await expectNoCapturedStarts(capturedStarts, initialStartCount);
  });

  // ─────────────────────────────────────────────────────────────
  // Non-bus-event triggers are ignored
  // ─────────────────────────────────────────────────────────────

  it('ignores manual triggers and only indexes bus-event triggers', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [{ type: 'manual' }, { type: 'bus-event', subject: 'testRepo.worktree' }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    await MakaioBus.emit(TestRepoSubjects.worktree, { path: '/repo', event: 'added' });

    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));
    expect(capturedStarts[0].workflowId).toBe(workflow.id);
  });

  // ─────────────────────────────────────────────────────────────
  // Operator-based filter ($in, $ne, $exists, $startsWith, $endsWith)
  // ─────────────────────────────────────────────────────────────

  it('fires workflow when payload field matches $in operator', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [
        {
          type: 'bus-event',
          subject: 'testBuild.completed',
          filter: { status: { $in: ['success', 'warning'] } },
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'main', count: 3, status: 'success' });

    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));
    expect(capturedStarts[0].workflowId).toBe(workflow.id);
  });

  it('does not fire workflow when payload field is not in $in list', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [
        {
          type: 'bus-event',
          subject: 'testBuild.completed',
          filter: { status: { $in: ['success', 'warning'] } },
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    const initialStartCount = capturedStarts.length;
    await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'main', count: 3, status: 'failure' });

    await expectNoCapturedStarts(capturedStarts, initialStartCount);
  });

  // ─────────────────────────────────────────────────────────────
  // filterExpression — jexl evaluation
  // ─────────────────────────────────────────────────────────────

  it('fires workflow when filterExpression evaluates to true', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [
        {
          type: 'bus-event',
          subject: 'testBuild.completed',
          filterExpression: 'payload.count > 5',
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'main', count: 10, status: 'success' });

    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));
    expect(capturedStarts[0].workflowId).toBe(workflow.id);
  });

  it('does not fire workflow when filterExpression evaluates to false', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [
        {
          type: 'bus-event',
          subject: 'testBuild.completed',
          filterExpression: 'payload.count > 5',
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    const initialStartCount = capturedStarts.length;
    await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'main', count: 3, status: 'success' });

    await expectNoCapturedStarts(capturedStarts, initialStartCount);
  });

  // ─────────────────────────────────────────────────────────────
  // filter + filterExpression — AND semantics
  // ─────────────────────────────────────────────────────────────

  it('fires workflow only when both filter and filterExpression pass', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [
        {
          type: 'bus-event',
          subject: 'testBuild.completed',
          filter: { branch: 'main' },
          filterExpression: 'payload.count > 5',
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    // Both conditions pass
    await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'main', count: 10, status: 'success' });
    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));

    // filter passes but filterExpression fails
    capturedStarts.length = 0;
    const filterExpressionFailureStartCount = capturedStarts.length;
    await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'main', count: 2, status: 'success' });
    await expectNoCapturedStarts(capturedStarts, filterExpressionFailureStartCount);

    // filter fails (filterExpression never evaluated)
    capturedStarts.length = 0;
    const filterFailureStartCount = capturedStarts.length;
    await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'develop', count: 10, status: 'success' });
    await expectNoCapturedStarts(capturedStarts, filterFailureStartCount);
  });

  // ─────────────────────────────────────────────────────────────
  // Compiled expression caching
  // ─────────────────────────────────────────────────────────────

  it('reuses the same compiled expression object across multiple evaluations', async () => {
    const expression = await import('@makaio/expression');
    const compileSpy = vi.spyOn(expression, 'compile');
    try {
      evaluator.destroy();
      const workflow = createWorkflowDefinition({
        triggers: [
          {
            type: 'bus-event',
            subject: 'testBuild.completed',
            filterExpression: 'payload.count > 5',
          },
        ],
      });
      await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
      await evaluator.init();
      expect(compileSpy).toHaveBeenCalledTimes(1);

      // Fire three matching events to confirm the compiled expression is reused
      await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'main', count: 10, status: 'success' });
      await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'develop', count: 8, status: 'success' });
      await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'feature/x', count: 6, status: 'success' });

      await vi.waitFor(() => expect(capturedStarts).toHaveLength(3));
      expect(compileSpy).toHaveBeenCalledTimes(1);
      // All three fires targeted the same workflow, confirming the evaluator
      // processed each event through the same indexed (compiled) expression.
      expect(capturedStarts.every((s) => s.workflowId === workflow.id)).toBe(true);
    } finally {
      compileSpy.mockRestore();
    }
  });

  it('skips invalid filterExpression during indexing and still indexes valid triggers', async () => {
    const workflow = createWorkflowDefinition({
      triggers: [
        {
          type: 'bus-event',
          subject: 'testBuild.completed',
          filterExpression: 'payload.count >',
        },
        {
          type: 'bus-event',
          subject: 'testRepo.worktree',
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    evaluator.destroy();
    await evaluator.init();

    await MakaioBus.emit(TestRepoSubjects.worktree, { path: '/repo', event: 'added' });
    await vi.waitFor(() => expect(capturedStarts).toHaveLength(1));
    expect(capturedStarts[0].workflowId).toBe(workflow.id);
  });

  it('continues evaluating subsequent triggers when filterExpression eval throws', async () => {
    const workflowA = createWorkflowDefinition({
      id: 'wf-eval-throws',
      triggers: [
        {
          type: 'bus-event',
          subject: 'testBuild.completed',
          filterExpression: "payload.missing['x']",
        },
      ],
    });
    const workflowB = createWorkflowDefinition({
      id: 'wf-valid-after-throw',
      triggers: [
        {
          type: 'bus-event',
          subject: 'testBuild.completed',
          filterExpression: 'payload.count > 1',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: workflowA });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: workflowB });
    evaluator.destroy();
    await evaluator.init();

    await MakaioBus.emit(TestBuildSubjects.completed, { branch: 'main', count: 2, status: 'success' });
    await vi.waitFor(() => expect(capturedStarts.some((entry) => entry.workflowId === workflowB.id)).toBe(true));
  });

  it('rolls back subscriptions when init fails during loadExistingTriggers', async () => {
    evaluator.destroy();
    MakaioBus.__resetHandlers?.();

    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.start, (ctx) => {
        capturedStarts.push({ workflowId: ctx.payload.workflowId, triggerPayload: ctx.payload.triggerPayload });
        ctx.setResult({ executionId: 'exec-failure-test' });
      }),
      MakaioBus.on(WorkflowStorageSubjects.list, () => {
        throw new Error('load failed');
      }),
    );

    const failingEvaluator = new BusEventTriggerEvaluator(MakaioBus);
    await expect(failingEvaluator.init()).rejects.toThrow('load failed');

    const testState = failingEvaluator.getTestState();
    expect(testState.initialized).toBe(false);
    expect(testState.cleanupFns).toHaveLength(0);
    expect(testState.subscribedNamespaces.size).toBe(0);
  });
});
