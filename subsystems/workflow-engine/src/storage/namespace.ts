import { z } from 'zod';
import { localSubject } from '@makaio/core';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import {
  WorkflowDefinitionSchema,
  WorkflowExecutionSchema,
  ExecutionStatusSchema,
  WorkflowListQuerySchema,
  ExecutionListQuerySchema,
  ExecutionsByArtifactRefsQuerySchema,
  ExecutionLinkSchema,
  ExecutionLinkListQuerySchema,
  GateInstanceListQuerySchema,
  SpanRecordSchema,
  WorkflowFrameStateSchema,
  WorkflowGateInstanceSchema,
  WorkflowRunContextSchema,
  WorkLogFrameEntrySchema,
  JsonPatchOperationSchema,
  JsonValueSchema,
} from '@makaio/contracts';
import {
  workflowDefinitions,
  workflowExecutions,
  workflowExecutionFrames,
  workflowGateInstances,
  workflowStepSpans,
  workflowExecutionLinks,
  workflowRunContexts,
  worklogSummaries,
  worklogFrameEntries,
  worklogArtifactWrites,
  worklogGateEvents,
  workflowExecutionState,
  workflowExecutionStateEvents,
} from './schema.js';

const ExecutionUpdateSchema = z.object({
  executionId: z.string().min(1),
  status: ExecutionStatusSchema.optional(),
  error: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  completedAt: z.number().nullable().optional(),
});

const ExternalExecutionTerminalStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
const RunningWorklogFrameSchema = WorkLogFrameEntrySchema.extend({
  status: z.literal('running'),
  startedAt: z.number().int().nonnegative(),
});
const TerminalWorklogFrameSchema = WorkLogFrameEntrySchema.extend({
  status: ExternalExecutionTerminalStatusSchema,
  startedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

/**
 * Storage namespace for workflow persistence.
 *
 * Provides internal storage operations for workflows:
 * - Definition CRUD (get, set, delete, list)
 * - Execution CRUD (getExecution, setExecution, updateExecution, listExecutions)
 * - Frame CRUD (setFrame, getFrame, listFrames)
 * - Gate instance CRUD (setGateInstance, getGateInstance, listGateInstances)
 *
 * Subject prefix: `storage:workflow.*`
 *
 * This is INTERNAL to the workflow service - consumers use WorkflowSubjects from contracts.
 * @example
 * ```typescript
 * // Internal storage access
 * await bus.request(WorkflowStorageSubjects.get, { id: 'wf-123' });
 * await bus.request(WorkflowStorageSubjects.getExecution, { executionId: 'exec-456' });
 * ```
 */
export const WorkflowStorageNamespace = createStorageNamespaceDefinition('workflow', {
  schemas: {
    // ─────────────────────────────────────────────────────────────
    // Definition CRUD
    // ─────────────────────────────────────────────────────────────

    get: {
      request: z.object({ id: z.string() }),
      response: z.object({ workflow: WorkflowDefinitionSchema.nullable() }),
    },

    set: {
      request: z.object({ workflow: WorkflowDefinitionSchema }),
      response: z.object({ id: z.string() }),
    },

    delete: {
      request: z.object({ id: z.string() }),
      response: z.object({ deleted: z.boolean() }),
    },

    list: {
      request: WorkflowListQuerySchema,
      response: z.object({ workflows: z.array(WorkflowDefinitionSchema) }),
    },

    // ─────────────────────────────────────────────────────────────
    // Execution CRUD
    // ─────────────────────────────────────────────────────────────

    getExecution: {
      request: z.object({ executionId: z.string() }),
      response: z.object({ execution: WorkflowExecutionSchema.nullable() }),
    },

    setExecution: {
      request: z.object({ execution: WorkflowExecutionSchema }),
      response: z.object({ id: z.string() }),
    },

    /**
     * Persist a newly-started execution and its worker run-context snapshot as
     * one storage transaction.
     */
    setExecutionStart: {
      request: z.object({
        execution: WorkflowExecutionSchema,
        runContext: WorkflowRunContextSchema,
        initialState: JsonValueSchema.optional(),
        executionLinks: z.array(ExecutionLinkSchema).optional(),
      }),
      response: z.object({ id: z.string(), executionId: z.string() }),
    },

    /** Atomically persist an external execution and its initial WorkLog rows. */
    setExternalExecutionStart: localSubject({
      request: z.object({
        execution: WorkflowExecutionSchema.extend({ status: z.literal('running') }),
        frame: RunningWorklogFrameSchema.optional(),
      }),
      response: z.object({ executionId: z.string(), frameId: z.string().optional() }),
    }),

    /** Atomically settle an external execution and its WorkLog projection. */
    settleExternalExecution: localSubject({
      request: z.object({
        executionId: z.string().min(1),
        status: ExternalExecutionTerminalStatusSchema,
        error: z.string().min(1).optional(),
        reason: z.string().min(1).optional(),
        completedAt: z.number().int().nonnegative().optional(),
        frame: TerminalWorklogFrameSchema.optional(),
      }),
      response: z.object({ success: z.boolean() }),
    }),

    updateExecution: {
      request: ExecutionUpdateSchema,
      response: z.object({ success: z.boolean() }),
    },

    /**
     * Cancel a paused execution and all of its still-waiting gate instances in
     * one transaction.
     */
    cancelPausedExecution: {
      request: z.object({ executionId: z.string().min(1), completedAt: z.number(), reason: z.string().optional() }),
      response: z.object({
        cancelled: z.boolean(),
        gates: z.array(WorkflowGateInstanceSchema.extend({ status: z.literal('cancelled') })),
      }),
    },

    /**
     * List workflow executions by workflow ID or scope.
     *
     * At least one of `workflowId` or `scope` is required. `limit` is optional
     * for callers and defaults to 50 during request parsing.
     */
    listExecutions: {
      request: ExecutionListQuerySchema,
      response: z.object({ executions: z.array(WorkflowExecutionSchema) }),
    },

    /**
     * Batch-fetch recent executions grouped by artifact reference.
     * Internal storage implementation for the public `workflow.listExecutionsByArtifactRefs` subject.
     */
    listExecutionsByArtifactRefs: {
      request: ExecutionsByArtifactRefsQuerySchema,
      response: z.object({
        executionsByRef: z.record(z.string(), z.array(WorkflowExecutionSchema)),
      }),
    },

    // ─────────────────────────────────────────────────────────────
    // Frame CRUD
    // ─────────────────────────────────────────────────────────────

    /**
     * Upsert a single execution frame by `frameId`.
     * Called by the runtime when a frame is created or transitions state.
     * The `executionId` is required for insert; on conflict the full row is
     * replaced so both creation and state-update use the same subject.
     */
    setFrame: {
      request: z.object({ executionId: z.string().min(1), frame: WorkflowFrameStateSchema }),
      response: z.object({ frameId: z.string() }),
    },

    /**
     * Retrieve a single execution frame by `frameId`.
     */
    getFrame: {
      request: z.object({ frameId: z.string().min(1) }),
      response: z.object({ frame: WorkflowFrameStateSchema.nullable() }),
    },

    /**
     * List all frames for a given execution.
     */
    listFrames: {
      request: z.object({ executionId: z.string().min(1) }),
      response: z.object({ frames: z.array(WorkflowFrameStateSchema) }),
    },

    // ─────────────────────────────────────────────────────────────
    // Gate Instance CRUD
    // ─────────────────────────────────────────────────────────────

    /**
     * Upsert a gate instance record.
     * Called when a gate node is entered and when it is resolved.
     */
    setGateInstance: {
      request: z.object({ gate: WorkflowGateInstanceSchema }),
      response: z.object({ id: z.string() }),
    },

    /**
     * Resolve a waiting gate instance with compare-and-set semantics.
     *
     * Used for manual responses to paused exit-based gates. Only the first
     * request that observes the persisted gate in `waiting` status wins; all
     * later responses leave the row unchanged and return `accepted: false`.
     */
    resolveWaitingGateInstance: {
      request: z.object({
        gate: WorkflowGateInstanceSchema.extend({ status: z.enum(['resumed', 'rejected']) }),
      }),
      response: z.object({ accepted: z.boolean() }),
    },

    /**
     * Restore a paused execution and its waiting gate in one transaction after
     * a resolved manual response fails to launch a resume runner.
     */
    restorePausedGateResumeState: {
      request: z.object({
        execution: WorkflowExecutionSchema.extend({ status: z.literal('paused') }),
        gate: WorkflowGateInstanceSchema.extend({ status: z.literal('waiting') }),
      }),
      response: z.object({ executionId: z.string(), gateId: z.string() }),
    },

    /**
     * Retrieve a gate instance by execution ID, node ID, and optional frame ID.
     * Provide `frameId` when the gate lives inside an `iterate` expansion.
     */
    getGateInstance: {
      request: z.object({
        executionId: z.string().min(1),
        nodeId: z.string().min(1),
        frameId: z.string().min(1).optional(),
      }),
      response: z.object({ gate: WorkflowGateInstanceSchema.nullable() }),
    },

    /**
     * List gate instances by execution and/or status (bounded query).
     */
    listGateInstances: {
      request: GateInstanceListQuerySchema,
      response: z.object({ gates: z.array(WorkflowGateInstanceSchema) }),
    },

    /**
     * List finite-timeout gate instances whose owning execution is still paused.
     *
     * Used by the executor during startup to rehydrate long-lived timeout
     * wakeups for exit-based runs. This stays storage-local because it exposes
     * recovery state rather than a product-facing listing contract.
     */
    listPausedGateTimeouts: localSubject({
      request: z.object({}),
      response: z.object({ gates: z.array(WorkflowGateInstanceSchema) }),
    }),

    // ─────────────────────────────────────────────────────────────
    // Span CRUD
    // ─────────────────────────────────────────────────────────────

    setSpan: {
      request: z.object({ span: SpanRecordSchema }),
      response: z.object({ id: z.string() }),
    },

    listSpans: {
      request: z.object({ executionId: z.string() }),
      response: z.object({ spans: z.array(SpanRecordSchema) }),
    },

    // ─────────────────────────────────────────────────────────────
    // Execution Link CRUD
    // ─────────────────────────────────────────────────────────────

    setExecutionLink: {
      request: z.object({ link: ExecutionLinkSchema }),
      response: z.object({ id: z.string() }),
    },

    listExecutionLinks: {
      request: ExecutionLinkListQuerySchema,
      response: z.object({ links: z.array(ExecutionLinkSchema) }),
    },

    // ─────────────────────────────────────────────────────────────
    // Run Context CRUD
    // ─────────────────────────────────────────────────────────────

    /**
     * Persist the run-context snapshot for a workflow execution.
     * Called by the executor after creating the execution row, before worker boot.
     */
    setRunContext: localSubject({
      request: z.object({ runContext: WorkflowRunContextSchema }),
      response: z.object({ executionId: z.string() }),
    }),

    /**
     * Read the run-context snapshot by execution ID.
     * Called internally by the public `workflow.getRunContext` handler.
     */
    getRunContext: localSubject({
      request: z.object({ executionId: z.string().min(1) }),
      response: z.object({ runContext: WorkflowRunContextSchema.nullable() }),
    }),

    // ─────────────────────────────────────────────────────────────
    // Execution state
    // ─────────────────────────────────────────────────────────────

    /** Initialize execution state snapshot at sequence 0. */
    initializeState: localSubject({
      request: z.object({
        executionId: z.string().min(1),
        initialValue: JsonValueSchema,
      }),
      response: z.object({}),
    }),

    /** Read current execution state snapshot. */
    getState: localSubject({
      request: z.object({ executionId: z.string().min(1) }),
      response: z.object({
        state: z
          .object({
            executionId: z.string().min(1),
            sequence: z.number().int().nonnegative(),
            value: JsonValueSchema,
          })
          .nullable(),
      }),
    }),

    /** Apply a state mutation with optimistic concurrency control. */
    patchState: localSubject({
      request: z.object({
        executionId: z.string().min(1),
        expectedSequence: z.number().int().nonnegative(),
        nextValue: JsonValueSchema,
      }),
      response: z.object({
        executionId: z.string().min(1),
        sequence: z.number().int().positive(),
        patch: z.array(JsonPatchOperationSchema),
        value: JsonValueSchema,
      }),
    }),
  },
  extensions: {
    drizzle: {
      workflowDefinitions,
      workflowExecutions,
      workflowExecutionFrames,
      workflowGateInstances,
      workflowStepSpans,
      workflowExecutionLinks,
      workflowRunContexts,
      worklogSummaries,
      worklogFrameEntries,
      worklogArtifactWrites,
      worklogGateEvents,
      workflowExecutionState,
      workflowExecutionStateEvents,
    },
  },
});

export const WorkflowStorageSubjects = WorkflowStorageNamespace.subjects;

export type { WorkflowDefinition } from '@makaio/contracts';
export type WorkflowExecution = z.infer<typeof WorkflowExecutionSchema>;
export type WorkflowListQuery = z.infer<typeof WorkflowListQuerySchema>;
export type { ExecutionListQuery } from '@makaio/contracts';
export type { ExecutionLinkListQuery } from '@makaio/contracts';
