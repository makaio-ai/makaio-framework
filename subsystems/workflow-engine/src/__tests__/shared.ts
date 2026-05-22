import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import type { StepState } from '@makaio/contracts';
import type { WorkflowDefinitionInput, WorkflowExecution } from '../storage/namespace.js';
import { registerDrizzleWorkflowStorage } from '../storage/handler.js';

const CREATE_WORKFLOW_DEFINITIONS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS workflow_definitions (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    name TEXT NOT NULL,
    description TEXT,
    inputs TEXT,
    steps TEXT NOT NULL,
    default_execution_target_id TEXT,
    triggers TEXT,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    canvas_layout TEXT
  )
`;

const CREATE_WORKFLOW_EXECUTIONS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS workflow_executions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    coordinator_session_id TEXT,
    status TEXT NOT NULL,
    inputs TEXT NOT NULL,
    steps TEXT NOT NULL,
    current_step_id TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    trigger_payload TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflow_definitions(id) ON DELETE CASCADE
  )
`;

const CREATE_WORKFLOW_INDICES_SQL = [
  sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_workflow_definitions_name_scope ON workflow_definitions(name, scope)`,
  sql`CREATE INDEX IF NOT EXISTS idx_workflow_definitions_project_id ON workflow_definitions(project_id)`,
  sql`CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow_id ON workflow_executions(workflow_id)`,
  sql`CREATE INDEX IF NOT EXISTS idx_workflow_executions_status ON workflow_executions(status)`,
];

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

  await db.run(CREATE_WORKFLOW_DEFINITIONS_TABLE_SQL);
  await db.run(CREATE_WORKFLOW_EXECUTIONS_TABLE_SQL);
  for (const statement of CREATE_WORKFLOW_INDICES_SQL) {
    await db.run(statement);
  }

  const handlerCleanup = registerDrizzleWorkflowStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));
  const cleanup = createDbCleanup(handlerCleanup, close, dbPath);

  return { db, close, dbPath, cleanup };
}
