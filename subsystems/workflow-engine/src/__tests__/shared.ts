import { fileURLToPath } from 'node:url';
import { MakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { readMigrations } from '@makaio/storage-migrations';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';
import type { StepState } from '@makaio/contracts';
import type { WorkflowDefinitionInput, WorkflowExecution } from '../storage/namespace.js';
import { registerDrizzleWorkflowStorage } from '../storage/handler.js';

const WORKFLOW_MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));
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
    projectId: null,
    name: overrides.name ?? `test-workflow-${id}`,
    description: 'Test workflow',
    inputs: [],
    steps: [
      { id: 'plan', type: 'agent' as const, prompt: 'Plan the work' },
      { id: 'implement', type: 'agent' as const, prompt: 'Implement the work', needs: ['plan'] },
      { id: 'review', type: 'agent' as const, prompt: 'Review the work', needs: ['implement'] },
    ],
    scope: 'default',
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
    plan: { status: 'pending' },
    implement: { status: 'pending' },
    review: { status: 'pending' },
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
    ...overrides,
  };
}

export type { TestDbContextWithCleanup as TestDbContext };

/**
 * Creates an isolated test database with workflow storage handlers registered.
 * @returns Test database context with cleanup function
 */
export async function createTestDb(): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath } = await createTempDb('workflow');

  await applyMigrations(db, readMigrations(WORKFLOW_MIGRATIONS_DIR), TEST_MIGRATIONS_TABLE);

  const handlerCleanup = registerDrizzleWorkflowStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));
  const cleanup = createDbCleanup(handlerCleanup, close, dbPath);

  return { db, close, dbPath, cleanup };
}
