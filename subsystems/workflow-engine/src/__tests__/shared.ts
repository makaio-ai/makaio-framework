import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { readMigrations } from '@makaio/storage-migrations';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';
import type {
  WorkflowDefinition,
  WorkflowFrameState,
  WorkflowSequenceNode,
  WorkflowStationNode,
  WorkflowTrigger,
} from '@makaio/contracts';
import type { WorkflowExecution as StorageWorkflowExecution } from '../storage/namespace.js';
import { registerDrizzleWorkflowStorage } from '../storage/handler.js';

const TEST_MIGRATIONS_TABLE = '__drizzle_migrations_test_workflow_engine_storage';

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
    autoAction?: 'approve' | 'reject';
    timeoutMs?: number | null;
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
  /** Optional trigger configurations for this workflow definition. */
  triggers?: WorkflowTrigger[];
}

/**
 * Create a workflow definition with defaults compatible with the primitive runtime.
 *
 * Accepts either:
 * - `root`: a ready-made `WorkflowSequenceNode` tree, or
 * - `steps`: a legacy flat steps array (converted to a sequence node).
 *
 * When neither is provided, a default three-station sequence is used.
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
        if (step.type === 'gate') {
          return {
            type: 'gate' as const,
            id: step.id,
            prompt: step.prompt ?? 'Gate step',
            autoAction: step.autoAction ?? 'reject',
            timeoutMs: step.timeoutMs ?? 60_000,
          };
        }
        // agent, shell, function, bus-request and other DAG types all
        // map to 'station' in the primitive runtime.  Tests that exercise
        // pure DAG-scheduler paths (workflow-scheduler.*) access the
        // underlying step objects directly through stepMap and do not run
        // these nodes through the primitive runtime.
        return {
          type: 'station' as const,
          id: step.id,
          prompt: step.prompt ?? `${step.type} step`,
        };
      }),
    };
  } else {
    root = {
      type: 'sequence',
      id: `${id}__root`,
      nodes: [
        { type: 'station' as const, id: 'plan', prompt: 'Plan the work' } as WorkflowStationNode,
        { type: 'station' as const, id: 'implement', prompt: 'Implement the work' } as WorkflowStationNode,
        { type: 'station' as const, id: 'review', prompt: 'Review the work' } as WorkflowStationNode,
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
