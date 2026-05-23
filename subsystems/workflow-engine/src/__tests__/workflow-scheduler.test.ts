import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { rebuildSchedulerGraph } from '../workflow-scheduler.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

/**
 * WorkflowScheduler integration tests.
 *
 * These tests exercise the mutable DAG scheduler through the full executor
 * stack. Each test starts a real execution and waits for it to settle, then
 * asserts on the final execution state and event order.
 *
 * The subagent stub in the test setup completes each agent step synchronously
 * on the next tick with `result = 'completed:<prompt>'`, which lets us predict
 * result values and ordering for all assertions.
 */
describe('WorkflowScheduler', () => {
  let setup: WorkflowExecutorTestSetup;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    await teardownWorkflowExecutorTest(setup);
  });

  it('rejects duplicate authored step IDs before execution state is created', async () => {
    const workflow = createWorkflowDefinition({
      id: 'scheduler-duplicate-step-ids',
      steps: [
        { id: 'same', type: 'agent' as const, prompt: 'A', adapter: 'claude-code' },
        { id: 'same', type: 'agent' as const, prompt: 'B', adapter: 'claude-code' },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    await expect(MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id })).rejects.toThrow(
      "Duplicate step ID: 'same'",
    );
  });

  it('rejects dependency cycles with an explicit cycle error', async () => {
    const workflow = createWorkflowDefinition({
      id: 'scheduler-cycle',
      steps: [
        { id: 'a', type: 'agent' as const, prompt: 'A', needs: ['b'], adapter: 'claude-code' },
        { id: 'b', type: 'agent' as const, prompt: 'B', needs: ['a'], adapter: 'claude-code' },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    await expect(MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id })).rejects.toThrow(
      'Cycle detected in workflow step dependencies',
    );
  });

  it('rejects authored dotted step IDs that collide with runtime fanout namespaces', async () => {
    const workflow = createWorkflowDefinition({
      id: 'scheduler-dotted-step-id',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          steps: [{ id: 'work', type: 'agent' as const, prompt: 'Work', adapter: 'claude-code' }],
        },
        { id: 'process.0.work', type: 'agent' as const, prompt: 'Collision', adapter: 'claude-code' },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    await expect(
      MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id, inputs: { items: ['a'] } }),
    ).rejects.toThrow("Step ID 'process.0.work' cannot contain '.'");
  });

  // ─────────────────────────────────────────────────────────────
  // Static fanout (inputs.packages known at start)
  // ─────────────────────────────────────────────────────────────

  it('keeps static fanout as the same runtime expansion path', async () => {
    // process.collection reads inputs.packages and has no upstream needs.
    // The collection is fully resolvable from inputs at the first tick.
    const workflow = createWorkflowDefinition({
      id: 'scheduler-static-fanout',
      inputs: [{ name: 'packages', type: 'string', required: true }],
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.packages',
          steps: [{ id: 'test', type: 'agent' as const, prompt: 'Test {{ item }}', adapter: 'claude-code' }],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { packages: ['pkg-a', 'pkg-b'] },
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('completed');
    expect(execution?.steps['process.0.test']?.status).toBe('completed');
    expect(execution?.steps['process.1.test']?.status).toBe('completed');
  });

  // ─────────────────────────────────────────────────────────────
  // Dynamic fanout from upstream step result
  // ─────────────────────────────────────────────────────────────

  it('expands collection from upstream step result after needs complete', async () => {
    // discover outputs a JSON array string ["pkg-x","pkg-y"] via a shell step.
    // process.collection uses the `|parseJson` jexl transform to convert the
    // string to an actual array before iteration.
    const workflow = createWorkflowDefinition({
      id: 'scheduler-dynamic-fanout',
      steps: [
        {
          id: 'discover',
          type: 'shell' as const,
          command: ['node', '-e', 'process.stdout.write(JSON.stringify(["pkg-x","pkg-y"]))'],
        },
        {
          id: 'process',
          type: 'for-each' as const,
          // steps.discover.result is a JSON string; parseJson parses it to an array
          collection: 'steps.discover.result|parseJson',
          needs: ['discover'],
          steps: [{ id: 'test', type: 'shell' as const, command: ['node', '-e', `process.stdout.write('ok')`] }],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {},
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 15_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('completed');
    // Two items from discover result → two generated child steps
    expect(execution?.steps['process.0.test']?.status).toBe('completed');
    expect(execution?.steps['process.1.test']?.status).toBe('completed');
  });

  // ─────────────────────────────────────────────────────────────
  // for-each `if` evaluated against upstream steps context
  // ─────────────────────────────────────────────────────────────

  it('evaluates for-each if expressions against upstream steps context', async () => {
    // discover completes and sets shouldProcess via a shell command.
    // process.if reads steps.discover.result. We emit 'false', so the condition
    // evaluates false and the for-each skips even though inputs.items is non-empty.
    const workflow = createWorkflowDefinition({
      id: 'scheduler-foreach-if',
      steps: [
        {
          id: 'discover',
          type: 'shell' as const,
          command: ['node', '-e', "process.stdout.write('false')"],
        },
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          if: "steps.discover.result == 'true'",
          needs: ['discover'],
          steps: [{ id: 'work', type: 'agent' as const, prompt: 'Work', adapter: 'claude-code' }],
        },
        {
          id: 'aggregate',
          type: 'agent' as const,
          prompt: 'Aggregate',
          needs: ['discover'],
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { items: ['would-run-if-condition-were-true'] },
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 15_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps['process']?.status).toBe('skipped');
    expect(execution?.steps['process.0.work']).toBeUndefined();
    expect(execution?.steps['aggregate']?.status).toBe('completed');
  });

  // ─────────────────────────────────────────────────────────────
  // Skips empty for-each and unblocks downstream aggregate
  // ─────────────────────────────────────────────────────────────

  it('skips empty for-each and unblocks downstream aggregate', async () => {
    const workflow = createWorkflowDefinition({
      id: 'scheduler-empty-foreach',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          steps: [{ id: 'work', type: 'agent' as const, prompt: 'Work on {{ item }}', adapter: 'claude-code' }],
        },
        {
          id: 'aggregate',
          type: 'agent' as const,
          prompt: 'Aggregate results',
          needs: ['process'],
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { items: [] }, // empty collection → skip
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps['process']?.status).toBe('skipped');
    expect(execution?.steps['aggregate']?.status).toBe('completed');
  });

  // ─────────────────────────────────────────────────────────────
  // Downstream waits for all generated leaves
  // ─────────────────────────────────────────────────────────────

  it('rewires downstream dependencies from for-each id to generated leaves', async () => {
    // aggregate.needs is authored as ['process'].
    // Runtime scheduler must wait for every generated process.* leaf before aggregate runs.
    const completedOrder: string[] = [];

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.completed, (ctx) => {
        completedOrder.push(ctx.payload.stepId);
      }),
    );

    const workflow = createWorkflowDefinition({
      id: 'scheduler-leaf-rewire',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          steps: [{ id: 'test', type: 'agent' as const, prompt: 'Test {{ item }}', adapter: 'claude-code' }],
        },
        {
          id: 'aggregate',
          type: 'agent' as const,
          prompt: 'Aggregate',
          needs: ['process'],
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { items: ['a', 'b'] },
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    // aggregate must come after all process.*.test leaves
    expect(completedOrder.indexOf('aggregate')).toBeGreaterThan(completedOrder.indexOf('process.0.test'));
    expect(completedOrder.indexOf('aggregate')).toBeGreaterThan(completedOrder.indexOf('process.1.test'));
  });

  // ─────────────────────────────────────────────────────────────
  // Nested for-each item/index context
  // ─────────────────────────────────────────────────────────────

  it('resolves nested for-each item and index context deterministically', async () => {
    // The inner collection uses the current outer item and outer index to select
    // different child arrays. The leaf prompt then uses the inner item/index.
    const workflow = createWorkflowDefinition({
      id: 'scheduler-nested-foreach',
      steps: [
        {
          id: 'outer',
          type: 'for-each' as const,
          collection: 'inputs.outerItems',
          steps: [
            {
              id: 'inner',
              type: 'for-each' as const,
              collection: 'item.childrenByOuterIndex[index]',
              steps: [
                {
                  id: 'test',
                  type: 'agent' as const,
                  prompt: 'Test child={{ item }},inner={{ index }}',
                  adapter: 'claude-code',
                },
              ],
            },
          ],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: {
        outerItems: [
          { childrenByOuterIndex: [['outer-0-child'], ['wrong-index']] },
          { childrenByOuterIndex: [['wrong-index'], ['outer-1-child-a', 'outer-1-child-b']] },
        ],
      },
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('completed');
    expect(execution?.steps['outer.0.inner.0.test']?.status).toBe('completed');
    expect(execution?.steps['outer.1.inner.0.test']?.status).toBe('completed');
    const nestedState = execution?.steps['outer.1.inner.1.test'];
    expect(nestedState?.status).toBe('completed');
    if (nestedState?.kind === 'executable') {
      expect(nestedState.result).toContain('child=outer-1-child-b');
      expect(nestedState.result).toContain('inner=1');
    }
  });

  it('expands nested for-each collections after sibling needs complete', async () => {
    const workflow = createWorkflowDefinition({
      id: 'scheduler-nested-dynamic-foreach',
      steps: [
        {
          id: 'outer',
          type: 'for-each' as const,
          collection: 'inputs.outerItems',
          steps: [
            {
              id: 'discover',
              type: 'shell' as const,
              command: ['node', '-e', 'process.stdout.write(JSON.stringify(["inner-a","inner-b"]))'],
            },
            {
              id: 'inner',
              type: 'for-each' as const,
              collection: 'steps.discover.result|parseJson',
              needs: ['discover'],
              steps: [
                {
                  id: 'work',
                  type: 'agent' as const,
                  prompt: 'Inner {{ item }}',
                  adapter: 'claude-code',
                },
              ],
            },
          ],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { outerItems: ['outer-a'] },
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 15_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('completed');
    expect(execution?.steps['outer']?.status).toBe('completed');
    expect(execution?.steps['outer.0.inner']?.status).toBe('completed');
    expect(execution?.steps['outer.0.inner.0.work']?.status).toBe('completed');
    expect(execution?.steps['outer.0.inner.1.work']?.status).toBe('completed');
  });

  it('resolves same-iteration step aliases in executable templates', async () => {
    const workflow = createWorkflowDefinition({
      id: 'scheduler-local-step-alias-template',
      steps: [
        {
          id: 'outer',
          type: 'for-each' as const,
          collection: 'inputs.items',
          steps: [
            {
              id: 'discover',
              type: 'shell' as const,
              command: ['node', '-e', "process.stdout.write('local-context')"],
            },
            {
              id: 'work',
              type: 'agent' as const,
              prompt: 'Use {{ steps.discover.result }} for {{ item }}',
              needs: ['discover'],
              adapter: 'claude-code',
            },
          ],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { items: ['item-a'] },
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]), { timeout: 15_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    const workState = execution?.steps['outer.0.work'];
    expect(workState?.status).toBe('completed');
    if (workState?.kind === 'executable') {
      expect(workState.result).toContain('Use local-context for item-a');
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Non-array collection fails the execution
  // ─────────────────────────────────────────────────────────────

  it('fails execution when dynamic collection is not an array', async () => {
    const failedExecutions: Array<{ executionId: string; failedStepId?: string }> = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push({ executionId: ctx.payload.executionId, failedStepId: ctx.payload.failedStepId });
      }),
    );

    const workflow = createWorkflowDefinition({
      id: 'scheduler-non-array-collection',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          // inputs.notAnArray is a string, not an array
          collection: 'inputs.notAnArray',
          steps: [{ id: 'work', type: 'agent' as const, prompt: 'Work', adapter: 'claude-code' }],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { notAnArray: 'oops-not-an-array' },
    });

    await vi.waitFor(() => expect(failedExecutions).toHaveLength(1));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('failed');
    expect(execution?.steps['process']?.status).toBe('failed');
  });

  it('persists a for-each if evaluation error as a composite failure', async () => {
    const failedExecutions: Array<{ executionId: string; failedStepId?: string }> = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push({ executionId: ctx.payload.executionId, failedStepId: ctx.payload.failedStepId });
      }),
    );

    const workflow = createWorkflowDefinition({
      id: 'scheduler-foreach-if-error',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          if: 'item.',
          steps: [{ id: 'work', type: 'agent' as const, prompt: 'Work', adapter: 'claude-code' }],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { items: ['a'] },
    });

    await vi.waitFor(() => expect(failedExecutions).toEqual([{ executionId, failedStepId: 'process' }]));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('failed');
    expect(execution?.steps.process?.status).toBe('failed');
    if (execution?.steps.process?.kind === 'composite') {
      expect(execution.steps.process.error).toEqual(expect.any(String));
    }
  });

  it('marks expanded composite ancestors failed when a generated child fails', async () => {
    const failedExecutions: Array<{ executionId: string; failedStepId?: string }> = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        failedExecutions.push({ executionId: ctx.payload.executionId, failedStepId: ctx.payload.failedStepId });
      }),
    );

    const workflow = createWorkflowDefinition({
      id: 'scheduler-composite-fails-with-child',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          steps: [
            {
              id: 'work',
              type: 'shell' as const,
              command: ['node', '-e', "process.stderr.write('boom'); process.exit(1)"],
            },
          ],
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { items: ['a'] },
    });

    await vi.waitFor(() => expect(failedExecutions).toHaveLength(1), { timeout: 15_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('failed');
    expect(execution?.steps['process']?.status).toBe('failed');
    expect(execution?.steps['process.0.work']?.status).toBe('failed');
  });

  // ─────────────────────────────────────────────────────────────
  // for-each `if: false` skips composite and downstream still runs
  // ─────────────────────────────────────────────────────────────

  it('skips for-each when if evaluates to false and unblocks downstream', async () => {
    const workflow = createWorkflowDefinition({
      id: 'scheduler-foreach-if-false',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          if: 'false',
          steps: [{ id: 'work', type: 'agent' as const, prompt: 'Work', adapter: 'claude-code' }],
        },
        {
          id: 'aggregate',
          type: 'agent' as const,
          prompt: 'Always run',
          needs: ['process'],
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { items: ['a', 'b', 'c'] }, // would produce 3 iterations, but if=false skips all
    });

    await vi.waitFor(() => expect(completedExecutions).toEqual([executionId]));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps['process']?.status).toBe('skipped');
    expect(execution?.steps['aggregate']?.status).toBe('completed');
    // No child steps were created
    expect(execution?.steps['process.0.work']).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────
  // Cancellation: all non-terminal steps must be terminated
  // ─────────────────────────────────────────────────────────────

  it('terminalizes pending composite and generated pending children when execution is cancelled', async () => {
    // Start an execution with a for-each that expands to multiple children,
    // then cancel it. Every step must reach a terminal state.
    const workflow = createWorkflowDefinition({
      id: 'scheduler-cancel-terminalize',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          steps: [{ id: 'work', type: 'agent' as const, prompt: 'Work on {{ item }}', adapter: 'claude-code' }],
        },
        {
          id: 'aggregate',
          type: 'agent' as const,
          prompt: 'Aggregate',
          needs: ['process'],
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const startedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.started, (ctx) => {
        startedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { items: ['a', 'b', 'c'] },
    });

    // Wait until the execution has started so it is registered as active.
    await vi.waitFor(() => expect(startedExecutions).toContain(executionId));

    const { cancelled } = await MakaioBus.request(WorkflowSubjects.cancel, {
      executionId,
      reason: 'test cancellation',
    });

    expect(cancelled).toBe(true);

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('cancelled');

    // No step may remain in a non-terminal state after cancellation.
    const nonTerminalSteps = Object.values(execution?.steps ?? {}).filter(
      (step) =>
        step.status === 'pending' ||
        step.status === 'running' ||
        step.status === 'waiting' ||
        step.status === 'expanding',
    );
    expect(nonTerminalSteps).toHaveLength(0);
  });

  it('terminalizes a composite expansion when cancellation races generated child execution', async () => {
    const workflow = createWorkflowDefinition({
      id: 'scheduler-cancel-during-expanded-child',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          steps: [
            {
              id: 'work',
              type: 'shell' as const,
              command: ['node', '-e', "setTimeout(() => process.stdout.write('done'), 2000)"],
            },
          ],
        },
        {
          id: 'aggregate',
          type: 'agent' as const,
          prompt: 'Aggregate',
          needs: ['process'],
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { items: ['a'] },
    });

    await vi.waitFor(
      async () => {
        const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
        expect(execution?.steps['process.0.work']?.status).toBe('running');
      },
      { timeout: 15_000 },
    );

    const { cancelled } = await MakaioBus.request(WorkflowSubjects.cancel, {
      executionId,
      reason: 'cancel during expanded child',
    });

    expect(cancelled).toBe(true);

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('cancelled');
    expect(execution?.steps['process']?.status).toBe('cancelled');
    expect(execution?.steps['aggregate']?.status).toBe('failed');

    const nonTerminalSteps = Object.values(execution?.steps ?? {}).filter(
      (step) =>
        step.status === 'pending' ||
        step.status === 'running' ||
        step.status === 'waiting' ||
        step.status === 'expanding',
    );
    expect(nonTerminalSteps).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────
  // rebuildSchedulerGraph: reconstructs graph from expansion snapshots
  // ─────────────────────────────────────────────────────────────

  it('does not leave partially expanded children untracked when rebuilding from snapshots', async () => {
    // Run a for-each to completion so the expansion snapshot is persisted,
    // then verify that rebuildSchedulerGraph produces a node map matching
    // the persisted execution steps.
    const workflow = createWorkflowDefinition({
      id: 'scheduler-rebuild-graph',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          steps: [{ id: 'work', type: 'agent' as const, prompt: 'Work on {{ item }}', adapter: 'claude-code' }],
        },
        {
          id: 'aggregate',
          type: 'agent' as const,
          prompt: 'Aggregate',
          needs: ['process'],
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { items: ['x', 'y'] },
    });

    await vi.waitFor(() => expect(completedExecutions).toContain(executionId));

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution).not.toBeNull();

    // Retrieve the full workflow definition for the rebuild.
    const { workflow: storedWorkflow } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflow.id });
    expect(storedWorkflow).not.toBeNull();

    const rebuiltGraph = rebuildSchedulerGraph({
      workflow: storedWorkflow!,
      execution: execution!,
    });

    // The rebuilt graph must contain every step from the persisted execution.
    expect(Object.keys(execution!.steps).sort()).toEqual([...rebuiltGraph.nodes.keys()].sort());
    expect(rebuiltGraph.stepContext.get('process.0.work')).toEqual({ item: 'x', index: 0 });
    expect(rebuiltGraph.stepContext.get('process.1.work')).toEqual({ item: 'y', index: 1 });
  });

  it('fails fast when a rebuilt composite expansion references an unknown leaf step', async () => {
    const workflowInput = createWorkflowDefinition({
      id: 'scheduler-rebuild-missing-leaf',
      steps: [
        {
          id: 'process',
          type: 'for-each' as const,
          collection: 'inputs.items',
          steps: [{ id: 'work', type: 'agent' as const, prompt: 'Work', adapter: 'claude-code' }],
        },
        {
          id: 'aggregate',
          type: 'agent' as const,
          prompt: 'Aggregate',
          needs: ['process'],
          adapter: 'claude-code',
        },
      ],
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: workflowInput });
    const { workflow } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflowInput.id });
    expect(workflow).not.toBeNull();

    const execution = createWorkflowExecution({
      id: 'execution-rebuild-missing-leaf',
      workflowId: workflowInput.id,
      steps: {
        process: {
          kind: 'composite',
          status: 'expanding',
          expansion: {
            parentStepId: 'process',
            childSteps: [{ id: 'process.0.work', type: 'agent' as const, prompt: 'Work', adapter: 'claude-code' }],
            stepContext: { 'process.0.work': { item: 'x', index: 0 } },
            leafStepIds: ['process.0.missing'],
          },
        },
        'process.0.work': { kind: 'executable', status: 'completed' },
        aggregate: { kind: 'executable', status: 'pending' },
      },
    });

    expect(() => rebuildSchedulerGraph({ workflow: workflow!, execution })).toThrow(
      "Composite 'process' expansion references unknown leaf step 'process.0.missing'",
    );
  });
});
