import { z } from 'zod';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import {
  WorkflowDefinitionSchemaTyped,
  WorkflowDefinitionInputSchemaTyped,
  WorkflowExecutionSchema,
  WorkflowListQuerySchema,
  ExecutionListQuerySchema,
} from '@makaio/contracts';
import { workflowDefinitions, workflowExecutions } from './schema.js';

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
      request: z.object({ workflow: WorkflowDefinitionInputSchemaTyped }),
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
      response: z.object({ execution: WorkflowExecutionSchema.nullable() }),
    },

    setExecution: {
      request: z.object({ execution: WorkflowExecutionSchema }),
      response: z.object({ id: z.string() }),
    },

    listExecutions: {
      request: ExecutionListQuerySchema,
      response: z.object({ executions: z.array(WorkflowExecutionSchema) }),
    },
  },
  extensions: {
    drizzle: {
      workflowDefinitions,
      workflowExecutions,
    },
  },
});

export const WorkflowStorageSubjects = WorkflowStorageNamespace.subjects;

export type { WorkflowDefinition, WorkflowDefinitionInput } from '@makaio/contracts';
export type WorkflowExecution = z.infer<typeof WorkflowExecutionSchema>;
export type WorkflowListQuery = z.infer<typeof WorkflowListQuerySchema>;
export type ExecutionListQuery = z.infer<typeof ExecutionListQuerySchema>;
