import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import {
  ExecutionListQuerySchema,
  PersistedWorkflowDefinitionInputSchemaTyped,
  WorkflowDefinitionSchemaTyped,
  WorkflowExecutionSchema,
  WorkflowExecutionScopeSchema,
  WorkflowListQuerySchema,
  WorkflowResolvedRoleSchema,
} from './schemas.js';
import { JsonObjectContractSchema, JsonValueSchema } from '../shared/json-value.js';
import { SpanRecordSchema } from './span.js';
import { WorkflowRunContextSchema } from './run-context.js';

const StepLifecycleBaseSchema = z.object({
  executionId: z.string(),
  stepId: z.string(),
  // Composite `for-each` steps are runtime scheduler coordination nodes, not
  // executor targets — they are excluded. Function steps run in the worker
  // orchestrator and are included so their lifecycle is observable on the bus.
  stepType: z.enum(['agent', 'shell', 'gate', 'function', 'bus-request']),
});

const GateLifecycleBaseSchema = StepLifecycleBaseSchema.extend({
  stepType: z.literal('gate'),
});

/**
 * Payload emitted when a gate step requests human approval.
 * Extracted as a named constant so it can be reused by both the
 * `gate.requested` event schema and the `gate.awaitApproval` RPC request.
 */
const GateRequestedPayloadSchema = GateLifecycleBaseSchema.extend({
  workflowId: z.string(),
  workflowName: z.string(),
  title: z.string(),
  message: z.string(),
  autoAction: z.enum(['approve', 'reject']),
  timeoutMs: z.number().nullable(),
  openedAt: z.number(),
});

export const WorkflowSchemas = {
  getDefinition: {
    request: z.object({ id: z.string() }),
    response: z.object({ workflow: WorkflowDefinitionSchemaTyped.nullable() }),
  },
  setDefinition: {
    request: z.object({ workflow: PersistedWorkflowDefinitionInputSchemaTyped }),
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
      inputs: JsonObjectContractSchema.optional(),
      parentSessionId: z.string().optional(),
      triggerPayload: JsonObjectContractSchema.optional(),
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
  /**
   * List persisted step spans for a workflow execution.
   *
   * This is the public read surface for execution traces. Storage subjects remain
   * internal to the workflow subsystem.
   */
  listSpans: {
    request: z.object({ executionId: z.string() }),
    response: z.object({ spans: z.array(SpanRecordSchema) }),
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
   * Run a workflow from a TypeScript or JavaScript source file.
   *
   * The runtime loads the file, extracts the default-exported workflow
   * definition, registers it ephemerally (without persisting to storage),
   * and starts an execution. The response mirrors {@link WorkflowSchemas.start}
   * so callers can track the execution via the same lifecycle events.
   *
   * Intended for developer workflows and CLI-driven one-shot executions.
   */
  runFile: {
    request: z.object({
      /**
       * Absolute path to the workflow TypeScript or JavaScript source file.
       * The runtime resolves and imports this path directly.
       */
      filePath: z.string().min(1),
      /**
       * Trigger payload forwarded to the workflow execution context.
       * Use this to pass structured input when the file is triggered from a
       * CLI flag or stdin rather than a named bus trigger.
       */
      triggerPayload: JsonObjectContractSchema.optional(),
      /**
       * Scope override for the execution.
       * Defaults to `{ type: 'global' }` when omitted.
       */
      scope: WorkflowExecutionScopeSchema.optional(),
    }),
    response: z.object({ executionId: z.string() }),
  },

  /**
   * Resolve a named role to its full adapter configuration.
   * Called by the workflow executor when an agent step specifies `role`.
   */
  resolveRole: {
    request: z.object({ roleId: z.string().min(1) }),
    response: WorkflowResolvedRoleSchema,
  },

  /**
   * Pull the persisted run-context snapshot for a workflow execution.
   *
   * Called by executors (Piscina threads, Docker containers, remote workers)
   * after authenticating on the bus. The host validates the caller's identity
   * against the requested `executionId` before returning the snapshot.
   *
   * Trust-boundary rules (enforced by the handler, not the schema):
   * - Local callers: always permitted.
   * - Direct HMAC callers: `peer.kind === 'workflow-execution' && peer.id === executionId`.
   * - Relay/E2E callers: authenticated and encrypted peer required.
   */
  getRunContext: {
    request: z.object({ executionId: z.string().min(1) }),
    response: WorkflowRunContextSchema,
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
    /** JSON-serializable result produced by the step. */
    result: JsonValueSchema.optional(),
    duration: z.number(),
  }),
  'step.failed': StepLifecycleBaseSchema.extend({ error: z.string() }),
  'step.skipped': StepLifecycleBaseSchema.extend({
    reason: z.string().optional(),
    condition: z.string().optional(),
  }),

  'gate.requested': GateRequestedPayloadSchema,
  'gate.awaitApproval': {
    request: GateRequestedPayloadSchema,
    response: z.object({
      action: z.enum(['approve', 'reject']),
      source: z.enum(['user', 'timeout']),
      reason: z.string().optional(),
    }),
  },
  'gate.respond': {
    request: z.object({
      executionId: z.string(),
      stepId: z.string(),
      action: z.enum(['approve', 'reject']),
      reason: z.string().optional(),
    }),
    response: z.object({ accepted: z.boolean() }),
  },
  'gate.resolved': GateLifecycleBaseSchema.extend({
    action: z.enum(['approve', 'reject']),
    source: z.enum(['user', 'timeout']),
  }),
} satisfies SchemaRecord;

export const WorkflowNamespace = createBusNamespace('workflow', WorkflowSchemas);
export const WorkflowSubjects = WorkflowNamespace.subjects;
