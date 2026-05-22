import { sqliteTable, text, integer, uniqueIndex, index, primaryKey, real } from 'drizzle-orm/sqlite-core';
import type {
  WorkflowInput,
  WorkflowStep,
  WorkflowTrigger,
  StepState,
  ExecutionLinkType,
  SpanStatus,
  WorkflowStepType,
} from '@makaio/contracts';

/**
 * Workflow definitions table.
 * Stores workflow templates with their steps and input parameters.
 */
export const workflowDefinitions = sqliteTable(
  'workflow_definitions',
  {
    /** Unique workflow identifier. */
    id: text('id').primaryKey(),
    /** Project this workflow belongs to (null = global template). */
    projectId: text('project_id'),
    /** Workflow name. */
    name: text('name').notNull(),
    /** Human-readable description. */
    description: text('description'),
    /** Input parameter definitions (JSON array). */
    inputs: text('inputs', { mode: 'json' }).$type<WorkflowInput[]>(),
    /** Workflow steps DAG (JSON array). */
    steps: text('steps', { mode: 'json' }).$type<WorkflowStep[]>().notNull(),
    /** Default execution target for all steps. Overridden per-step via steps JSON blob. */
    defaultExecutionTargetId: text('default_execution_target_id'),
    /** Trigger configuration (JSON array). Null means manual-only default. */
    triggers: text('triggers', { mode: 'json' }).$type<WorkflowTrigger[]>(),
    /** Scope identifier ('default' or projectId). */
    scope: text('scope').notNull(),
    /** Creation timestamp. */
    createdAt: integer('created_at').notNull(),
    /** Last update timestamp. */
    updatedAt: integer('updated_at').notNull(),
    /** Canvas layout hints for the visual editor (JSON object). */
    canvasLayout: text('canvas_layout', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (table) => [
    // (name, scope) is sufficient because scope already encodes project
    // identity: scope === projectId for project-scoped rows, 'default'
    // for global templates. Adding projectId would be redundant and would
    // break global-row uniqueness (SQL NULL != NULL in unique indexes).
    uniqueIndex('uniq_workflow_definitions_name_scope').on(table.name, table.scope),
    // Index on projectId for efficient filtering
    index('idx_workflow_definitions_project_id').on(table.projectId),
  ],
);

/**
 * Workflow executions table.
 * Stores runtime state of workflow executions.
 */
export const workflowExecutions = sqliteTable(
  'workflow_executions',
  {
    /** Unique execution identifier. */
    id: text('id').primaryKey(),
    /** Workflow definition being executed (foreign key). */
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: 'cascade' }),
    /** Coordinator session ID for this execution. */
    coordinatorSessionId: text('coordinator_session_id'),
    /** Current execution status. */
    status: text('status', {
      enum: ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'],
    }).notNull(),
    /** Bound input values (JSON object). */
    inputs: text('inputs', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** Step execution states keyed by step ID (JSON object). */
    steps: text('steps', { mode: 'json' }).$type<Record<string, StepState>>().notNull(),
    /** Currently executing step ID. */
    currentStepId: text('current_step_id'),
    /** Error message if execution failed. */
    error: text('error'),
    /** Execution start timestamp. */
    startedAt: integer('started_at').notNull(),
    /** Execution completion timestamp. */
    completedAt: integer('completed_at'),
    /** Trigger payload from the firing trigger (JSON object). */
    triggerPayload: text('trigger_payload', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (table) => [
    // Index on workflowId for efficient filtering
    index('idx_workflow_executions_workflow_id').on(table.workflowId),
    // Index on status for efficient filtering
    index('idx_workflow_executions_status').on(table.status),
  ],
);

export type InsertWorkflowDefinition = typeof workflowDefinitions.$inferInsert;
export type SelectWorkflowDefinition = typeof workflowDefinitions.$inferSelect;
export type InsertWorkflowExecution = typeof workflowExecutions.$inferInsert;
export type SelectWorkflowExecution = typeof workflowExecutions.$inferSelect;

/**
 * Workflow step spans table.
 * Stores OTel-inspired telemetry for each step execution.
 */
export const workflowStepSpans = sqliteTable(
  'workflow_step_spans',
  {
    /** Workflow execution this span belongs to. */
    executionId: text('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** Step identifier within the workflow definition. */
    stepId: text('step_id').notNull(),
    /** Step type discriminant. */
    stepType: text('step_type').$type<WorkflowStepType>().notNull(),
    /** Current span status. */
    status: text('status').$type<SpanStatus>().notNull(),
    /** Step start timestamp (epoch ms). */
    startedAt: integer('started_at'),
    /** Step completion timestamp (epoch ms). */
    completedAt: integer('completed_at'),
    /** Wall-clock duration in milliseconds. */
    durationMs: integer('duration_ms'),
    /** Input tokens consumed (agent steps). */
    inputTokens: integer('input_tokens'),
    /** Output tokens produced (agent steps). */
    outputTokens: integer('output_tokens'),
    /** Estimated cost in USD (agent steps). */
    estimatedCost: real('estimated_cost'),
    /** Number of tool calls (agent steps). */
    toolCallCount: integer('tool_call_count'),
    /** Serialized step input (JSON string). */
    input: text('input'),
    /** Serialized step output (JSON string). */
    output: text('output'),
  },
  (table) => [
    primaryKey({ columns: [table.executionId, table.stepId] }),
    index('idx_workflow_step_spans_execution_id').on(table.executionId),
    index('idx_workflow_step_spans_status').on(table.status),
  ],
);

/**
 * Workflow execution links table.
 * Stores cross-execution references for pipeline tracing.
 */
export const workflowExecutionLinks = sqliteTable(
  'workflow_execution_links',
  {
    /** Execution that caused the link. */
    sourceExecutionId: text('source_execution_id').notNull(),
    /** Execution that was created as a result. */
    targetExecutionId: text('target_execution_id').notNull(),
    /** Relationship type. */
    linkType: text('link_type').$type<ExecutionLinkType>().notNull(),
    /** Optional metadata (e.g., reason, target station). */
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceExecutionId, table.targetExecutionId] }),
    index('idx_workflow_execution_links_source').on(table.sourceExecutionId),
    index('idx_workflow_execution_links_target').on(table.targetExecutionId),
  ],
);

export type InsertWorkflowStepSpan = typeof workflowStepSpans.$inferInsert;
export type SelectWorkflowStepSpan = typeof workflowStepSpans.$inferSelect;
export type InsertWorkflowExecutionLink = typeof workflowExecutionLinks.$inferInsert;
export type SelectWorkflowExecutionLink = typeof workflowExecutionLinks.$inferSelect;
