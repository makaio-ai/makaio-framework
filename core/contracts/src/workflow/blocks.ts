import type { z } from 'zod';
import type { JsonValue } from '../shared/json-value.js';

/**
 * JSON Schema document used for `outputSchema` fields on step block run mappings.
 *
 * A JSON Schema document is a JSON object (`Record<string, JsonValue>`). Using
 * the inferred type from {@link JsonSchemaRecordSchema} keeps this type consistent
 * with the schema validator used in persisted workflow node definitions.
 */
type JsonSchemaRecord = Record<string, JsonValue>;

// ─────────────────────────────────────────────────────────────
// Step Block Run Mappings — primitive node compilation targets
// ─────────────────────────────────────────────────────────────

/**
 * Step block run mapping that compiles into a `station` primitive node.
 *
 * A station node is an atomic work unit executed by an AI agent or registered
 * runtime handler. The `prompt` is a template evaluated against the builder
 * form values; the optional `role` selects the executor role.
 */
export interface StationNodeBlockRun {
  /** Run mapping discriminant. */
  readonly type: 'station';
  /**
   * Task prompt template compiled into the station node.
   * Supports `{{ config.<field> }}` and `{{ input.<field> }}` interpolation.
   */
  readonly prompt: string;
  /**
   * Named role reference forwarded to the compiled station node.
   * Resolved via the bus `resolveRole` RPC before execution.
   */
  readonly role?: string;
  /**
   * JSON Schema for the expected station output.
   * Forwarded verbatim to the compiled station node's `outputSchema` field.
   */
  readonly outputSchema?: JsonSchemaRecord;
  /**
   * Positive timeout in milliseconds forwarded to the compiled station node.
   * Defaults to 300 000 ms at execution time when omitted.
   */
  readonly timeoutMs?: number;
}

/**
 * Step block run mapping that compiles into a `delegate-agent` primitive node.
 *
 * The `agentId` references a registered agent definition. The block builder
 * resolves `inputExpression` against the configured form values when compiling
 * the node.
 */
export interface DelegateAgentNodeBlockRun {
  /** Run mapping discriminant. */
  readonly type: 'delegate-agent';
  /**
   * Identifier of the registered agent definition to invoke.
   */
  readonly agentId: string;
  /**
   * jexl expression template resolving to the agent input payload.
   * Supports `{{ config.<field> }}` and `{{ input.<field> }}` interpolation
   * that the builder resolves when compiling into a concrete node.
   */
  readonly inputExpression?: string;
  /**
   * JSON Schema for the expected agent output.
   * Forwarded verbatim to the compiled node's `outputSchema` field.
   */
  readonly outputSchema?: JsonSchemaRecord;
  /** Exact tool allowlist selected for this delegation. */
  readonly allowedTools?: string[];
  /** Authority-owned finalizer applied to the successful delegate result. */
  readonly resultFinalizerId?: string;
}

/**
 * Step block run mapping that compiles into a `delegate-role` primitive node.
 *
 * The `role` is a product-resolved named executor. The `prompt` template is
 * evaluated against the builder form values when compiling the node.
 */
export interface DelegateRoleNodeBlockRun {
  /** Run mapping discriminant. */
  readonly type: 'delegate-role';
  /**
   * Named role reference resolved via the bus `resolveRole` RPC at execution time.
   */
  readonly role: string;
  /**
   * Task prompt template forwarded to the compiled node.
   * Supports `{{ config.<field> }}` and `{{ input.<field> }}` interpolation.
   */
  readonly prompt: string;
  /**
   * JSON Schema for the expected delegation output.
   * Forwarded verbatim to the compiled node's `outputSchema` field.
   */
  readonly outputSchema?: JsonSchemaRecord;
  /** Exact tool allowlist selected for this delegation. */
  readonly allowedTools?: string[];
  /** Authority-owned finalizer applied to the successful delegate result. */
  readonly resultFinalizerId?: string;
  /**
   * Positive timeout in milliseconds forwarded to the compiled node.
   * Defaults to 300 000 ms at execution time when omitted.
   */
  readonly timeoutMs?: number;
}

/**
 * Discriminated union of all supported workflow step block run mappings.
 *
 * Each variant maps a declared step block to a concrete primitive node type.
 * The builder compiles the selected variant into the workflow definition as the
 * corresponding {@link WorkflowNode} subtype when the block is placed in the canvas.
 *
 * Extend this union when new primitive node types require builder support.
 */
export type WorkflowStepBlockRun = StationNodeBlockRun | DelegateAgentNodeBlockRun | DelegateRoleNodeBlockRun;

// ─────────────────────────────────────────────────────────────
// Block Metadata and Collection Types
// ─────────────────────────────────────────────────────────────

/**
 * Metadata shared by all workflow blocks.
 */
export interface WorkflowBlockMetadata {
  /** Stable identifier, namespaced by extension (e.g., 'coderabbit.review-posted'). */
  name: string;
  /** Human-readable label for the builder UI. */
  label: string;
  /** Short description for tooltips and catalog. */
  description: string;
  /** Grouping tags for the builder palette. Uncategorized blocks appear in "Other". */
  categories?: string[];
}

/**
 * A trigger block declaration — determines WHEN a workflow starts.
 * @typeParam TConfig - Zod shape for the builder configuration form.
 * @typeParam TOutput - Zod type for the payload passed into the workflow as input.
 */
export interface WorkflowTriggerBlock<
  TConfig extends z.ZodRawShape = z.ZodRawShape,
  TOutput extends z.ZodType = z.ZodType,
> {
  /** Shared metadata used in the builder palette and catalog. */
  metadata: WorkflowBlockMetadata;
  /** Drives the configuration form in the builder UI. */
  configSchema: z.ZodObject<TConfig>;
  /** The payload shape passed into the workflow when this trigger fires. */
  outputSchema: TOutput;
}

/**
 * A step block declaration — determines WHAT happens inside a workflow.
 *
 * The `runs` field specifies which primitive node type this block compiles to
 * when placed in the workflow canvas. The builder reads `runs` to construct a
 * concrete {@link WorkflowNode} (station, delegate-agent, or delegate-role) for
 * the persisted workflow definition.
 * @typeParam TConfig - Zod shape for the builder configuration form.
 * @typeParam TInput - Zod type for what this step expects from upstream.
 * @typeParam TOutput - Zod type for what downstream steps can reference.
 */
export interface WorkflowStepBlock<
  TConfig extends z.ZodRawShape = z.ZodRawShape,
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  /** Shared metadata used in the builder palette and catalog. */
  metadata: WorkflowBlockMetadata;
  /** Drives the configuration form in the builder UI. */
  configSchema: z.ZodObject<TConfig>;
  /** What this step expects from upstream (expressions/config). */
  inputSchema: TInput;
  /** What downstream steps can reference via steps.<id>.result. */
  outputSchema: TOutput;
  /**
   * Primitive node compilation target for this step block.
   *
   * The builder reads this field and constructs the corresponding primitive
   * node ({@link WorkflowStationNode}, {@link WorkflowDelegateAgentNode}, or
   * {@link WorkflowDelegateRoleNode}) when the block is placed on the canvas.
   */
  runs: WorkflowStepBlockRun;
}

/**
 * Collection of workflow blocks contributed by an extension.
 */
export interface WorkflowBlockCollection {
  /** Trigger block declarations — each determines WHEN a workflow starts. */
  readonly triggers?: readonly WorkflowTriggerBlock[];
  /** Step block declarations — each determines WHAT happens inside a workflow. */
  readonly steps?: readonly WorkflowStepBlock[];
}

// ─────────────────────────────────────────────────────────────
// Registered Block Shapes (serialized catalog entries)
// ─────────────────────────────────────────────────────────────

/**
 * Serialized trigger block as stored in the registry and served via bus.
 *
 * Schema fields are stored as JSON Schema objects for transport and builder
 * catalog rendering.
 */
export interface RegisteredTriggerBlock {
  /** Trigger metadata combined with the owning extension name. */
  metadata: WorkflowBlockMetadata & { extensionName: string };
  /** JSON Schema representation of the builder configuration form. */
  configSchema: Record<string, unknown>;
  /** JSON Schema representation of the trigger output payload. */
  outputSchema: Record<string, unknown>;
}

/**
 * Serialized step block as stored in the registry and served via bus.
 *
 * Schema fields are stored as JSON Schema objects for transport and builder
 * catalog rendering. The `runs` field is preserved verbatim from the block
 * declaration so the builder can construct the target primitive node directly.
 */
export interface RegisteredStepBlock {
  /** Step metadata combined with the owning extension name. */
  metadata: WorkflowBlockMetadata & { extensionName: string };
  /** JSON Schema representation of the builder configuration form. */
  configSchema: Record<string, unknown>;
  /** JSON Schema representation of the expected upstream input. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema representation of what downstream steps can reference. */
  outputSchema: Record<string, unknown>;
  /**
   * Primitive node compilation target preserved verbatim from the block declaration.
   * The builder uses this to construct the appropriate primitive node when
   * placing the block on the canvas.
   */
  runs: WorkflowStepBlockRun;
}
