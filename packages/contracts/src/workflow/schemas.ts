import { z } from 'zod';

// ─────────────────────────────────────────────────────────────
// Workflow Trigger
// ─────────────────────────────────────────────────────────────

/** Primitive value union shared by filter operators. */
const PrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * Zod schema for a single filter operator value.
 *
 * Mirrors the `FilterOperator` type from `@makaio/core`:
 * a primitive (equality) or one of the operator objects
 * (`$in`, `$ne`, `$exists`, `$startsWith`, `$endsWith`).
 */
const FilterOperatorSchema = z.union([
  PrimitiveSchema,
  z.object({ $in: z.array(PrimitiveSchema) }).strict(),
  z.object({ $ne: PrimitiveSchema }).strict(),
  z.object({ $exists: z.boolean() }).strict(),
  z.object({ $startsWith: z.string() }).strict(),
  z.object({ $endsWith: z.string() }).strict(),
]);

/**
 * Zod schema for a `PayloadFilter` value — a record of field paths
 * to filter operators. Mirrors `PayloadFilter` from `@makaio/core`.
 */
const PayloadFilterSchema = z.record(z.string(), FilterOperatorSchema);

/**
 * Bus-event workflow trigger variant.
 * Fires when a bus subject emits a matching event.
 */
export const BusEventTriggerSchema = z.object({
  type: z.literal('bus-event'),
  /**
   * Bus subject pattern to match.
   * Supports exact match ('build.started') and wildcards ('build.*', 'repo.branch.*').
   * Matched via matchesSubscription() from bus-core.
   */
  subject: z.string(),
  /**
   * Structural payload filter using `PayloadFilter` operators.
   *
   * Supports equality, `$in`, `$ne`, `$exists`, `$startsWith`, `$endsWith`.
   * All key-operator pairs must match (AND logic).
   * Supports dot-notation paths for nested fields (e.g., `'raw.msg.type'`).
   * Omit to match all payloads for the subject.
   */
  filter: PayloadFilterSchema.optional(),
  /**
   * jexl expression for complex filter conditions.
   * Evaluated after `filter` passes (AND semantics).
   * The expression context provides a `payload` variable
   * containing the incoming event payload.
   * @example `"payload.count > 5 && payload.branch == 'main'"`
   */
  filterExpression: z.string().optional(),
});

export type BusEventTrigger = z.infer<typeof BusEventTriggerSchema>;

/**
 * Extension-contributed workflow trigger variant.
 * Uses `type: 'extension'` as the discriminant with the actual extension trigger type in `extensionType`.
 */
export const ExtensionWorkflowTriggerSchema = z.object({
  type: z.literal('extension'),
  /**
   * Extension-specific trigger type identifier.
   * Convention: '<extensionName>:<eventName>' (e.g., 'github:pr.opened').
   */
  extensionType: z.string().regex(/^[a-z0-9-]+:[a-z0-9._-]+$/),
  /**
   * Runtime trigger configuration as an opaque JSON object.
   * Validated against the extension's configSchema before storage.
   */
  config: z.record(z.string(), z.unknown()).optional(),
});

export type ExtensionWorkflowTrigger = z.infer<typeof ExtensionWorkflowTriggerSchema>;

/**
 * Workflow trigger configuration.
 * Discriminated union supporting built-in types (manual, cron, webhook) and extension-contributed types.
 */
export const WorkflowTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({
    type: z.literal('cron'),
    /** Cron expression (e.g., '0 * * * *'). */
    schedule: z.string(),
    /**
     * Timezone for cron evaluation.
     * Defaults to 'UTC' at execution time when omitted.
     */
    timezone: z.string().optional(),
  }),
  z.object({
    type: z.literal('webhook'),
    /** Webhook event name. */
    event: z.string(),
    /** Branch filter for webhook events. */
    branch: z.string().optional(),
    /** Repository filter (owner/name). */
    repo: z.string().optional(),
  }),
  ExtensionWorkflowTriggerSchema,
  BusEventTriggerSchema,
]);

export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

// ─────────────────────────────────────────────────────────────
// Workflow Input (parameterization)
// ─────────────────────────────────────────────────────────────

/**
 * Input parameter definition for workflow parameterization.
 */
export const WorkflowInputSchema = z.object({
  /** Input parameter name. */
  name: z.string(),
  /** Human-readable description of the input. */
  description: z.string().optional(),
  /** Type of the input value. */
  type: z.enum(['string', 'boolean', 'choice']),
  /** Whether this input is required. */
  required: z.boolean().optional(),
  /** Default value for the input. */
  default: z.union([z.string(), z.boolean()]).optional(),
  /** Available options for choice type. */
  options: z.array(z.string()).optional(),
});

export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

// ─────────────────────────────────────────────────────────────
// Workflow Step (DAG node)
// ─────────────────────────────────────────────────────────────

/**
 * Shared base fields present on every step variant.
 * Extend this schema when defining new step types.
 */
export const WorkflowStepBaseSchema = z.object({
  /** Unique step identifier within the workflow. */
  id: z.string(),
  /** Step IDs this step depends on (must complete first). */
  needs: z.array(z.string()).optional(),
  /** jexl expression evaluated at runtime; falsy skips the step. */
  if: z.string().optional(),
});

export type WorkflowStepBase = z.infer<typeof WorkflowStepBaseSchema>;

/**
 * Agent step variant — spawns a subagent to fulfil the prompt.
 * This is the default step type.
 */
export const AgentWorkflowStepSchema = WorkflowStepBaseSchema.extend({
  /** Step type discriminant. */
  type: z.literal('agent'),
  /** Task prompt for the agent. Supports `{{ }}` template interpolation. */
  prompt: z.string(),
  /** Adapter override for this step (e.g., 'claudeCode', 'openai'). */
  adapter: z.string().optional(),
  /** Model override for this step (e.g., 'sonnet', 'gpt-4'). */
  model: z.string().optional(),
  /** Execution target override for this step. */
  executionTargetId: z.string().optional(),
  /** Step lifecycle hooks. */
  onComplete: z
    .object({
      /** Extract mode for step result. */
      extract: z.enum(['summary', 'none']).optional(),
    })
    .optional(),
  /**
   * JSON Schema for the expected step output.
   * When set and the adapter supports `structuredOutput`, the executor
   * requests structured output from the model.
   * When set but the adapter lacks the capability, the schema is appended
   * to the prompt as a JSON constraint instruction.
   */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

export type AgentWorkflowStep = z.infer<typeof AgentWorkflowStepSchema>;

/**
 * Shell step — runs an external process directly via execFile.
 * Args are passed to the OS without shell interpretation, preventing injection.
 */
export const ShellWorkflowStepSchema = WorkflowStepBaseSchema.extend({
  /** Step type discriminant. */
  type: z.literal('shell'),
  /**
   * Command as an array: [binary, ...args].
   * Each element supports `{{ }}` template interpolation.
   * Array format prevents shell injection — args are passed directly
   * to execFile, never interpreted by a shell.
   * @example ['coderabbit', 'review', '--format', 'json']
   */
  command: z.array(z.string()).min(1),
  /**
   * Working directory override. Supports `{{ }}` interpolation.
   * Resolved relative to workspace root if a relative path.
   * Defaults to the coordinator session's workingDirectory.
   */
  cwd: z.string().optional(),
  /**
   * Extra environment variables injected into the process.
   * Merged with (but does not replace) the runtime's environment.
   * Values support `{{ }}` template interpolation.
   */
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Timeout in milliseconds. Defaults to 300 000 ms (5 minutes) at execution time when omitted.
   * On timeout: SIGTERM → 5 s grace → SIGKILL → step fails.
   */
  timeoutMs: z.number().optional(),
});

export type ShellWorkflowStep = z.infer<typeof ShellWorkflowStepSchema>;

/**
 * Gate step variant — pauses workflow for human approval.
 * Emits a gate request event, waits for user response or timeout,
 * then continues or fails the workflow.
 */
export const GateWorkflowStepSchema = WorkflowStepBaseSchema.extend({
  /** Step type discriminant. */
  type: z.literal('gate'),
  /**
   * Message shown to the user in the approval dialog.
   * Supports `{{ }}` template interpolation for dynamic content.
   * @example
   * ```
   * 'Delete worktree at \{{ trigger.path \}} and branch \{{ trigger.branch \}}?'
   * ```
   */
  prompt: z.string(),
  /**
   * Title for the approval dialog.
   * Defaults to 'Workflow Approval Required' when omitted.
   */
  title: z.string().optional(),
  /**
   * Action to take when the timeout expires.
   * - `'approve'`: auto-approve and continue the workflow
   * - `'reject'`: auto-reject and fail the workflow
   */
  autoAction: z.enum(['approve', 'reject']),
  /**
   * Timeout in milliseconds before autoAction fires.
   * `null` = block indefinitely (no timeout).
   */
  timeoutMs: z.number().nullable(),
});

export type GateWorkflowStep = z.infer<typeof GateWorkflowStepSchema>;

/**
 * For-each step variant type.
 * Declared manually ahead of its schema to break the z.lazy circular reference.
 */
export interface ForEachWorkflowStep extends WorkflowStepBase {
  /** Step type discriminant. */
  type: 'for-each';
  /** jexl expression that resolves to an array. */
  collection: string;
  /** Steps to execute per item. Forms an inner DAG (needs references are local). */
  steps: WorkflowStep[];
  /** Max concurrent iterations. Omit or 0 for unlimited. */
  concurrency?: number;
}

/** Discriminated union of all workflow step variants. */
export type WorkflowStep = AgentWorkflowStep | ShellWorkflowStep | GateWorkflowStep | ForEachWorkflowStep;

/**
 * For-each step variant — iterates over a collection, expanding inner steps per item.
 * Forms an inner DAG that is flattened into the parent DAG before execution.
 *
 * NOTE: The `steps` field uses `z.lazy()` to reference `WorkflowStepSchema`, creating
 * a circular schema reference. The schema output type is cast to `ForEachWorkflowStep`
 * on the containing union.
 */
export const ForEachWorkflowStepSchema = WorkflowStepBaseSchema.extend({
  /** Step type discriminant. */
  type: z.literal('for-each'),
  /** jexl expression that resolves to an array. */
  collection: z.string(),
  /** Steps to execute per item. Forms an inner DAG (needs references are local). */
  steps: z.lazy(() => z.array(WorkflowStepSchema)),
  /** Max concurrent iterations. Omit or 0 for unlimited. */
  concurrency: z.number().int().min(0).optional(),
});

/**
 * Discriminated union of all workflow step variants.
 * Wrapped in z.lazy() to support ForEachWorkflowStep's circular reference.
 *
 * NOTE: Zod v4 `discriminatedUnion` requires concrete `propValues` on each member.
 * `ForEachWorkflowStepSchema` has a `z.lazy()` field which prevents it from satisfying
 * `$ZodTypeDiscriminable`, so we use `z.union` here. Structural validation is identical;
 * only the fast-path discriminant routing is absent.
 */
export const WorkflowStepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.union([AgentWorkflowStepSchema, ShellWorkflowStepSchema, GateWorkflowStepSchema, ForEachWorkflowStepSchema]),
);

// ─────────────────────────────────────────────────────────────
// Workflow Definition (stored entity)
// ─────────────────────────────────────────────────────────────

/**
 * Zod schema for workflow definitions.
 * No `z.ZodType<>` annotation — kept as a concrete `z.ZodObject` so callers
 * (e.g. storage CRUD handlers) can use `.omit()`, `.pick()`, and other object methods.
 * `steps` uses `z.array(WorkflowStepSchema)` directly; `z.infer` produces `unknown[]`
 * through the `z.lazy` boundary, so the exported `WorkflowDefinition` type is declared
 * manually below to restore `steps: WorkflowStep[]`.
 */
export const WorkflowDefinitionSchema = z.object({
  /** Unique workflow identifier. */
  id: z.string(),
  /** Project this workflow belongs to (null = global template). Intentionally nullable, not optional. */
  projectId: z.string().nullable(),
  /** Workflow name. */
  name: z.string(),
  /** Human-readable description. */
  description: z.string().optional(),
  /** Input parameter definitions. */
  inputs: z.array(WorkflowInputSchema).optional(),
  /** Workflow steps (DAG nodes). */
  steps: z.array(WorkflowStepSchema),
  /** Scope identifier ('default' or projectId). */
  scope: z.string(),
  /** Creation timestamp. */
  createdAt: z.number(),
  /** Last update timestamp. */
  updatedAt: z.number(),
  /** Default execution target for all steps (overridable per step). */
  defaultExecutionTargetId: z.string().optional(),
  /**
   * Trigger configurations for this workflow.
   * Multiple triggers may fire independently; the workflow runs once per firing trigger.
   * Defaults to manual-only when omitted.
   */
  triggers: z.array(WorkflowTriggerSchema).optional(),
  /**
   * Canvas layout hints for the visual editor.
   * Stored as opaque JSON; ignored by the executor.
   */
  canvasLayout: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Input schema for creating/updating workflow definitions.
 * Omits timestamps which are managed by the storage layer.
 */
export const WorkflowDefinitionInputSchema = WorkflowDefinitionSchema.omit({
  createdAt: true,
  updatedAt: true,
});

/**
 * Workflow definition stored in the database.
 * Declared manually to preserve `steps: WorkflowStep[]` through the z.lazy boundary
 * (z.infer produces `unknown[]` for lazy-wrapped schemas).
 */
export type WorkflowDefinition = Omit<z.infer<typeof WorkflowDefinitionSchema>, 'steps'> & {
  steps: WorkflowStep[];
};

/**
 * Input schema for creating/updating workflow definitions.
 * Omits timestamps which are managed by storage layer.
 */
export type WorkflowDefinitionInput = Omit<z.infer<typeof WorkflowDefinitionInputSchema>, 'steps'> & {
  steps: WorkflowStep[];
};

/**
 * Schema typed as `z.ZodType<WorkflowDefinition, WorkflowDefinition>` for bus namespace registration.
 * Required because `z.lazy` erases the `Input` type parameter that `InferSchemaPayload` needs.
 */
export const WorkflowDefinitionSchemaTyped = WorkflowDefinitionSchema as z.ZodType<
  WorkflowDefinition,
  WorkflowDefinition
>;

/**
 * Schema typed as `z.ZodType<WorkflowDefinitionInput, WorkflowDefinitionInput>` for bus namespace registration.
 * @see {@link WorkflowDefinitionSchemaTyped} for explanation.
 */
export const WorkflowDefinitionInputSchemaTyped = WorkflowDefinitionInputSchema as z.ZodType<
  WorkflowDefinitionInput,
  WorkflowDefinitionInput
>;

// ─────────────────────────────────────────────────────────────
// Step State (runtime)
// ─────────────────────────────────────────────────────────────

/**
 * Execution status of a workflow step.
 */
export const StepStatusSchema = z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'skipped']);

export type StepStatus = z.infer<typeof StepStatusSchema>;

/**
 * Runtime state of a single step execution.
 */
export const StepStateSchema = z.object({
  /** Current execution status. */
  status: StepStatusSchema,
  /** Worker session ID executing this step. */
  sessionId: z.string().optional(),
  /** Subagent ID for this step execution. */
  subagentId: z.string().optional(),
  /** Step output/result. */
  result: z.string().optional(),
  /** Error message if step failed. */
  error: z.string().optional(),
  /** Step start timestamp. */
  startedAt: z.number().optional(),
  /** Step completion timestamp. */
  completedAt: z.number().optional(),
});

export type StepState = z.infer<typeof StepStateSchema>;

// ─────────────────────────────────────────────────────────────
// Workflow Execution (runtime state)
// ─────────────────────────────────────────────────────────────

/**
 * Execution status of a workflow.
 */
export const ExecutionStatusSchema = z.enum(['pending', 'running', 'paused', 'completed', 'failed', 'cancelled']);

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

/**
 * Runtime state of a workflow execution.
 */
export const WorkflowExecutionSchema = z.object({
  /** Unique execution identifier. */
  id: z.string(),
  /** Workflow definition being executed. */
  workflowId: z.string(),
  /** Coordinator session ID for this execution. */
  coordinatorSessionId: z.string().optional(),
  /** Current execution status. */
  status: ExecutionStatusSchema,
  /** Bound input values for this execution. */
  inputs: z.record(z.string(), z.unknown()),
  /** Step execution states keyed by step ID. */
  steps: z.record(z.string(), StepStateSchema),
  /** Currently executing step ID. */
  currentStepId: z.string().optional(),
  /** Execution start timestamp. */
  startedAt: z.number(),
  /** Execution completion timestamp. */
  completedAt: z.number().optional(),
  /** Error message if execution failed. */
  error: z.string().optional(),
  /**
   * Payload from the firing trigger.
   * Present when triggered by cron, webhook, or plugin event.
   * Absent for manual starts.
   */
  triggerPayload: z.record(z.string(), z.unknown()).optional(),
});

export type WorkflowExecution = z.infer<typeof WorkflowExecutionSchema>;

// ─────────────────────────────────────────────────────────────
// List Query
// ─────────────────────────────────────────────────────────────

/**
 * Query parameters for listing workflow definitions.
 */
export const WorkflowListQuerySchema = z.object({
  /** Filter by project ID. */
  projectId: z.string().optional(),
});

export type WorkflowListQuery = z.infer<typeof WorkflowListQuerySchema>;

/**
 * Query parameters for listing workflow executions.
 */
export const ExecutionListQuerySchema = z.object({
  /** Filter by workflow ID. */
  workflowId: z.string().optional(),
  /** Filter by execution status. */
  status: ExecutionStatusSchema.optional(),
});

export type ExecutionListQuery = z.infer<typeof ExecutionListQuerySchema>;
