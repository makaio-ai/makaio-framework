import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import {
  ExecutionListQuerySchema,
  WorkflowDefinitionInputSchemaTyped,
  WorkflowDefinitionSchemaTyped,
  WorkflowExecutionSchema,
  WorkflowExecutionScopeSchema,
  WorkflowListQuerySchema,
  WorkflowResolvedRoleSchema,
} from './schemas.js';

const StepLifecycleBaseSchema = z.object({
  executionId: z.string(),
  stepId: z.string(),
  // Composite `for-each` steps are runtime scheduler coordination nodes, not
  // executor targets, so lifecycle events only expose runner-executable steps.
  stepType: z.enum(['agent', 'shell', 'gate']),
});

export const WorkflowSchemas = {
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

  start: {
    request: z.object({
      workflowId: z.string(),
      inputs: z.record(z.string(), z.unknown()).optional(),
      parentSessionId: z.string().optional(),
      triggerPayload: z.record(z.string(), z.unknown()).optional(),
      /**
       * Scope override for this execution.
       * When provided, supersedes the scope declared on the workflow definition.
       * When omitted, the executor uses the workflow definition's required scope.
       */
      scope: WorkflowExecutionScopeSchema.optional(),
    }),
    response: z.object({ executionId: z.string() }),
  },
  cancel: {
    request: z.object({ executionId: z.string(), reason: z.string().optional() }),
    response: z.object({ cancelled: z.boolean() }),
  },
  getExecution: {
    request: z.object({ executionId: z.string() }),
    response: z.object({ execution: WorkflowExecutionSchema.nullable() }),
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
  listTriggerTypes: {
    request: z.object({}),
    response: z.object({
      triggerTypes: z.array(
        z.object({
          type: z.string(),
          displayName: z.string(),
          icon: z.string(),
          category: z.string(),
          description: z.string().optional(),
          configJsonSchema: z.record(z.string(), z.unknown()),
          outputJsonSchema: z.record(z.string(), z.unknown()),
          source: z.string(),
        }),
      ),
    }),
  },

  /**
   * Resolve a named role to its full adapter configuration.
   * Called by the workflow executor when an agent step specifies `role`.
   */
  resolveRole: {
    request: z.object({ roleId: z.string().min(1) }),
    response: WorkflowResolvedRoleSchema,
  },

  'execution.started': z.object({
    executionId: z.string(),
    workflowId: z.string(),
    coordinatorSessionId: z.string().optional(),
  }),
  'execution.completed': z.object({ executionId: z.string(), totalDuration: z.number() }),
  'execution.failed': z.object({
    executionId: z.string(),
    error: z.string(),
    failedStepId: z.string().optional(),
  }),
  'execution.cancelled': z.object({ executionId: z.string(), reason: z.string().optional() }),

  'step.beforeStart': StepLifecycleBaseSchema,
  'step.started': StepLifecycleBaseSchema.extend({
    sessionId: z.string().optional(),
    subagentId: z.string().optional(),
  }),
  'step.completed': StepLifecycleBaseSchema.extend({
    result: z.string().optional(),
    duration: z.number(),
  }),
  'step.failed': StepLifecycleBaseSchema.extend({ error: z.string() }),
  'step.skipped': StepLifecycleBaseSchema.extend({
    reason: z.string().optional(),
    condition: z.string().optional(),
  }),

  'gate.requested': StepLifecycleBaseSchema.extend({
    workflowId: z.string(),
    workflowName: z.string(),
    title: z.string(),
    message: z.string(),
    autoAction: z.enum(['approve', 'reject']),
    timeoutMs: z.number().nullable(),
    openedAt: z.number(),
  }),
  'gate.respond': {
    request: z.object({
      executionId: z.string(),
      stepId: z.string(),
      action: z.enum(['approve', 'reject']),
      reason: z.string().optional(),
    }),
    response: z.object({ accepted: z.boolean() }),
  },
  'gate.resolved': StepLifecycleBaseSchema.extend({
    action: z.enum(['approve', 'reject']),
    source: z.enum(['user', 'timeout']),
  }),
} satisfies SchemaRecord;

export const WorkflowNamespace = createBusNamespace('workflow', WorkflowSchemas);
export const WorkflowSubjects = WorkflowNamespace.subjects;
