import type { SchemaRecord } from '@makaio/core';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import {
  WorkflowDefinitionSchemaTyped,
  WorkflowDefinitionInputSchemaTyped,
  WorkflowExecutionSchema,
  WorkflowListQuerySchema,
  ExecutionListQuerySchema,
} from '@makaio/contracts';

/**
 * Workflow domain schemas.
 *
 * Subjects for workflow orchestration bus communication.
 * Each key becomes a subject identifier as: `workflow.{key}`
 *
 * **Dotted keys become nested properties:**
 * Schema keys with dots are transformed into nested subject accessors.
 * Use dot notation to access them.
 * @example
 * ```typescript
 * // Request subjects
 * bus.request(WorkflowSubjects.getDefinition, { id: 'wf-123' });
 * bus.request(WorkflowSubjects.start, { workflowId: 'wf-123' });
 *
 * // Event subjects
 * bus.on(WorkflowSubjects.started, (ctx) => { ... });
 * bus.on(WorkflowSubjects.stepCompleted, (ctx) => { ... });
 * ```
 */
export const WorkflowSchemas = {
  // ─────────────────────────────────────────────────────────────
  // Definition CRUD
  // ─────────────────────────────────────────────────────────────

  getDefinition: {
    request: z.object({ id: z.string() }),
    response: z.object({ workflow: WorkflowDefinitionSchemaTyped.nullable() }),
  },

  setDefinition: {
    request: z.object({ workflow: WorkflowDefinitionInputSchemaTyped }),
    response: z.object({ id: z.string() }),
  },

  deleteDefinition: {
    request: z.object({ id: z.string() }),
    response: z.object({ deleted: z.boolean() }),
  },

  listDefinitions: {
    request: WorkflowListQuerySchema,
    response: z.object({ workflows: z.array(WorkflowDefinitionSchemaTyped) }),
  },

  'definition.created': WorkflowDefinitionSchemaTyped,
  'definition.updated': WorkflowDefinitionSchemaTyped,
  'definition.deleted': z.object({ id: z.string() }),

  // ─────────────────────────────────────────────────────────────
  // Execution Control
  // ─────────────────────────────────────────────────────────────

  start: {
    request: z.object({
      workflowId: z.string(),
      inputs: z.record(z.string(), z.unknown()).optional(),
      parentSessionId: z.string().optional(),
      /**
       * Payload from the firing trigger.
       * Becomes the `trigger` property in the expression context.
       */
      triggerPayload: z.record(z.string(), z.unknown()).optional(),
    }),
    response: z.object({ executionId: z.string() }),
  },

  cancel: {
    request: z.object({ executionId: z.string() }),
    response: z.object({ success: z.boolean() }),
  },

  listTriggerTypes: {
    request: z.object({}),
    response: z.object({
      triggerTypes: z.array(
        z.object({
          /** Globally unique trigger type string. */
          type: z.string(),
          /** Display name shown in the editor palette. */
          displayName: z.string(),
          /** Lucide icon name. */
          icon: z.string(),
          /** Palette group label. */
          category: z.string(),
          /** Human-readable description. */
          description: z.string().optional(),
          /** JSON Schema derived from configSchema. */
          configJsonSchema: z.record(z.string(), z.unknown()),
          /** JSON Schema derived from outputSchema. */
          outputJsonSchema: z.record(z.string(), z.unknown()),
          /** 'builtin' or plugin name. */
          source: z.string(),
        }),
      ),
    }),
  },

  // ─────────────────────────────────────────────────────────────
  // Execution Queries
  // ─────────────────────────────────────────────────────────────

  getExecution: {
    request: z.object({ executionId: z.string() }),
    response: z.object({ execution: WorkflowExecutionSchema.nullable() }),
  },

  listExecutions: {
    request: ExecutionListQuerySchema,
    response: z.object({ executions: z.array(WorkflowExecutionSchema) }),
  },

  // ─────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────

  started: z.object({
    executionId: z.string(),
    workflowId: z.string(),
    coordinatorSessionId: z.string(),
  }),

  stepStarted: z.object({
    executionId: z.string(),
    stepId: z.string(),
    sessionId: z.string(),
    subagentId: z.string().optional(),
  }),

  stepCompleted: z.object({
    executionId: z.string(),
    stepId: z.string(),
    result: z.string().optional(),
    duration: z.number(),
  }),

  stepFailed: z.object({
    executionId: z.string(),
    stepId: z.string(),
    error: z.string(),
  }),

  stepSkipped: z.object({
    executionId: z.string(),
    stepId: z.string(),
    condition: z.string(),
  }),

  completed: z.object({
    executionId: z.string(),
    totalDuration: z.number(),
  }),

  failed: z.object({
    executionId: z.string(),
    error: z.string(),
    failedStepId: z.string().optional(),
  }),

  cancelled: z.object({
    executionId: z.string(),
  }),

  // ─────────────────────────────────────────────────────────────
  // Gate Approval (human-in-the-loop)
  // ─────────────────────────────────────────────────────────────

  /**
   * Emitted when a gate step opens, requesting human approval.
   * UI subscribers show an approval dialog with the provided message and countdown.
   */
  'gate.request': z.object({
    executionId: z.string(),
    stepId: z.string(),
    workflowId: z.string(),
    workflowName: z.string(),
    title: z.string(),
    message: z.string(),
    autoAction: z.enum(['approve', 'reject']),
    timeoutMs: z.number().nullable(),
    /** Timestamp when the gate was opened. Used by UI for countdown. */
    openedAt: z.number(),
  }),

  /**
   * Request subject for submitting a gate approval or rejection.
   * Returns `{ accepted: false }` if the gate was already resolved (timeout race).
   */
  'gate.respond': {
    request: z.object({
      executionId: z.string(),
      stepId: z.string(),
      action: z.enum(['approve', 'reject']),
      /** Optional reason from the user. Stored in step result/error. */
      reason: z.string().optional(),
    }),
    response: z.object({
      /** False if the gate was already resolved (timeout race). */
      accepted: z.boolean(),
    }),
  },

  /**
   * Emitted when a gate step resolves (via user response or timeout).
   * UI subscribers dismiss the approval dialog.
   */
  gateResolved: z.object({
    executionId: z.string(),
    stepId: z.string(),
    action: z.enum(['approve', 'reject']),
    source: z.enum(['user', 'timeout']),
  }),
} satisfies SchemaRecord;

export const WorkflowNamespace = createBusNamespace('workflow', WorkflowSchemas);
export const WorkflowSubjects = WorkflowNamespace.subjects;
