import { MakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { readMigrations } from '@makaio/storage-migrations';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';
import type { ExecutableStepState, StepState } from '@makaio/contracts';
import type { WorkflowDefinitionInput, WorkflowExecution } from '../storage/namespace.js';
import { registerDrizzleWorkflowStorage } from '../storage/handler.js';

const TEST_MIGRATIONS_TABLE = '__drizzle_migrations_test_workflow_engine_storage';

/**
 * Create a workflow definition input with defaults.
 * Note: Default name includes the generated ID to satisfy (name, scope) unique constraint.
 * @param overrides - Optional field overrides
 * @returns Workflow definition input for tests
 */
export function createWorkflowDefinition(overrides: Partial<WorkflowDefinitionInput> = {}): WorkflowDefinitionInput {
  const id = overrides.id ?? `workflow-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    name: overrides.name ?? `test-workflow-${id}`,
    description: 'Test workflow',
    inputs: [],
    steps: [
      { id: 'plan', type: 'agent' as const, prompt: 'Plan the work' },
      { id: 'implement', type: 'agent' as const, prompt: 'Implement the work', needs: ['plan'] },
      { id: 'review', type: 'agent' as const, prompt: 'Review the work', needs: ['implement'] },
    ],
    scope: { type: 'global' },
    ...overrides,
  };
}

/**
 * Create a workflow execution record with defaults.
 * @param overrides - Optional field overrides
 * @returns Workflow execution record for tests
 */
export function createWorkflowExecution(overrides: Partial<WorkflowExecution> = {}): WorkflowExecution {
  const steps: Record<string, StepState> = {
    plan: { kind: 'executable', status: 'pending' },
    implement: { kind: 'executable', status: 'pending' },
    review: { kind: 'executable', status: 'pending' },
  };

  return {
    id: `execution-${Math.random().toString(36).slice(2)}`,
    workflowId: 'workflow-test',
    coordinatorSessionId: undefined,
    status: 'running',
    inputs: {},
    steps,
    startedAt: Date.now(),
    completedAt: undefined,
    error: undefined,
    currentStepId: undefined,
    scope: { type: 'global' },
    ...overrides,
  };
}

/**
 * Narrow a step state to {@link ExecutableStepState} for test assertions.
 *
 * All agent, shell, and gate step states are `ExecutableStepState`. This helper
 * surfaces `result`, `subagentId`, and other executable-only fields in test code
 * without requiring per-assertion `if (state.kind === 'executable')` guards.
 * @param state - Step state to narrow (may be undefined for missing steps)
 * @returns `ExecutableStepState` or `undefined` when the state is absent or composite
 */
export function asExecutable(state: StepState | undefined): ExecutableStepState | undefined {
  if (!state || state.kind !== 'executable') return undefined;
  return state;
}

export type { TestDbContextWithCleanup as TestDbContext };

/**
 * Creates an isolated test database with workflow storage handlers registered.
 * Uses the central framework migrations so the schema matches the runtime DB.
 * @returns Test database context with cleanup function
 */
export async function createTestDb(): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath } = await createTempDb('workflow');

  await applyMigrations(db, readMigrations(), TEST_MIGRATIONS_TABLE);

  const handlerCleanup = registerDrizzleWorkflowStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));
  const cleanup = createDbCleanup(handlerCleanup, close, dbPath);

  return { db, close, dbPath, cleanup };
}
