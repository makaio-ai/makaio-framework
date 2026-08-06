/* eslint max-lines: ["error", { "max": 420, "skipBlankLines": true, "skipComments": true }] */
import { z } from 'zod';
import type { PayloadFilter } from '@makaio/core';
import {
  JsonObjectContractSchema,
  JsonRecordSchema,
  JsonSchemaRecordSchema,
  JsonValueSchema,
} from '../shared/json-value.js';
import { AutomationTriggerKindSchema } from '../automation-trigger/schemas.js';
import type { AutomationTriggerBinding } from '../automation-trigger/definition.js';
import { ArtifactScopeSchema } from '../artifact/index.js';
import { ProviderContextSchema } from '../adapter/schemas/provider-context.js';
import { CompletionModeSchema, ContextModeSchema } from '../subagent/schemas.js';
import { AIReasoningLevelSchema } from '../model/index.js';
import { WorkflowArtifactRefSchema } from './artifact-ref.js';
import { WorkflowDelegateResultFinalizerIdSchema, WorkflowFinalizerIdSchema } from './finalization.js';
import { WorkerNodeRequirementsSchema } from '../capabilities/worker-node/index.js';

// ─────────────────────────────────────────────────────────────
// Workflow Automation Trigger Binding
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
 * Persisted workflow trigger binding.
 *
 * A workflow references an automation trigger by canonical {@link AutomationTriggerBinding.kind}
 * and supplies the trigger-type parameters in `params`. `filter` and
 * `filterExpression` are **consumer-owned**: they narrow an already-validated
 * event after the trigger source activated, so they never belong to the trigger
 * type's own parameter schema.
 *
 * Unknown keys are stripped rather than rejected so the compile-time-only
 * phantom payload carrier on authored triggers never reaches storage.
 */
export const WorkflowAutomationTriggerBindingSchema = z.object({
  /** Canonical trigger kind: `<extension-name>.<local-name>`. */
  kind: AutomationTriggerKindSchema,
  /** JSON-safe parameter schema input parsed before trigger activation. */
  params: JsonRecordSchema,
  /**
   * Structural payload filter using `PayloadFilter` operators.
   *
   * Supports equality, `$in`, `$ne`, `$exists`, `$startsWith`, `$endsWith`.
   * All key-operator pairs must match (AND logic).
   * Supports dot-notation paths for nested fields (e.g., `'raw.msg.type'`).
   * Omit to accept every event the trigger emits.
   */
  filter: PayloadFilterSchema.optional(),
  /**
   * jexl expression for complex filter conditions.
   * Evaluated after `filter` passes (AND semantics).
   * The expression context provides a `payload` variable
   * containing the emitted trigger event payload.
   * @example `"payload.count > 5 && payload.branch == 'main'"`
   */
  filterExpression: z.string().optional(),
});

/**
 * Persisted workflow trigger binding — an automation trigger binding plus the
 * consumer-owned event filters applied by the workflow engine.
 */
export interface WorkflowAutomationTriggerBinding extends AutomationTriggerBinding {
  /** Structural payload filter applied to the emitted trigger event. */
  readonly filter?: PayloadFilter;
  /** jexl expression evaluated after {@link filter} passes. */
  readonly filterExpression?: string;
}

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
// Workflow Condition
// ─────────────────────────────────────────────────────────────

/**
 * A jexl expression string evaluated at runtime against the execution context.
 *
 * Used for `when` (conditional execution) and `skip` (skip this node and its
 * descendants) on workflow node primitives.
 * @example `"ctx.inputs.env == 'production'"`
 */
export const WorkflowConditionSchema = z.string().min(1);

export type WorkflowCondition = z.infer<typeof WorkflowConditionSchema>;

// ─────────────────────────────────────────────────────────────
// Artifact Binding and Write Declaration
// ─────────────────────────────────────────────────────────────

/**
 * Declares a named artifact binding for the workflow as a whole.
 *
 * When a workflow produces a primary artifact, the binding identifies
 * the artifact kind and scope so the runtime can associate execution
 * outputs with the artifact store.
 */
export const WorkflowArtifactBindingSchema = z.object({
  /** Artifact kind string (e.g. `'implementation-plan'`). */
  kind: z.string().min(1),
  /** Schema version used by the artifact service to validate the `data` payload. */
  schemaVersion: z.string().min(1),
  /** Scope at which the artifact is stored. */
  scope: ArtifactScopeSchema,
  /**
   * Optional jexl expression used by the runtime to resolve an existing artifact.
   */
  resolve: z.string().min(1).optional(),
  /**
   * Optional jexl expression used by the runtime to create initial artifact data.
   */
  create: z.string().min(1).optional(),
  /**
   * Optional dot path to the status field used by `ctx.artifact.updateStatus()`.
   */
  statusPath: z.string().min(1).optional(),
});

export type WorkflowArtifactBinding = z.infer<typeof WorkflowArtifactBindingSchema>;

/**
 * Declares an artifact write that a node is expected to produce.
 *
 * Write declarations are hints for the runtime and UI; the actual write is
 * performed by the node's execution logic. They do not carry functions —
 * only serializable configuration consumed at execution time.
 */
export const WorkflowArtifactWriteDeclarationSchema = z.object({
  /** Artifact kind string (e.g. `'station-output'`). */
  kind: z.string().min(1),
  /** Schema version validated by the artifact service. */
  schemaVersion: z.string().min(1),
  /** Scope at which the artifact revision is written. */
  scope: ArtifactScopeSchema,
  /**
   * Optional jexl expression evaluated at runtime to produce the artifact `data`.
   * When omitted the node's primary output is used verbatim.
   */
  dataExpression: z.string().optional(),
});

export type WorkflowArtifactWriteDeclaration = z.infer<typeof WorkflowArtifactWriteDeclarationSchema>;

// ─────────────────────────────────────────────────────────────
// Source Location
// ─────────────────────────────────────────────────────────────

/**
 * Authoring-time source location attached to dynamically generated nodes.
 *
 * Stored in persisted definitions so the UI and diagnostic tools can report
 * where a dynamic region was authored, without carrying runtime state.
 */
export const WorkflowSourceLocationSchema = z.object({
  /**
   * Source file path, relative to the workflow project root.
   * Absolute paths are accepted but relative paths are portable across machines.
   */
  file: z.string().min(1),
  /**
   * One-based line number in `file` where the factory or dynamic region begins.
   */
  line: z.number().int().positive().optional(),
  /**
   * One-based column number on `line` where the factory or dynamic region begins.
   */
  column: z.number().int().positive().optional(),
});

export type WorkflowSourceLocation = z.infer<typeof WorkflowSourceLocationSchema>;

// ─────────────────────────────────────────────────────────────
// Node Type Discriminant
// ─────────────────────────────────────────────────────────────

/**
 * Discriminant enum for all primitive workflow node types.
 *
 * - `station`        — atomic work unit (agent, shell, or bus-request task)
 * - `delegate-agent` — delegates to a named agent role for a subtask
 * - `delegate-role`  — delegates to a resolved product role
 * - `parallel`       — runs child branches concurrently
 * - `gate`           — pauses execution awaiting human or automated approval
 * - `iterate`        — expands over a collection (fan-out then fan-in)
 * - `iterate-chain`  — sequential pipeline iteration over a collection
 * - `loop`           — gated retry loop with a body sequence and convergence gate
 * - `sequence`       — ordered list of child nodes (the structural container)
 */
export const WorkflowNodeTypeSchema = z.enum([
  'station',
  'delegate-agent',
  'delegate-role',
  'parallel',
  'gate',
  'iterate',
  'iterate-chain',
  'loop',
  'sequence',
]);

export type WorkflowNodeType = z.infer<typeof WorkflowNodeTypeSchema>;

/**
 * Execution mode for `parallel` nodes.
 *
 * - `all-settled` waits for every branch and captures branch failures.
 * - `fail-fast` fails the parallel node on the first branch failure.
 */
export const WorkflowParallelModeSchema = z.enum(['all-settled', 'fail-fast']);

export type WorkflowParallelMode = z.infer<typeof WorkflowParallelModeSchema>;

// ─────────────────────────────────────────────────────────────
// Node Base and Discriminated Union
// ─────────────────────────────────────────────────────────────

/**
 * Shared base fields present on every workflow node variant.
 *
 * All node types extend this base. The `when` and `skip` fields carry
 * jexl expressions evaluated at runtime; schemas must not contain functions.
 */
export const WorkflowNodeBaseSchema = z.object({
  /**
   * Unique node identifier within the workflow definition.
   * Must be a non-empty string; uniqueness is enforced at authoring time.
   */
  id: z.string().min(1),
  /**
   * jexl expression evaluated at runtime.
   * When present and falsy, the node and its subtree are skipped.
   */
  when: WorkflowConditionSchema.optional(),
  /**
   * jexl expression evaluated at runtime.
   * When present and truthy, the node is skipped without propagating failure.
   */
  skip: WorkflowConditionSchema.optional(),
  /**
   * Artifact write declarations for this node.
   * Hints for the runtime and UI; no functions, purely serializable config.
   */
  writes: z.array(WorkflowArtifactWriteDeclarationSchema).optional(),
});

export type WorkflowNodeBase = z.infer<typeof WorkflowNodeBaseSchema>;

/**
 * TypeScript interface for the recursive `WorkflowNode` union.
 * Declared manually to break the circular reference introduced by
 * `sequence` and `parallel` containing child nodes.
 */
export interface WorkflowNode extends WorkflowNodeBase {
  type: WorkflowNodeType;
}

/**
 * Discriminated union of all workflow node variants.
 *
 * Uses `z.lazy()` to support recursive `sequence` and `parallel` node structures.
 * All variant schemas reference this schema via their own `z.lazy()` wrappers for
 * child arrays (`nodes`, `branches`, `body`), so the top-level schema can be
 * declared as a `const` with a single `z.lazy()` call.
 *
 * NOTE: Zod v4 `discriminatedUnion` requires each member to have a concrete
 * `type` literal. The lazy-wrapped child arrays are internal to each variant
 * and do not affect discriminant routing.
 */
export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(
  (): z.ZodType<WorkflowNode> =>
    z.discriminatedUnion('type', [
      WorkflowStationNodeSchema,
      WorkflowDelegateAgentNodeSchema,
      WorkflowDelegateRoleNodeSchema,
      WorkflowParallelNodeSchema,
      WorkflowGateNodeSchema,
      WorkflowIterateNodeSchema,
      WorkflowIterateChainNodeSchema,
      WorkflowLoopNodeSchema,
      WorkflowSequenceNodeSchema,
    ]) as z.ZodType<WorkflowNode>,
);

// ─────────────────────────────────────────────────────────────
// Sequence Node
// ─────────────────────────────────────────────────────────────

/**
 * Sequence node — the structural container for an ordered list of child nodes.
 *
 * This is the only composite node that may appear as the `root` of a
 * `WorkflowDefinition`. Sequences may be nested inside `parallel` branches
 * and `iterate`/`iterate-chain` bodies.
 */
export const WorkflowSequenceNodeSchema = WorkflowNodeBaseSchema.extend({
  /** Node type discriminant. */
  type: z.literal('sequence'),
  /** Ordered list of child nodes executed sequentially. */
  nodes: z.lazy((): z.ZodType<WorkflowNode[]> => z.array(WorkflowNodeSchema)),
});

export type WorkflowSequenceNode = z.infer<typeof WorkflowSequenceNodeSchema>;

// ─────────────────────────────────────────────────────────────
// Station Node
// ─────────────────────────────────────────────────────────────

/**
 * Station node — an atomic unit of work.
 *
 * A station encapsulates a task prompt, an optional named role, optional
 * input/output schemas for structured data exchange, and an optional
 * timeout. It does not contain child nodes or functions.
 *
 * Runtime handlers are registered outside the persisted definition
 * (in the authoring object's step map); this schema is function-free.
 */
export const WorkflowStationNodeSchema = WorkflowNodeBaseSchema.extend({
  /** Node type discriminant. */
  type: z.literal('station'),
  /**
   * Task prompt for the station. Supports `{{ }}` template interpolation
   * against the execution context at runtime.
   */
  prompt: z.string().min(1),
  /**
   * Named role reference. Resolved via the bus `resolveRole` RPC before
   * execution so the executor obtains adapter, model, and harness configuration.
   */
  role: z.string().min(1).optional(),
  /**
   * JSON Schema for the expected station output.
   * When set and the adapter supports `structuredOutput`, the executor
   * requests structured output from the model.
   */
  outputSchema: JsonSchemaRecordSchema.optional(),
  /**
   * Timeout in milliseconds. Defaults to 300 000 ms (5 minutes) at execution
   * time when omitted.
   */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * Subagent completion mode. `'tool'` (default) waits for an explicit
   * `completeTask` tool call; `'turn'` completes when the agent's first
   * turn finishes — useful for tool-less, one-shot stations.
   */
  completion: CompletionModeSchema.optional(),
});

export type WorkflowStationNode = z.infer<typeof WorkflowStationNodeSchema>;

// ─────────────────────────────────────────────────────────────
// Delegate-Agent Node
// ─────────────────────────────────────────────────────────────

/**
 * Delegate-agent node — spawns a named agent for a sub-task.
 *
 * The `agentId` references a registered agent definition. The agent
 * receives the `input` expression result as its invocation payload.
 */
export const WorkflowDelegateAgentNodeSchema = WorkflowNodeBaseSchema.extend({
  /** Node type discriminant. */
  type: z.literal('delegate-agent'),
  /**
   * Identifier of the registered agent definition to invoke.
   */
  agentId: z.string().min(1),
  /**
   * jexl expression resolving to the agent input payload.
   * Evaluated against the execution context at runtime.
   * When omitted, the agent receives the full execution context as input.
   */
  inputExpression: z.string().optional(),
  /**
   * JSON Schema for the expected agent output.
   * Used for structured output requests and UI contract display.
   */
  outputSchema: JsonSchemaRecordSchema.optional(),
  /** Exact tool allowlist selected by the workflow authority for this delegate. */
  allowedTools: z.array(z.string()).optional(),
  /** Completion contract for the spawned subagent. Defaults to tool completion. */
  completion: CompletionModeSchema.optional(),
  /** Authority-owned finalizer applied to a successful result before frame persistence. */
  resultFinalizerId: WorkflowDelegateResultFinalizerIdSchema.optional(),
});

export type WorkflowDelegateAgentNode = z.infer<typeof WorkflowDelegateAgentNodeSchema>;

// ─────────────────────────────────────────────────────────────
// Delegate-Role Node
// ─────────────────────────────────────────────────────────────

/**
 * Delegate-role node — delegates a task to a product-resolved role.
 *
 * Similar to `delegate-agent` but resolves the executor via a named product
 * role rather than a fixed agent ID. The role is resolved via the bus
 * `resolveRole` RPC before the node runs.
 */
export const WorkflowDelegateRoleNodeSchema = WorkflowNodeBaseSchema.extend({
  /** Node type discriminant. */
  type: z.literal('delegate-role'),
  /**
   * Named role reference. Resolved at execution time via the bus RPC.
   */
  role: z.string().min(1),
  /**
   * Task prompt forwarded to the resolved role executor.
   * Supports `{{ }}` template interpolation.
   */
  prompt: z.string().min(1),
  /**
   * JSON Schema for the expected output of this delegation.
   */
  outputSchema: JsonSchemaRecordSchema.optional(),
  /** Exact tool allowlist selected by the workflow authority for this delegate. */
  allowedTools: z.array(z.string()).optional(),
  /** Authority-owned finalizer applied to a successful result before frame persistence. */
  resultFinalizerId: WorkflowDelegateResultFinalizerIdSchema.optional(),
  /**
   * Timeout in milliseconds. Defaults to 300 000 ms (5 minutes) when omitted.
   */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * Subagent completion mode. `'tool'` (default) waits for an explicit
   * `completeTask` tool call; `'turn'` completes when the agent's first
   * turn finishes — useful for tool-less, one-shot delegates.
   */
  completion: CompletionModeSchema.optional(),
});

export type WorkflowDelegateRoleNode = z.infer<typeof WorkflowDelegateRoleNodeSchema>;

// ─────────────────────────────────────────────────────────────
// Parallel Node
// ─────────────────────────────────────────────────────────────

/**
 * Parallel node — runs a set of named branches concurrently.
 *
 * All branches start simultaneously when the node is entered. The parallel
 * node completes when all branches complete. Each branch is a `sequence`
 * node with its own ordered child list.
 *
 * Branches are keyed by a stable string name so the runtime and UI can
 * track per-branch frame state independently.
 */
export const WorkflowParallelNodeSchema = WorkflowNodeBaseSchema.extend({
  /** Node type discriminant. */
  type: z.literal('parallel'),
  /**
   * Branch execution mode. Hand-authored definitions may omit this field; the
   * authoring builder serializes the default `all-settled` mode explicitly.
   */
  mode: WorkflowParallelModeSchema.optional(),
  /**
   * Named concurrent branches. Keys are stable branch identifiers;
   * values are sequence nodes that run in parallel.
   */
  branches: z.record(
    z.string().min(1),
    z.lazy((): z.ZodType<WorkflowSequenceNode> => WorkflowSequenceNodeSchema),
  ),
});

export type WorkflowParallelNode = z.infer<typeof WorkflowParallelNodeSchema>;

// ─────────────────────────────────────────────────────────────
// Gate Node
// ─────────────────────────────────────────────────────────────

/**
 * Gate node — pauses workflow execution awaiting human or automated approval.
 *
 * When the gate opens, the runtime emits a `gate.suspended` event and blocks
 * until the gate is resolved (approved or rejected) or the timeout fires.
 */
export const WorkflowGateNodeSchema = WorkflowNodeBaseSchema.extend({
  /** Node type discriminant. */
  type: z.literal('gate'),
  /**
   * Message shown to the reviewer in the approval dialog.
   * Supports `{{ }}` template interpolation for dynamic content.
   */
  prompt: z.string().min(1),
  /**
   * Optional title for the approval dialog.
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
   * Timeout in milliseconds before `autoAction` fires.
   * `null` blocks indefinitely (no timeout).
   */
  timeoutMs: z.number().int().positive().nullable(),
  /**
   * JSON Schema for the resume data payload submitted when the gate is approved.
   * Validated against the schema before the workflow continues.
   */
  resumeSchema: JsonSchemaRecordSchema.optional(),
});

export type WorkflowGateNode = z.infer<typeof WorkflowGateNodeSchema>;

// ─────────────────────────────────────────────────────────────
// Iterate Node
// ─────────────────────────────────────────────────────────────

/**
 * Iterate node — fan-out execution over a collection, then fan-in.
 *
 * The `collection` expression resolves to an array at runtime. The `body`
 * sequence is instantiated once per item and all instances run concurrently
 * (up to `concurrency` in parallel at any time).
 *
 * Fan-in occurs when all item executions settle; downstream nodes receive
 * an array of outputs in collection order.
 */
export const WorkflowIterateNodeSchema = WorkflowNodeBaseSchema.extend({
  /** Node type discriminant. */
  type: z.literal('iterate'),
  /**
   * jexl expression that resolves to an array at runtime.
   * Each element becomes the `item` context for one body execution.
   */
  collection: z.string().min(1),
  /**
   * The sequence node executed once per collection item.
   * Item context is available as `ctx.item` and `ctx.index`.
   */
  body: z.lazy((): z.ZodType<WorkflowSequenceNode> => WorkflowSequenceNodeSchema),
  /**
   * Maximum number of concurrent item executions.
   * `0` or absent means unlimited concurrency.
   */
  concurrency: z.number().int().nonnegative().optional(),
});

export type WorkflowIterateNode = z.infer<typeof WorkflowIterateNodeSchema>;

// ─────────────────────────────────────────────────────────────
// Iterate-Chain Node
// ─────────────────────────────────────────────────────────────

/**
 * Iterate-chain node — sequential pipeline iteration over a collection.
 *
 * Similar to `iterate` but items are processed one at a time in order.
 * Each item execution receives the previous item's output as `ctx.previous`,
 * enabling accumulator/pipeline patterns.
 */
export const WorkflowIterateChainNodeSchema = WorkflowNodeBaseSchema.extend({
  /** Node type discriminant. */
  type: z.literal('iterate-chain'),
  /**
   * jexl expression that resolves to an array at runtime.
   */
  collection: z.string().min(1),
  /**
   * The sequence node executed once per collection item in order.
   * Context provides `ctx.item`, `ctx.index`, and `ctx.previous`
   * (the previous item's frame output, if any).
   */
  body: z.lazy((): z.ZodType<WorkflowSequenceNode> => WorkflowSequenceNodeSchema),
});

export type WorkflowIterateChainNode = z.infer<typeof WorkflowIterateChainNodeSchema>;

// ─────────────────────────────────────────────────────────────
// Loop Gate Outcome
// ─────────────────────────────────────────────────────────────

/**
 * Discriminated union of outcomes a loop gate handler may return.
 *
 * - `pass`     — exit the loop and continue downstream
 * - `loop`     — re-enter the loop body for another round
 * - `escalate` — pause the loop and raise a gate for human decision
 */
export const LoopGateOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pass') }).strict(),
  z.object({ kind: z.literal('loop') }).strict(),
  z.object({ kind: z.literal('escalate'), reason: z.string().min(1) }).strict(),
]);

export type LoopGateOutcome = z.infer<typeof LoopGateOutcomeSchema>;

// ─────────────────────────────────────────────────────────────
// Loop Node
// ─────────────────────────────────────────────────────────────

/**
 * Loop node — gated retry loop with a body sequence and convergence gate.
 *
 * Executes `body` up to `maxRounds` times. After each round, the `gate`
 * handler is evaluated. The handler returns a {@link LoopGateOutcome}:
 * `pass` exits the loop, `loop` re-enters the body, and `escalate`
 * suspends the loop and raises a human gate for decision.
 *
 * The `gate.escalation` block is optional; when present it configures the
 * suspended gate's prompt, resume schema, auto-action, and timeout.
 *
 * V1 does not support nested loops. Use {@link validateNoNestedLoops}
 * at authoring time to enforce this constraint.
 */
export const WorkflowLoopNodeSchema = WorkflowNodeBaseSchema.extend({
  /** Node type discriminant. */
  type: z.literal('loop'),
  /**
   * Maximum number of loop iterations before the gate forces escalation.
   * Must be a positive integer.
   */
  maxRounds: z.number().int().positive(),
  /**
   * The sequence node executed on each loop iteration.
   * Must be a `sequence` node; individual stations, delegates, etc.
   * are placed inside the body sequence.
   */
  body: z.lazy((): z.ZodType<WorkflowSequenceNode> => WorkflowSequenceNodeSchema),
  /**
   * Gate configuration evaluated after each body execution to determine
   * whether to loop, pass, or escalate.
   */
  gate: z
    .object({
      /**
       * Registered gate handler name resolved at runtime.
       * The handler receives gate input, config, and loop context.
       */
      handler: z.string().min(1),
      /**
       * Optional expression resolving to the gate handler's input value.
       * Typically a frame output reference like `'frames.aggregate.output'`.
       */
      input: z.string().min(1).optional(),
      /**
       * Optional static configuration forwarded to the gate handler.
       * Arbitrary JSON; the handler interprets its shape.
       */
      config: JsonValueSchema.optional(),
      /**
       * Optional escalation configuration for when the gate suspends the loop.
       * When present, the runtime creates a human gate with this configuration.
       */
      escalation: z
        .object({
          /** Title for the escalation gate dialog. */
          title: z.string().optional(),
          /** Prompt shown to the reviewer in the escalation gate. */
          prompt: z.string().min(1),
          /**
           * JSON Schema for the resume data payload submitted when
           * the escalation gate is resolved.
           */
          resumeSchema: JsonSchemaRecordSchema.optional(),
          /**
           * Action to take when the escalation timeout expires.
           * Defaults to `'reject'`.
           */
          autoAction: z.enum(['approve', 'reject']).default('reject'),
          /**
           * Timeout in milliseconds before `autoAction` fires.
           * `null` blocks indefinitely (no timeout). Defaults to `null`.
           */
          timeoutMs: z.number().int().positive().nullable().default(null),
        })
        .strict()
        .optional(),
    })
    .strict(),
});

export type WorkflowLoopNode = z.infer<typeof WorkflowLoopNodeSchema>;

// ─────────────────────────────────────────────────────────────
// Dynamic Region
// ─────────────────────────────────────────────────────────────

/**
 * Dynamic region descriptor — marks a subtree as factory-generated.
 *
 * When a workflow author uses a factory function to produce nodes at
 * authoring time, the factory result is materialized into the definition
 * as a concrete subtree. The `factoryId` links the materialized nodes
 * back to the factory registration for re-generation and UI tooling.
 *
 * `preview` is an optional snapshot of the expected node structure for
 * display in the visual editor before execution-time materialization.
 * It must not contain functions — the preview is purely for inspection.
 */
export const WorkflowDynamicRegionSchema = z.object({
  /**
   * Stable factory identifier registered in the workflow builder.
   * Used by the runtime to look up the factory and re-materialize nodes
   * when the definition is re-evaluated.
   */
  factoryId: z.string().min(1),
  /**
   * Optional preview of the expected node structure for UI display.
   * Must be JSON-safe; no functions or runtime-only values.
   */
  preview: z.array(z.lazy((): z.ZodType<WorkflowNode> => WorkflowNodeSchema)).optional(),
  /**
   * Authoring-time source location of the factory call.
   * Used for diagnostic messages and editor navigation.
   */
  sourceLocation: WorkflowSourceLocationSchema.optional(),
});

export type WorkflowDynamicRegion = z.infer<typeof WorkflowDynamicRegionSchema>;

// ─────────────────────────────────────────────────────────────
// Workflow Definition Provenance
// ─────────────────────────────────────────────────────────────

/**
 * Provenance descriptor tracking how and where a workflow definition originated.
 *
 * Discriminated on `kind`:
 * - `editor`:    created or last modified in the local workflow editor
 * - `extension`: synced from an extension-managed external source (e.g. a git
 *   repository managed by a product extension)
 *
 * Framework code must not inspect extension-specific `metadata` keys; those
 * are opaque to the engine and are consumed only by the originating extension.
 */
export const WorkflowDefinitionProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('editor') }).strict(),
  z
    .object({
      kind: z.literal('extension'),
      /**
       * Identifier of the extension that owns this definition.
       * Matches the extension's registered `id` in the manifest.
       */
      extension: z.string().min(1),
      /**
       * Opaque external identifier assigned by the extension.
       * Typically encodes enough context to re-locate the source (e.g. a
       * `owner/repo:path` string for a VCS-backed extension).
       */
      externalId: z.string().min(1).optional(),
      /**
       * ISO-8601 timestamp of the last successful sync from the external source.
       */
      syncedAt: z.string().datetime().optional(),
      /**
       * Extension-specific metadata forwarded verbatim during sync.
       * The engine stores and retrieves this opaquely; only the originating
       * extension interprets its contents.
       */
      metadata: JsonObjectContractSchema.default({}),
    })
    .strict(),
]);

export type WorkflowDefinitionProvenance = z.infer<typeof WorkflowDefinitionProvenanceSchema>;

// ─────────────────────────────────────────────────────────────
// Workflow State Definition
// ─────────────────────────────────────────────────────────────

/**
 * Optional state contract declared on a workflow definition.
 *
 * When present, the workflow engine initializes run-scoped mutable state
 * at execution start and exposes it to station handlers via `ctx.state`.
 * State is runtime-owned execution data — persisted as a current snapshot
 * plus an append-only mutation log, never through the artifact store.
 * Keep state as small run working memory; large context, evidence, and
 * durable domain outputs belong in context providers or artifact storage.
 */
export const WorkflowStateDefinitionSchema = z.object({
  /** JSON Schema describing the shape of the workflow's run state. */
  schema: JsonSchemaRecordSchema,
  /** Initial state value applied when an execution starts. */
  initial: JsonValueSchema.optional(),
});

/** Inferred type for {@link WorkflowStateDefinitionSchema}. */
export type WorkflowStateDefinition = z.infer<typeof WorkflowStateDefinitionSchema>;

/** Mirror of `WorkflowWorkerSourceSchema` (inline to avoid circular import with `worker.ts`). */
const ExecutableSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('source'), filename: z.string().min(1), source: z.string() }).strict(),
  z.object({ kind: z.literal('definition'), workflowId: z.string().min(1) }).strict(),
]);

// ─────────────────────────────────────────────────────────────
// Workflow Definition (stored entity)
// ─────────────────────────────────────────────────────────────

/**
 * Persisted workflow definition in the pipeline-primitive model.
 *
 * The `root` field replaces the old flat `steps` DAG with a structured
 * `WorkflowSequenceNode` tree. All node schemas are function-free and
 * JSON-serializable so definitions can be stored, transferred over the bus,
 * and displayed in the visual editor without runtime coupling.
 *
 * `inputSchema`, `configSchema`, and `outputSchema` are JSON Schema documents
 * (validated by {@link JsonSchemaRecordSchema}) for type-safe parameterization
 * and output contracts.
 */
export const WorkflowDefinitionSchema = z.object({
  /** Unique workflow identifier. */
  id: z.string().min(1),
  /** Human-readable workflow name. */
  name: z.string().optional(),
  /** Human-readable description of what this workflow does. */
  description: z.string().optional(),
  /**
   * JSON Schema for the workflow's input parameters.
   * Validated at execution start; available as `ctx.inputs` during execution.
   */
  inputSchema: JsonSchemaRecordSchema.optional(),
  /**
   * JSON Schema for static workflow configuration.
   * Configuration values are resolved once at workflow load time.
   */
  configSchema: JsonSchemaRecordSchema.optional(),
  /**
   * JSON Schema for the workflow's primary output.
   * Validated when the root sequence completes.
   */
  outputSchema: JsonSchemaRecordSchema.optional(),
  /**
   * Optional state contract for run-scoped mutable state.
   *
   * When present, the workflow engine initializes the declared state at
   * execution start and exposes it to station handlers via `ctx.state`.
   * The `schema` field describes the shape; `initial` provides the
   * starting value. Keep payloads small; this is not a large context or
   * artifact storage channel.
   */
  state: WorkflowStateDefinitionSchema.optional(),
  /**
   * Primary artifact binding for this workflow.
   * When set, the workflow's output is associated with an artifact kind and scope.
   */
  artifact: WorkflowArtifactBindingSchema.optional(),
  /**
   * Root sequence node containing the full pipeline topology.
   * Replaces the old flat `steps` DAG with a structured node tree.
   */
  root: WorkflowSequenceNodeSchema,
  /**
   * Automation trigger bindings for this workflow.
   *
   * Multiple bindings may fire independently; one execution is created per
   * firing binding. An empty or omitted list means the workflow is only started
   * directly — direct invocation is an invocation mode, not a trigger type.
   */
  triggers: z.array(WorkflowAutomationTriggerBindingSchema).optional(),
  /**
   * Scope this workflow definition is bound to.
   * Use `{ type: 'global' }` for framework-wide workflow definitions.
   */
  scope: WorkflowExecutionScopeSchema.default({ type: 'global' }),
  /**
   * Canvas layout hints for the visual editor.
   * Stored as an opaque JSON record; ignored by the executor.
   */
  canvasLayout: z.record(z.string(), JsonValueSchema).optional(),
  /**
   * Provenance record tracking how and where this workflow definition originated.
   *
   * When `source.kind === 'extension'`, the workflow was synced by an extension
   * and must be treated as read-only by the editor. The runtime executes the
   * materialized definition regardless of its provenance.
   *
   * Absent on locally-authored definitions.
   */
  source: WorkflowDefinitionProvenanceSchema.optional(),
  /** Portable executable source for worker dispatch (see `ExecutableSourceSchema`). */
  executableSource: ExecutableSourceSchema.optional(),
  /** Resource requirements for WorkerNode provider selection. */
  requirements: WorkerNodeRequirementsSchema.optional(),
  /**
   * Framework finalizer selected by the compiled workflow definition after a
   * successful execution. This immutable definition-owned selector cannot be
   * overridden by execution callers or dispatch metadata.
   */
  successFinalizerId: WorkflowFinalizerIdSchema.optional(),
});

/**
 * Workflow definition stored in the database.
 * `root` is typed via `z.infer` which resolves `WorkflowSequenceNode` correctly
 * through the `z.lazy` boundary using the declared interface.
 */
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// ─────────────────────────────────────────────────────────────
// Execution State (runtime)
// ─────────────────────────────────────────────────────────────

/**
 * Execution status of a workflow.
 */
export const ExecutionStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'finalizing',
  'completed',
  'failed',
  'cancelled',
]);

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
  /** Bound input value for this execution. */
  inputs: JsonValueSchema,
  /** Bound workflow configuration values for this execution. */
  config: JsonObjectContractSchema.optional(),
  /** Execution start timestamp. */
  startedAt: z.number(),
  /** Execution completion timestamp. */
  completedAt: z.number().optional(),
  /** Error message if execution failed. */
  error: z.string().optional(),
  /** Cancellation reason if execution was cancelled. */
  reason: z.string().optional(),
  /**
   * Payload from the firing trigger.
   * Present when triggered by cron, webhook, or plugin event.
   * Absent for manual starts.
   */
  triggerPayload: JsonObjectContractSchema.optional(),
  /**
   * Scope this execution is bound to.
   * Inherited from the workflow definition at start time, or overridden
   * by the caller via the `start` bus subject.
   */
  scope: WorkflowExecutionScopeSchema,
  /**
   * Artifact this execution is bound to, when the starter supplied one.
   * Mirrors the `artifactRef` accepted by the `start` subject.
   */
  artifactRef: WorkflowArtifactRefSchema.optional(),
});

export type WorkflowExecution = z.infer<typeof WorkflowExecutionSchema>;

// ─────────────────────────────────────────────────────────────
// Frame State (execution frame per node)
// ─────────────────────────────────────────────────────────────

/**
 * Runtime state of a single execution frame.
 *
 * Each node in the pipeline tree gets a frame per execution pass. Nested
 * nodes (sequence, parallel, iterate) create child frames. The `path` field
 * encodes the frame's position in the tree for log correlation and UI display.
 */
export const WorkflowFrameStateSchema = z.object({
  /** Unique frame identifier within the execution. */
  frameId: z.string(),
  /** Node identifier this frame corresponds to. */
  nodeId: z.string(),
  /** Node type discriminant for routing and display. */
  nodeType: WorkflowNodeTypeSchema,
  /**
   * Ordered path of frame IDs from the root frame to this frame (inclusive).
   * Used for tree traversal, log correlation, and UI breadcrumb display.
   */
  path: z.array(z.string()),
  /** Parent frame ID. Absent for the root frame. */
  parentFrameId: z.string().optional(),
  /** Current frame execution status. */
  status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled']),
  /**
   * Number of execution attempts for this frame (zero-based).
   * Incremented each time the frame is retried after failure.
   */
  attempt: z.number().int().nonnegative().default(0),
  /**
   * Zero-based iteration index when this frame belongs to an `iterate` or
   * `iterate-chain` expansion. Absent for non-iteration frames.
   */
  iteration: z.number().int().nonnegative().optional(),
  /**
   * Branch key when this frame is a child of a `parallel` node.
   * Matches a key in `WorkflowParallelNode.branches`.
   */
  branchKey: z.string().optional(),
  /** JSON-serializable output produced by the node on completion. */
  output: JsonValueSchema.optional(),
  /** Human-readable error message when `status` is `'failed'`. */
  error: z.string().optional(),
  /** Epoch milliseconds when the frame started executing. */
  startedAt: z.number().optional(),
  /** Epoch milliseconds when the frame reached a terminal status. */
  completedAt: z.number().optional(),
});

export type WorkflowFrameState = z.infer<typeof WorkflowFrameStateSchema>;

// ─────────────────────────────────────────────────────────────
// Gate Instance State
// ─────────────────────────────────────────────────────────────

/** Gate instance status values. */
export const WorkflowGateStatusSchema = z.enum(['waiting', 'resumed', 'rejected', 'timed-out', 'cancelled']);

export type WorkflowGateStatus = z.infer<typeof WorkflowGateStatusSchema>;

/**
 * Persisted state of a gate node instance.
 *
 * Created when a gate node is entered, updated when the gate is resolved,
 * timed out, or cancelled. Stored independently of frame state so the
 * gate service can query open gates without scanning the full frame tree.
 */
export const WorkflowGateInstanceSchema = z.object({
  /** Execution this gate belongs to. */
  executionId: z.string(),
  /** Node ID of the gate in the workflow definition. */
  nodeId: z.string(),
  /** Frame ID of the gate's execution frame. */
  frameId: z.string(),
  /**
   * JSON Schema describing the expected resume data payload.
   * Callers must satisfy this schema when responding to the gate.
   */
  schema: JsonSchemaRecordSchema,
  /**
   * Optional prompt shown to the reviewer in the approval UI.
   * Populated from the gate node's `prompt` field after template interpolation.
   */
  prompt: z.string().optional(),
  /** Current gate status. */
  status: WorkflowGateStatusSchema,
  /** Effective timeout action captured when the gate opened. */
  autoAction: z.enum(['approve', 'reject']),
  /** Effective timeout in milliseconds captured when the gate opened; `null` blocks indefinitely. */
  timeoutMs: z.number().int().positive().nullable(),
  /** JSON-serializable resume data submitted by the approver. */
  resumeData: JsonValueSchema.optional(),
  /** Human-readable rationale supplied by the responder when settling the gate. */
  reason: z.string().optional(),
  /** Epoch milliseconds when the gate was created (node entered). */
  createdAt: z.number(),
  /** Epoch milliseconds when the gate left the `waiting` status. */
  resolvedAt: z.number().optional(),
});

export type WorkflowGateInstance = z.infer<typeof WorkflowGateInstanceSchema>;

// ─────────────────────────────────────────────────────────────
// Resolved Role (for delegate nodes)
// ─────────────────────────────────────────────────────────────

/**
 * Resolved role configuration returned by the `workflow.resolveRole` RPC.
 *
 * When a workflow node specifies a `role` instead of explicit adapter/model
 * fields, the executor resolves the role via the bus before spawning the
 * subagent. The resolved payload provides the full adapter configuration
 * for execution.
 */
export const WorkflowResolvedRoleSchema = z.object({
  /** Adapter name to use for execution (e.g., 'claudeCode', 'openai'). */
  adapterName: z.string().min(1),
  /** Provider configuration selected for this role's execution. */
  providerConfigId: z.string().min(1).optional(),
  /** Model override for the resolved role. */
  model: z.string().optional(),
  /** Reasoning effort override for supporting adapters. */
  reasoningEffort: AIReasoningLevelSchema.optional(),
  /** Harness ID for per-role tool governance. */
  harnessId: z.string().optional(),
  /** System prompt to prepend for this role. */
  systemPrompt: z.string().optional(),
  /** Context mode for the subagent session. */
  contextMode: ContextModeSchema.optional(),
  /** Provider context for credential and endpoint resolution. */
  providerContext: ProviderContextSchema.optional(),
  /** Per-call adapter-specific configuration. */
  adapterConfig: JsonObjectContractSchema.optional(),
  /** Tool allowlist for the resolved role. */
  tools: z.array(z.string()).optional(),
  /** Additional tools to block for the resolved role. */
  disallowedTools: z.array(z.string()).optional(),
  /** Directory allowlist for adapters that enforce filesystem boundaries. */
  allowedDirectories: z.array(z.string()).optional(),
  /**
   * Subagent completion mode forwarded from the workflow node.
   * `'tool'` (default) waits for `completeTask`; `'turn'` completes on
   * first turn end.
   */
  completion: CompletionModeSchema.optional(),
});

export type WorkflowResolvedRole = z.infer<typeof WorkflowResolvedRoleSchema>;

/**
 * Resolved explicit agent configuration returned by the `workflow.resolveAgent`
 * RPC.
 *
 * The payload intentionally matches {@link WorkflowResolvedRoleSchema}: explicit
 * agent and role references both resolve to the adapter/subagent configuration
 * the workflow runtime needs, while preserving distinct registry seams.
 */
export const WorkflowResolvedAgentSchema = WorkflowResolvedRoleSchema;

export type WorkflowResolvedAgent = WorkflowResolvedRole;

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
 * At least one of `workflowId`, `scope`, or `artifactRef` is required to avoid
 * unbounded scans. Results are ordered by `startedAt desc, id desc` and always
 * limited.
 */
export const ExecutionListQuerySchema = z
  .object({
    /** Filter by workflow ID. */
    workflowId: z.string().min(1).optional(),
    /** Filter by execution scope. */
    scope: WorkflowExecutionScopeSchema.optional(),
    /** Filter by execution status. */
    status: ExecutionStatusSchema.optional(),
    /** Filter by bound artifact reference (exact kind + id match). */
    artifactRef: WorkflowArtifactRefSchema.optional(),
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
  .refine((query) => query.workflowId !== undefined || query.scope !== undefined || query.artifactRef !== undefined, {
    message: 'Either workflowId, scope, or artifactRef is required.',
  });

export type ExecutionListQuery = z.infer<typeof ExecutionListQuerySchema>;

// ── Batch execution lookup by artifact refs ──────────────────

/** Maximum number of artifact refs accepted per batch request. */
export const EXECUTIONS_BY_ARTIFACT_REFS_MAX_REFS = 200;

/** Maximum per-ref execution limit in a batch request. */
export const EXECUTIONS_BY_ARTIFACT_REFS_MAX_LIMIT_PER_REF = 100;

/** Default per-ref execution limit when callers omit `limitPerRef`. */
export const EXECUTIONS_BY_ARTIFACT_REFS_DEFAULT_LIMIT_PER_REF = 10;

/**
 * Query parameters for batch-fetching executions grouped by artifact reference.
 *
 * Each ref is queried independently against the artifact index. Results are
 * keyed by the canonical `"kind:id"` serialization (see {@link serializeArtifactRef}).
 * Refs that match no executions are omitted from the response record.
 *
 * Failure semantics are all-or-nothing: individual refs cannot fail independently
 * since each is a simple indexed lookup — a DB-level error would affect the
 * entire request.
 */
export const ExecutionsByArtifactRefsQuerySchema = z.object({
  /** Artifact references to look up. */
  refs: z.array(WorkflowArtifactRefSchema).min(1).max(EXECUTIONS_BY_ARTIFACT_REFS_MAX_REFS),
  /** Maximum executions to return per ref. Defaults to 10, max 100. */
  limitPerRef: z
    .number()
    .int()
    .min(EXECUTION_LIST_MIN_LIMIT)
    .max(EXECUTIONS_BY_ARTIFACT_REFS_MAX_LIMIT_PER_REF)
    .default(EXECUTIONS_BY_ARTIFACT_REFS_DEFAULT_LIMIT_PER_REF),
});

export type ExecutionsByArtifactRefsQuery = z.infer<typeof ExecutionsByArtifactRefsQuerySchema>;

/**
 * Query parameters for listing gate instances.
 *
 * At least one of `executionId` or `status` is required to avoid unbounded
 * scans. Results are ordered by `createdAt desc, id desc` and always limited.
 */
export const GateInstanceListQuerySchema = z
  .object({
    /** Filter by owning execution. */
    executionId: z.string().min(1).optional(),
    /** Filter by gate status (e.g. `'waiting'` for an approval inbox). */
    status: WorkflowGateStatusSchema.optional(),
    /** Maximum number of gates to return. Defaults to 50, max 500. */
    limit: z
      .number()
      .int()
      .min(EXECUTION_LIST_MIN_LIMIT)
      .max(EXECUTION_LIST_MAX_LIMIT)
      .default(EXECUTION_LIST_DEFAULT_LIMIT),
  })
  .refine((query) => query.executionId !== undefined || query.status !== undefined, {
    message: 'Either executionId or status is required.',
  });

export type GateInstanceListQuery = z.infer<typeof GateInstanceListQuerySchema>;
