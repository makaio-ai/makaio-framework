/**
 * These tables hold stored workflow gate data that earlier releases created, and the
 * migration generator drops every table whose declaration it no longer reads.
 * This module is declared in `makaio.drizzleSchema` for the migration generator's exclusive use.
 */
import { index } from 'drizzle-orm/sqlite-core';
import { index as pgIndex } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';
import type { JsonValue } from '@makaio/contracts';
import { workflowExecutionsDual } from './schema.js';

/**
 * Workflow gate instances table.
 *
 * Created when a gate node is entered, updated when the gate is resolved,
 * timed out, or cancelled. Stored independently of frame state so the gate
 * service can query open gates without scanning the full frame tree.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const workflowGateInstancesDual = defineDualTable(
  'workflow_gate_instances',
  (c) => ({
    /** Unique gate instance identifier. */
    id: c.text('id').primaryKey(),
    /** Execution this gate belongs to. */
    executionId: c
      .text('execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Attempt that opened this gate; absent for legacy non-Attempt executions. */
    executionAttemptId: c.text('execution_attempt_id'),
    /** Node ID of the gate in the workflow definition. */
    nodeId: c.text('node_id').notNull(),
    /** Frame ID of the gate's execution frame. */
    frameId: c.text('frame_id').notNull(),
    /**
     * JSON Schema describing the expected resume data payload.
     * Callers must satisfy this schema when responding to the gate.
     */
    schema: c.jsonCol<Record<string, unknown>>('schema').notNull(),
    /**
     * Optional prompt shown to the reviewer after template interpolation.
     * Populated from the gate node's `prompt` field at execution time.
     */
    prompt: c.text('prompt'),
    /** Current gate status. */
    status: c.text('status').notNull().default('waiting'),
    /** Effective timeout action captured when the gate opened. */
    autoAction: c
      .textEnum('auto_action', { enum: ['approve', 'reject'] as const })
      .notNull()
      .default('reject'),
    /** Effective timeout in milliseconds captured when the gate opened. */
    timeoutMs: c.int4('timeout_ms'),
    /** JSON-serializable resume data submitted by the approver. */
    resumeData: c.jsonCol<JsonValue>('resume_data'),
    /** Human-readable rationale supplied by the responder. */
    reason: c.text('reason'),
    /** Whether `resume_data` was explicitly submitted, including JSON null. */
    resumeDataPresent: c.bool('resume_data_present').notNull().default(false),
    /** Epoch milliseconds when the gate was created (node entered). */
    createdAt: c.epochMs('created_at').notNull(),
    /** Epoch milliseconds when the gate left the `waiting` status. */
    resolvedAt: c.epochMs('resolved_at'),
  }),
  {
    sqlite: (t) => [
      // Efficient per-execution gate lookup.
      index('idx_workflow_gate_instances_execution').on(t.executionId),
      // Frame-based gate lookup for iterate-expanded gates.
      index('idx_workflow_gate_instances_frame').on(t.frameId),
    ],
    postgres: (t) => [
      pgIndex('idx_workflow_gate_instances_execution').on(t.executionId),
      pgIndex('idx_workflow_gate_instances_frame').on(t.frameId),
    ],
  },
);

/** SQLite face of the `workflow_gate_instances` table (canonical schema). */
export const workflowGateInstances = workflowGateInstancesDual.sqlite;

export type InsertWorkflowGateInstance = typeof workflowGateInstances.$inferInsert;
export type SelectWorkflowGateInstance = typeof workflowGateInstances.$inferSelect;

/**
 * WorkLog gate events table.
 *
 * One row per gate state transition. Enables "show me all pending gates
 * across executions" queries without scanning the full frame state.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const worklogGateEventsDual = defineDualTable(
  'worklog_gate_events',
  (c) => ({
    /** Auto-generated surrogate key (executionId:nodeId:frameId). */
    id: c.text('id').primaryKey(),
    /** Execution this gate belongs to. */
    executionId: c
      .text('execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Node identifier of the gate in the workflow definition. */
    nodeId: c.text('node_id').notNull(),
    /** Frame identifier for the gate's execution frame. */
    frameId: c.text('frame_id').notNull(),
    /** Latest recorded gate status. */
    status: c
      .textEnum('status', { enum: ['waiting', 'resumed', 'rejected', 'timed-out', 'cancelled'] as const })
      .notNull(),
    /**
     * Prompt shown to the reviewer, after template interpolation.
     * Populated when the gate entered `waiting` status.
     */
    prompt: c.text('prompt'),
    /** Epoch milliseconds when the gate entered `waiting`. */
    openedAt: c.epochMs('opened_at').notNull(),
    /** Epoch milliseconds when the gate left `waiting`. */
    resolvedAt: c.epochMs('resolved_at'),
    /** JSON-serializable resume data submitted by the approver. */
    resumeData: c.jsonCol<JsonValue>('resume_data'),
  }),
  {
    sqlite: (t) => [
      // Efficient per-execution gate lookup.
      index('idx_worklog_gate_events_execution').on(t.executionId),
      // Index on status for "pending gates" queries.
      index('idx_worklog_gate_events_status').on(t.status),
    ],
    postgres: (t) => [
      pgIndex('idx_worklog_gate_events_execution').on(t.executionId),
      pgIndex('idx_worklog_gate_events_status').on(t.status),
    ],
  },
);

/** SQLite face of the `worklog_gate_events` table (canonical schema). */
export const worklogGateEvents = worklogGateEventsDual.sqlite;

export type InsertWorklogGateEvent = typeof worklogGateEvents.$inferInsert;
export type SelectWorklogGateEvent = typeof worklogGateEvents.$inferSelect;
