import { z } from 'zod';
import { localSubject } from '@makaio/core';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import {
  WorkflowDefinitionSchemaTyped,
  PersistedWorkflowDefinitionInputSchemaTyped,
  WorkflowExecutionSchema,
  WorkflowExecutionSchemaTyped,
  ExecutionStatusSchema,
  WorkflowListQuerySchema,
  ExecutionListQuerySchema,
  ExecutionLinkSchema,
  SpanRecordSchema,
  StepStateSchemaTyped,
  WorkflowRunContextSchema,
} from '@makaio/contracts';
import {
  workflowDefinitions,
  workflowExecutions,
  workflowExecutionLinks,
  workflowExecutionSteps,
  workflowStepSpans,
  workflowRunContexts,
} from './schema.js';

const ExecutionLinkListQuerySchema = z
  .object({
    sourceExecutionId: z.string().min(1).optional(),
    targetExecutionId: z.string().min(1).optional(),
  })
  .refine((query) => query.sourceExecutionId !== undefined || query.targetExecutionId !== undefined, {
    message: 'Either sourceExecutionId or targetExecutionId is required.',
  });

const ExecutionUpdateSchema = z.object({
  executionId: z.string().min(1),
  status: ExecutionStatusSchema.optional(),
  currentStepId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  completedAt: z.number().nullable().optional(),
  stepUpdates: z.record(z.string().min(1), StepStateSchemaTyped).optional(),
});

/**
 * Storage namespace for workflow persistence.
 *
 * Provides internal storage operations for workflows:
 * - Definition CRUD (get, set, delete, list)
 * - Execution CRUD (getExecution, setExecution, listExecutions)
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
      response: z.object({ workflow: WorkflowDefinitionSchemaTyped.nullable() }),
    },

    set: {
      request: z.object({ workflow: PersistedWorkflowDefinitionInputSchemaTyped }),
      response: z.object({ id: z.string() }),
    },

    delete: {
      request: z.object({ id: z.string() }),
      response: z.object({ deleted: z.boolean() }),
    },

    list: {
      request: WorkflowListQuerySchema,
      response: z.object({ workflows: z.array(WorkflowDefinitionSchemaTyped) }),
    },

    // ─────────────────────────────────────────────────────────────
    // Execution CRUD
    // ─────────────────────────────────────────────────────────────

    getExecution: {
      request: z.object({ executionId: z.string() }),
      response: z.object({ execution: WorkflowExecutionSchemaTyped.nullable() }),
    },

    setExecution: {
      request: z.object({ execution: WorkflowExecutionSchemaTyped }),
      response: z.object({ id: z.string() }),
    },

    /**
     * Persist a newly-started execution and its worker run-context snapshot as
     * one storage transaction.
     */
    setExecutionStart: {
      request: z.object({ execution: WorkflowExecutionSchemaTyped, runContext: WorkflowRunContextSchema }),
      response: z.object({ id: z.string(), executionId: z.string() }),
    },

    updateExecution: {
      request: ExecutionUpdateSchema,
      response: z.object({ success: z.boolean() }),
    },

    /**
     * List workflow executions by workflow ID or scope.
     *
     * At least one of `workflowId` or `scope` is required. `limit` is optional
     * for callers and defaults to 50 during request parsing.
     */
    listExecutions: {
      request: ExecutionListQuerySchema,
      response: z.object({ executions: z.array(WorkflowExecutionSchemaTyped) }),
    },

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
  },
  extensions: {
    drizzle: {
      workflowDefinitions,
      workflowExecutions,
      workflowExecutionSteps,
      workflowStepSpans,
      workflowExecutionLinks,
      workflowRunContexts,
    },
  },
});

export const WorkflowStorageSubjects = WorkflowStorageNamespace.subjects;

export type { WorkflowDefinition, WorkflowDefinitionInput } from '@makaio/contracts';
export type WorkflowExecution = z.infer<typeof WorkflowExecutionSchema>;
export type WorkflowListQuery = z.infer<typeof WorkflowListQuerySchema>;
export type { ExecutionListQuery } from '@makaio/contracts';
export type ExecutionLinkListQuery = z.infer<typeof ExecutionLinkListQuerySchema>;
