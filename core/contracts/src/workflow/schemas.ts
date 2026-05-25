import { z } from 'zod';
import { ContextModeSchema } from '../subagent/schemas.js';
import { ProviderContextSchema } from '../adapter/schemas/provider-context.js';
import { JsonObjectContractSchema, JsonValueSchema } from '../shared/json-value.js';

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
  config: JsonObjectContractSchema.optional(),
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
 * Resolved role configuration returned by the `workflow.resolveRole` RPC.
 *
 * When a workflow step specifies `role` instead of explicit adapter/model fields,
 * the executor resolves the role via the bus before spawning the subagent.
 * The resolved payload provides the full adapter configuration for execution.
 */
export const WorkflowResolvedRoleSchema = z.object({
  /** Adapter name to use for execution (e.g., 'claudeCode', 'openai'). */
  adapterName: z.string().min(1),
  /** Model override for the resolved role. */
  model: z.string().optional(),
  /** Harness ID for per-role tool governance. */
  harnessId: z.string().optional(),
  /** System prompt to prepend for this role. */
  systemPrompt: z.string().optional(),
  /** Context mode for the subagent session. */
  contextMode: ContextModeSchema.optional(),
  /** Provider context for credential and endpoint resolution. */
  providerContext: ProviderContextSchema.optional(),
});

export type WorkflowResolvedRole = z.infer<typeof WorkflowResolvedRoleSchema>;

/**
 * Agent step variant — spawns a subagent to fulfil the prompt.
 * This is the default step type.
 */
export const AgentWorkflowStepSchema = WorkflowStepBaseSchema.extend({
  /** Step type discriminant. */
  type: z.literal('agent'),
  /** Task prompt for the agent. Supports `{{ }}` template interpolation. */
  prompt: z.string(),
  /**
   * Named role reference. Resolved via `workflow.resolveRole` before execution.
   * When set, the executor calls the bus RPC to obtain adapter, model, and
   * other configuration instead of using inline fields.
   */
  role: z.string().min(1).optional(),
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
  outputSchema: JsonObjectContractSchema.optional(),
  /** Harness ID for per-role tool governance. */
  harnessId: z.string().optional(),
  /** Subagent context mode. Workflow steps default to fresh at execution time. */
  contextMode: ContextModeSchema.optional(),
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
 * Function step variant — executes a typed TypeScript function registered
 * in the workflow builder's runtime step map.
 *
 * The `runtime: true` flag signals that the actual handler lives outside
 * the serialized definition and must be retrieved from the worker executor's
 * step registry.
 */
export const FunctionWorkflowStepSchema = WorkflowStepBaseSchema.extend({
  /** Step type discriminant. */
  type: z.literal('function'),
  /** Marks this step as runtime-only; the function body is not serialized. */
  runtime: z.literal(true),
}).strict();

export type FunctionWorkflowStep = z.infer<typeof FunctionWorkflowStepSchema>;

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
export type WorkflowStep =
  | AgentWorkflowStep
  | ShellWorkflowStep
  | GateWorkflowStep
  | FunctionWorkflowStep
  | ForEachWorkflowStep;

/**
 * For-each step variant — iterates over a collection, expanding inner steps per item.
 * Forms an inner DAG that is expanded by the runtime scheduler after its needs settle.
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
  z.union([
    AgentWorkflowStepSchema,
    ShellWorkflowStepSchema,
    GateWorkflowStepSchema,
    FunctionWorkflowStepSchema,
    ForEachWorkflowStepSchema,
  ]),
);

// ─────────────────────────────────────────────────────────────
// Workflow Execution Scope
// ─────────────────────────────────────────────────────────────

/**
 * Generic scope descriptor for workflow definitions and executions.
 *
 * Discriminated union covering the full scope hierarchy without tying
 * the workflow engine to product-specific identifiers like `projectId`.
 *
 * - `global`: framework-wide, no owner constraint
 * - `workspace`: tied to a named workspace (id = workspace identifier)
 * - `session`: tied to a single session (id = session identifier)
 * - `external`: host-product-defined scope with an opaque `kind` and `id`
 * @example
 * ```typescript
 * const scope: WorkflowExecutionScope = { type: 'external', kind: 'project', id: 'proj-1' };
 * ```
 */
export const WorkflowExecutionScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z.object({ type: z.literal('workspace'), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('session'), id: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal('external'),
      kind: z.string().min(1),
      id: z.string().min(1),
    })
    .strict(),
]);

export type WorkflowExecutionScope = z.infer<typeof WorkflowExecutionScopeSchema>;

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
  /** Workflow name. */
  name: z.string(),
  /** Human-readable description. */
  description: z.string().optional(),
  /** Input parameter definitions. */
  inputs: z.array(WorkflowInputSchema).optional(),
  /** Workflow steps (DAG nodes). */
  steps: z.array(WorkflowStepSchema),
  /**
   * Scope this workflow definition is bound to.
   * Use `{ type: 'global' }` for framework-wide workflow definitions.
   */
  scope: WorkflowExecutionScopeSchema,
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
  canvasLayout: JsonObjectContractSchema.optional(),
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
 * Collect persisted-definition validation issues for runtime-only function steps.
 * @param steps - Workflow steps to scan recursively.
 * @param path - Zod issue path prefix for the current step array.
 * @returns Validation issue paths pointing at every function step discriminant.
 */
function collectFunctionStepIssues(
  steps: readonly WorkflowStep[],
  path: (string | number)[] = ['steps'],
): { path: (string | number)[] }[] {
  const issues: { path: (string | number)[] }[] = [];

  for (const [index, step] of steps.entries()) {
    const stepPath = [...path, index];
    if (step.type === 'function') {
      issues.push({ path: [...stepPath, 'type'] });
      continue;
    }
    if (step.type === 'for-each') {
      issues.push(...collectFunctionStepIssues(step.steps, [...stepPath, 'steps']));
    }
  }

  return issues;
}

/**
 * Definition input accepted by storage and bus registration.
 *
 * Function steps require a runtime function map and are therefore valid only
 * for file/source-authored workflow workers, not persisted JSON definitions.
 */
export const PersistedWorkflowDefinitionInputSchema = WorkflowDefinitionInputSchema.superRefine((workflow, ctx) => {
  for (const issue of collectFunctionStepIssues(workflow.steps)) {
    ctx.addIssue({
      code: 'custom',
      path: issue.path,
      message: 'Function workflow steps are only valid in file/source-authored workflows',
    });
  }
});

/**
 * Typed persisted definition schema for bus/storage namespace registration.
 * @see {@link WorkflowDefinitionInputSchemaTyped} for why this cast is needed.
 */
export const PersistedWorkflowDefinitionInputSchemaTyped = PersistedWorkflowDefinitionInputSchema as z.ZodType<
  WorkflowDefinitionInput,
  WorkflowDefinitionInput
>;

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
 * Runtime state of a single executable step (agent / shell / gate).
 * The `kind` discriminant separates executable state from composite state.
 */
export const ExecutableStepStateSchema = z.object({
  /** Discriminant: always `'executable'` for agent, shell, and gate steps. */
  kind: z.literal('executable'),
  /** Current execution status. */
  status: StepStatusSchema,
  /** Worker session ID executing this step. */
  sessionId: z.string().optional(),
  /** Subagent ID for this step execution. */
  subagentId: z.string().optional(),
  /** Step output/result. JSON-serializable value produced by the step. */
  result: JsonValueSchema.optional(),
  /** Error message if step failed. */
  error: z.string().optional(),
  /** Step start timestamp. */
  startedAt: z.number().optional(),
  /** Step completion timestamp. */
  completedAt: z.number().optional(),
});

export type ExecutableStepState = z.infer<typeof ExecutableStepStateSchema>;

/**
 * Persisted snapshot of a single `for-each` expansion.
 *
 * Captures everything needed to rebuild the scheduler graph for the expanded
 * iterations without re-evaluating the collection expression at resume time.
 */
export const ForEachExpansionSnapshotSchema = z.object({
  /** ID of the for-each step that owns this expansion. */
  parentStepId: z.string(),
  /**
   * Fully expanded child steps with namespaced IDs and rewired `needs` edges.
   * These are the flat WorkflowStep nodes inserted into the scheduler graph.
   */
  childSteps: z.array(WorkflowStepSchema),
  /**
   * Per-child-step item/index context keyed by expanded step ID.
   * Used for expression resolution when running a child step.
   */
  stepContext: z.record(
    z.string(),
    z.object({
      /** Collection item for this child step's iteration. */
      item: JsonValueSchema,
      /** Zero-based iteration index. */
      index: z.number(),
    }),
  ),
  /**
   * IDs of the expanded child steps that are leaves of the iteration DAG.
   * Downstream steps that depend on the for-each step are rewired to wait for
   * all leaf steps before starting.
   */
  leafStepIds: z.array(z.string()),
});

export type ForEachExpansionSnapshot = z.infer<typeof ForEachExpansionSnapshotSchema>;

/**
 * Runtime state of a composite `for-each` step.
 *
 * Composite steps are not executed directly; they orchestrate a set of
 * dynamically expanded child steps. Lifecycle events for individual
 * child steps are emitted only when those children (executable steps) run.
 */
export const CompositeStepStateSchema = z.object({
  /** Discriminant: always `'composite'` for for-each steps. */
  kind: z.literal('composite'),
  /**
   * Composite step execution status.
   * - `pending`   – not yet started
   * - `expanding` – scheduler has started expansion and generated children are active
   * - `completed` – all child steps have completed or been skipped
   * - `skipped`   – the for-each `if` condition was falsy
   * - `failed`    – at least one child step failed
   * - `cancelled` – the execution was cancelled while this step was active
   */
  status: z.enum(['pending', 'expanding', 'completed', 'skipped', 'failed', 'cancelled']),
  /** Epoch ms when expansion or first child execution began. */
  startedAt: z.number().optional(),
  /** Epoch ms when all child steps settled. */
  completedAt: z.number().optional(),
  /** Human-readable error message when `status` is `'failed'`. */
  error: z.string().optional(),
  /**
   * Persisted expansion snapshot.
   * Present after the scheduler has evaluated the collection expression and
   * produced child steps. Absent while still in `pending` state.
   */
  expansion: ForEachExpansionSnapshotSchema.optional(),
});

export type CompositeStepState = z.infer<typeof CompositeStepStateSchema>;

/**
 * Runtime state of a single workflow step.
 *
 * Discriminated union of executable (agent / shell / gate) and composite
 * (for-each) step states. Use the `kind` field to narrow.
 * @example
 * ```typescript
 * if (state.kind === 'executable') {
 *   // state.subagentId is available here
 * }
 * ```
 */
export const StepStateSchema = z.discriminatedUnion('kind', [ExecutableStepStateSchema, CompositeStepStateSchema]);

export type StepState = ExecutableStepState | CompositeStepState;

/**
 * Schema typed as `z.ZodType<StepState, StepState>` for bus namespace registration.
 *
 * Required because `CompositeStepState.expansion.childSteps` references
 * `WorkflowStepSchema` which is annotated as `z.ZodType<WorkflowStep>` (Input = unknown)
 * to support the `z.lazy` circular reference. Without this cast, `z.input` resolves
 * `childSteps` to `unknown[]`, causing assignability errors at bus handler callsites.
 * @see {@link WorkflowDefinitionSchemaTyped} for the same pattern applied to definitions.
 */
export const StepStateSchemaTyped = StepStateSchema as z.ZodType<StepState, StepState>;

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
  inputs: JsonObjectContractSchema,
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
  triggerPayload: JsonObjectContractSchema.optional(),
  /**
   * Scope this execution is bound to.
   * Inherited from the workflow definition at start time, or overridden
   * by the caller via {@link WorkflowSubjects.start}.
   */
  scope: WorkflowExecutionScopeSchema,
});

export type WorkflowExecution = z.infer<typeof WorkflowExecutionSchema>;

/**
 * Schema typed as `z.ZodType<WorkflowExecution, WorkflowExecution>` for bus
 * namespace registration.
 *
 * Required because `WorkflowExecution.steps` transitively contains
 * `CompositeStepState.expansion.childSteps` which references `WorkflowStepSchema`
 * annotated as `z.ZodType<WorkflowStep>` (Input = unknown) to break the `z.lazy`
 * circular reference. Without this cast, `z.input` resolves `childSteps` to
 * `unknown[]`, causing assignability errors at bus handler callsites.
 * @see {@link WorkflowDefinitionSchemaTyped} for the same pattern.
 */
export const WorkflowExecutionSchemaTyped = WorkflowExecutionSchema as z.ZodType<WorkflowExecution, WorkflowExecution>;

// ─────────────────────────────────────────────────────────────
// List Query
// ─────────────────────────────────────────────────────────────

/**
 * Query parameters for listing workflow definitions.
 */
export const WorkflowListQuerySchema = z.object({
  /** Filter by scope. When omitted, returns all definitions. */
  scope: WorkflowExecutionScopeSchema.optional(),
});

export type WorkflowListQuery = z.infer<typeof WorkflowListQuerySchema>;

/**
 * Cursor for keyset pagination over workflow executions.
 *
 * Combines `startedAt` and `id` so ordering is stable even when multiple
 * executions share the same timestamp.
 */
export const ExecutionListCursorSchema = z.object({
  /** Start timestamp of the last item on the previous page (epoch ms). */
  startedAt: z.number(),
  /** ID of the last item on the previous page. */
  id: z.string(),
});

export type ExecutionListCursor = z.infer<typeof ExecutionListCursorSchema>;

/** Minimum accepted execution list page size. */
export const EXECUTION_LIST_MIN_LIMIT = 1;

/** Maximum accepted execution list page size. */
export const EXECUTION_LIST_MAX_LIMIT = 500;

/** Default execution list page size when callers omit `limit`. */
export const EXECUTION_LIST_DEFAULT_LIMIT = 50;

/**
 * Query parameters for listing workflow executions.
 *
 * At least one of `workflowId` or `scope` is required to avoid unbounded scans.
 * Results are ordered by `startedAt desc, id desc` and always limited.
 */
export const ExecutionListQuerySchema = z
  .object({
    /** Filter by workflow ID. */
    workflowId: z.string().min(1).optional(),
    /** Filter by execution scope. */
    scope: WorkflowExecutionScopeSchema.optional(),
    /** Filter by execution status. */
    status: ExecutionStatusSchema.optional(),
    /** Maximum number of executions to return. Defaults to 50, max 500. */
    limit: z
      .number()
      .int()
      .min(EXECUTION_LIST_MIN_LIMIT)
      .max(EXECUTION_LIST_MAX_LIMIT)
      .default(EXECUTION_LIST_DEFAULT_LIMIT),
    /** Keyset pagination cursor from the previous page. */
    cursor: ExecutionListCursorSchema.optional(),
  })
  .refine((query) => query.workflowId !== undefined || query.scope !== undefined, {
    message: 'Either workflowId or scope is required.',
  });

export type ExecutionListQuery = z.infer<typeof ExecutionListQuerySchema>;
