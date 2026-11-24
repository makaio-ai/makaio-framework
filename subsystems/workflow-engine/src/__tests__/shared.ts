import { MakaioBus, type IHostMakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { readMigrations } from '@makaio/storage-migrations';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';
import { WorkflowFrameStateSchema, type CodeStepHandler } from '@makaio/contracts';
import type {
  WorkflowDefinition,
  WorkflowFrameState,
  WorkflowSequenceNode,
  WorkflowAgentStepNode,
  WorkflowAutomationTriggerBinding,
} from '@makaio/contracts';
import {
  WorkflowStorageNamespace,
  WorkflowStorageSubjects,
  type WorkflowExecution as StorageWorkflowExecution,
} from '../storage/namespace.js';
import { registerDrizzleWorkflowStorage } from '../storage/handler.js';
import { RuntimeContext } from '../runtime/runtime-context.js';
import { createCallerLocalStepRunner } from '../runtime/caller-local-step-runner.js';
import { createTestCall } from '@makaio/test-utils';

const TEST_MIGRATIONS_TABLE = '__drizzle_migrations_test_workflow_engine_storage';

/**
 * Register frame storage for tests that run the runtime without a database.
 * @param bus - The actual bus used by the workflow runtime.
 * @param options - Optional one-time failure injection for the first frame write.
 * @returns A function that removes the frame handlers.
 */
export function registerInMemoryFrameStore(
  bus: IHostMakaioBus,
  options: { readonly failFirstWrite?: boolean } = {},
): () => void {
  bus.registerNamespace(WorkflowStorageNamespace);
  const frames = new Map<string, { executionId: string; frame: WorkflowFrameState }>();
  let failWrite = options.failFirstWrite === true;
  const unsubscribeSet = bus.on(WorkflowStorageSubjects.setFrame, (ctx) => {
    if (failWrite) {
      failWrite = false;
      throw new Error('First frame write failed');
    }
    const { executionId, frame } = ctx.payload;
    frames.set(frame.frameId, { executionId, frame: WorkflowFrameStateSchema.parse(frame) });
    ctx.setResult({ frameId: frame.frameId });
  });
  const unsubscribeList = bus.on(WorkflowStorageSubjects.listFrames, (ctx) => {
    ctx.setResult({
      frames: [...frames.values()]
        .filter(({ executionId }) => executionId === ctx.payload.executionId)
        .map(({ frame }) => structuredClone(frame)),
    });
  });
  return () => {
    unsubscribeList();
    unsubscribeSet();
  };
}

/**
 * Options accepted by {@link createWorkflowDefinition}.
 *
 * Accepts the new primitive-runtime tree format via `root`, or a legacy flat
 * `steps` array that is converted to a sequence node for backward compatibility
 * with tests that pre-date the primitive runtime migration.
 */
export interface WorkflowDefinitionOptions {
  /** Workflow identifier (generated when omitted). */
  id?: string;
  /** Human-readable name (generated from id when omitted). */
  name?: string;
  /** Optional scope (defaults to global). */
  scope?: WorkflowDefinition['scope'];
  /**
   * Root sequence node for the new primitive-runtime format.
   * When provided, `steps` is ignored.
   */
  root?: WorkflowSequenceNode;
  /**
   * Legacy flat steps array for backward-compatibility.
   * Converted to a `sequence` root node at construction time.
   * Each step's `type` is mapped to the nearest primitive node type.
   */
  steps?: Array<{
    id: string;
    type: string;
    prompt?: string;
    command?: string[];
    collection?: string;
    needs?: string[];
    steps?: Array<{ id: string; type: string; prompt?: string; command?: string[]; adapter?: string }>;
    if?: string;
    adapter?: string;
    harnessId?: string;
    contextMode?: string;
    role?: string;
    model?: string;
    onComplete?: { extract: 'none' };
    runtime?: boolean;
  }>;
  /** Workflow input parameter definitions (legacy field). */
  inputs?: Array<{ name: string; type: string; required?: boolean; default?: unknown }>;
  /** Optional description. */
  description?: string;
  /** Optional declarative automation trigger bindings for this definition. */
  triggers?: WorkflowAutomationTriggerBinding[];
}

/**
 * Create a workflow definition with defaults compatible with the primitive runtime.
 *
 * Accepts either:
 * - `root`: a ready-made `WorkflowSequenceNode` tree, or
 * - `steps`: a legacy flat steps array (converted to a sequence node).
 *
 * When neither is provided, a default three-agent-step sequence is used.
 *
 * Note: Default name includes the generated ID to satisfy (name, scope) unique
 * constraint in the database.
 * @param options - Optional field overrides
 * @returns Workflow definition compatible with `WorkflowStorageSubjects.set`
 */
export function createWorkflowDefinition(options: WorkflowDefinitionOptions = {}): WorkflowDefinition {
  const id = options.id ?? `workflow-${Math.random().toString(36).slice(2)}`;
  const scope = options.scope ?? { type: 'global' as const };

  let root: WorkflowSequenceNode;
  if (options.root !== undefined) {
    root = options.root;
  } else if (options.steps !== undefined) {
    root = {
      type: 'sequence',
      id: `${id}__root`,
      nodes: options.steps.map((step) => {
        // agent, shell, function, bus-request and other DAG types all
        // map to 'agent-step' in the primitive runtime.  Tests that exercise
        // pure DAG-scheduler paths (workflow-scheduler.*) access the
        // underlying step objects directly through stepMap and do not run
        // these nodes through the primitive runtime.
        return {
          type: 'agent-step' as const,
          id: step.id,
          role: step.role ?? step.id,
          prompt: step.prompt ?? `${step.type} step`,
        };
      }),
    };
  } else {
    root = {
      type: 'sequence',
      id: `${id}__root`,
      nodes: [
        { type: 'agent-step' as const, id: 'plan', role: 'plan', prompt: 'Plan the work' } as WorkflowAgentStepNode,
        {
          type: 'agent-step' as const,
          id: 'implement',
          role: 'implement',
          prompt: 'Implement the work',
        } as WorkflowAgentStepNode,
        {
          type: 'agent-step' as const,
          id: 'review',
          role: 'review',
          prompt: 'Review the work',
        } as WorkflowAgentStepNode,
      ],
    };
  }

  return {
    id,
    name: options.name ?? `test-workflow-${id}`,
    description: options.description ?? 'Test workflow',
    root,
    scope,
    ...(options.triggers !== undefined && { triggers: options.triggers }),
  };
}

/**
 * Create a workflow execution record with defaults.
 *
 * The returned record matches the current {@link WorkflowExecution} contract,
 * which no longer includes a `steps` map (step-level state is tracked via
 * frames in the primitive runtime).
 * @param overrides - Optional field overrides
 * @returns Workflow execution record for tests
 */
export function createWorkflowExecution(overrides: Partial<StorageWorkflowExecution> = {}): StorageWorkflowExecution {
  return {
    id: `execution-${Math.random().toString(36).slice(2)}`,
    workflowId: 'workflow-test',
    coordinatorSessionId: undefined,
    status: 'running',
    inputs: {},
    startedAt: Date.now(),
    completedAt: undefined,
    error: undefined,
    scope: { type: 'global' },
    ...overrides,
  };
}

/**
 * Narrow a frame state to one with a completed status for test assertions.
 *
 * Used as a replacement for the removed DAG-era `asExecutable` helper.
 * Surfaces the `output` field from completed frames without requiring
 * per-assertion `if (frame.status === 'completed')` guards.
 * @param frame - Frame state to narrow (may be undefined for missing frames)
 * @returns Frame state or `undefined` when the frame is absent or not completed
 */
export function asCompletedFrame(
  frame: WorkflowFrameState | undefined,
): (WorkflowFrameState & { status: 'completed' }) | undefined {
  if (!frame || frame.status !== 'completed') return undefined;
  return frame as WorkflowFrameState & { status: 'completed' };
}

export type { TestDbContextWithCleanup as TestDbContext };

/**
 * Creates an isolated test database with workflow storage handlers registered.
 * Uses the central framework migrations so the schema matches the runtime DB.
 * @param bus - Bus instance to register workflow storage handlers on.
 * @returns Test database context with cleanup function
 */
export async function createTestDbForBus(bus: IMakaioBus): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath, exec } = await createTempDb('workflow');

  await applyMigrations(db, readMigrations(), TEST_MIGRATIONS_TABLE);

  const handlerCleanup = registerDrizzleWorkflowStorage(bus, db);
  const cleanup = createDbCleanup(handlerCleanup, close, dbPath);

  return { db, close, dbPath, exec, cleanup };
}

/**
 * Creates an isolated test database with workflow storage handlers registered
 * on the global test bus.
 * @returns Test database context with cleanup function
 */
export async function createTestDb(): Promise<TestDbContextWithCleanup> {
  return createTestDbForBus(MakaioBus);
}

type RuntimeParams = ConstructorParameters<typeof RuntimeContext>;

/**
 * Use the actual caller-local step runner in tests written against local authoring handlers.
 * @param args - Runtime context arguments with the explicitly loaded caller-local handlers.
 * @returns Runtime context sharing its runner with derived branch contexts.
 */
export function createLocalTestRuntimeContext(
  ...args: [
    RuntimeParams[0],
    RuntimeParams[1],
    RuntimeParams[2],
    RuntimeParams[3],
    ReadonlyMap<string, CodeStepHandler>,
    RuntimeParams[5],
    RuntimeParams[6],
    RuntimeParams[7]?,
    RuntimeParams[8]?,
    RuntimeParams[9]?,
  ]
): RuntimeContext {
  const [executionId, workflowId, definition, execution, handlers, ...rest] = args;
  const runner = createCallerLocalStepRunner(createTestCall(), handlers);
  return new RuntimeContext(executionId, workflowId, definition, execution, runner, ...rest);
}
