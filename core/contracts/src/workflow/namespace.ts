import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import {
  ExecutionListQuerySchema,
  WorkflowDefinitionInputSchemaTyped,
  WorkflowDefinitionSchemaTyped,
  WorkflowExecutionSchema,
  WorkflowListQuerySchema,
} from './schemas.js';

const StepLifecycleBaseSchema = z.object({
  executionId: z.string(),
  stepId: z.string(),
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
