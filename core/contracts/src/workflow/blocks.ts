import type { z } from 'zod';
import type { JsonValue } from '../shared/json-value.js';

/**
 * Serializable run mapping for bus-request step execution.
 *
 * Emitted by the builder when the step block is compiled into a workflow
 * definition. The `config` and `input` roots in the payload are resolved
 * against the builder form values and upstream step outputs respectively.
 */
export interface BusRequestWorkflowStepBlockRun {
  /** Run mapping discriminant. */
  readonly type: 'bus-request';
  /** Full request subject string compiled into the workflow step. */
  readonly subject: string;
  /**
   * Payload template.
   * `config` and `input` roots are resolved by the builder when compiling the
   * step into a concrete {@link BusRequestWorkflowStep}.
   */
  readonly payload?: Record<string, JsonValue>;
  /** Request timeout in milliseconds forwarded to the compiled step. */
  readonly timeoutMs?: number;
}

/**
 * Discriminated union of all supported workflow step block run mappings.
 *
 * Each variant maps a declared step block to a concrete execution mechanism.
 * Extend this union when new execution strategies are introduced.
 */
export type WorkflowStepBlockRun = BusRequestWorkflowStepBlockRun;

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
  /** Concrete execution mapping compiled into the workflow definition by the builder. */
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
 * catalog rendering.
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
  /** Concrete execution mapping preserved verbatim from the block declaration. */
  runs: WorkflowStepBlockRun;
}
