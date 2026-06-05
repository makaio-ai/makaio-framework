import { z } from 'zod';
import type { JsonValue } from '../shared/json-value.js';
import type { WorkflowArtifactBinding, WorkflowDefinition, WorkflowNode, WorkflowSourceLocation } from './schemas.js';
import type { IterateHandler, StationHandler, StepContext } from './authoring-context.js';
import type { WorkflowTriggerDef } from './authoring-triggers.js';

// ─────────────────────────────────────────────────────────────
// Node Options and Configuration Types
// ─────────────────────────────────────────────────────────────

/**
 * Common per-node options shared by all fluent builder node methods.
 */
export interface NodeOptions {
  /**
   * jexl expression evaluated at runtime.
   * When present and falsy, the node and its subtree are skipped.
   */
  readonly when?: string;
  /**
   * jexl expression evaluated at runtime.
   * When present and truthy, the node is skipped without propagating failure.
   */
  readonly skip?: string;
}

/**
 * Configuration for a delegate-agent node created via the fluent builder.
 */
export interface AgentConfig {
  /** Identifier of the registered agent definition to invoke. */
  readonly agentId: string;
  /**
   * jexl expression resolving to the agent input payload.
   * When omitted the agent receives the full execution context.
   */
  readonly inputExpression?: string;
  /**
   * JSON Schema for the expected agent output.
   */
  readonly outputSchema?: Record<string, JsonValue>;
}

/**
 * Options for gate nodes, including the required resume schema.
 */
export interface GateOptions {
  /**
   * Message shown to the reviewer in the approval dialog.
   * Supports `{{ }}` template interpolation.
   */
  readonly prompt: string;
  /** Optional title for the approval dialog. */
  readonly title?: string;
  /**
   * Action to take when the timeout expires.
   * - `'approve'`: auto-approve and continue
   * - `'reject'`: auto-reject and fail
   */
  readonly autoAction: 'approve' | 'reject';
  /**
   * Timeout in milliseconds before `autoAction` fires.
   * `null` blocks indefinitely.
   */
  readonly timeoutMs: number | null;
  /**
   * Zod schema for the resume data payload.
   * Captured in `zodSchemas.gates[id]`; the JSON Schema equivalent goes in
   * the node's `resumeSchema` field.
   */
  readonly resume?: z.ZodTypeAny;
}

/**
 * Options for iterate and iterate-chain nodes.
 */
export interface IterateOptions {
  /**
   * jexl expression that resolves to an array at runtime.
   */
  readonly collection: string;
  /**
   * Maximum number of concurrent item executions (iterate only).
   * `0` or absent means unlimited concurrency.
   */
  readonly concurrency?: number;
  /** Common node conditions. */
  readonly when?: string;
  /** Common node skip condition. */
  readonly skip?: string;
}

/**
 * Parallel node execution mode.
 *
 * - `'all-settled'`: wait for all branches to settle (complete or fail)
 * - `'fail-fast'`: fail the node as soon as one branch fails
 */
export type ParallelMode = 'all-settled' | 'fail-fast';

/**
 * Options for parallel nodes created via the fluent builder.
 */
export interface ParallelOptions {
  /** Execution mode controlling when the parallel node resolves. */
  readonly mode?: ParallelMode;
  /** Common node conditions. */
  readonly when?: string;
  /** Common node skip condition. */
  readonly skip?: string;
}

// ─────────────────────────────────────────────────────────────
// Artifact binding options (builder-level)
// ─────────────────────────────────────────────────────────────

/**
 * Options accepted by the fluent `.artifact()` builder method.
 *
 * Extends {@link WorkflowArtifactBinding} with an optional Zod schema that
 * is captured in `zodSchemas.artifact` for runtime validation.
 */
export interface ArtifactBindingOptions {
  /** Artifact kind string (e.g. `'implementation-review'`). */
  readonly kind: string;
  /** Schema version validated by the artifact service. */
  readonly schemaVersion: string;
  /** Scope at which the artifact is stored. */
  readonly scope: WorkflowArtifactBinding['scope'];
  /** Optional Zod schema for the artifact data payload. */
  readonly schema?: z.ZodTypeAny;
  /**
   * Optional jexl expression to resolve the artifact scope dynamically at runtime.
   */
  readonly resolve?: string;
  /**
   * Optional jexl expression to create an artifact revision at runtime.
   */
  readonly create?: string;
  /**
   * Optional jexl path expression pointing to a status field within the artifact.
   */
  readonly statusPath?: string;
}

// ─────────────────────────────────────────────────────────────
// Zod Schema Container
// ─────────────────────────────────────────────────────────────

/**
 * Container for all Zod schemas kept out of the serializable `definition`.
 *
 * Schemas in this object are used for runtime validation and type inference.
 * Their JSON Schema equivalents are stored in the corresponding
 * `definition.inputSchema`, `definition.outputSchema`, etc. fields.
 */
export interface WorkflowZodSchemas {
  /** Zod schema for the workflow's input parameters. */
  readonly input?: z.ZodTypeAny;
  /** Zod schema for the workflow's configuration values. */
  readonly config?: z.ZodTypeAny;
  /** Zod schema for the workflow's primary output. */
  readonly output?: z.ZodTypeAny;
  /** Zod schema for the workflow's primary artifact data. */
  readonly artifact?: z.ZodTypeAny;
  /** Gate resume schemas keyed by gate node ID. */
  readonly gates: Record<string, z.ZodTypeAny>;
}

// ─────────────────────────────────────────────────────────────
// Built Workflow Return Type
// ─────────────────────────────────────────────────────────────

/**
 * The result of defining a workflow via the fluent builder.
 *
 * `definition` is fully serializable — it contains no functions.
 * Station handlers and dynamic factories are carried in the runtime maps,
 * which are consumed by the executor at runtime without persisting.
 */
export interface BuiltWorkflow {
  /** Unique workflow definition identifier. */
  readonly id: string;
  /**
   * Serializable workflow definition — safe to store, send over the bus,
   * and display in the UI. Contains no function bodies.
   */
  readonly definition: WorkflowDefinition;
  /**
   * Station handler functions keyed by node ID.
   * Populated by `.station()` calls and standalone `station()` factories.
   */
  readonly runtimeHandlers: ReadonlyMap<string, StationHandler>;
  /**
   * Dynamic region factory functions keyed by factory ID.
   * Empty while the v1 authoring surface exposes only static topology.
   */
  readonly runtimeFactories: ReadonlyMap<string, () => WorkflowNode[]>;
  /** Zod schemas extracted from the builder for runtime validation. */
  readonly zodSchemas: WorkflowZodSchemas;
  /** Optional authoring-time source metadata for diagnostics. */
  readonly source?: WorkflowSourceLocation;
}

// ─────────────────────────────────────────────────────────────
// defineWorkflow Options
// ─────────────────────────────────────────────────────────────

/**
 * Options accepted by {@link defineWorkflow} to configure workflow metadata.
 */
export interface DefineWorkflowOptions<
  TTriggers extends readonly WorkflowTriggerDef<unknown>[] | undefined = undefined,
> {
  /** Human-readable workflow name. */
  readonly name?: string;
  /** Human-readable description of what this workflow does. */
  readonly description?: string;
  /** Initial trigger set. Additional triggers can be added via `addTrigger`. */
  readonly triggers?: TTriggers;
}

// ─────────────────────────────────────────────────────────────
// Workflow Builder
// ─────────────────────────────────────────────────────────────

/**
 * A fluent workflow builder returned by {@link defineWorkflow}.
 *
 * Collects trigger definitions, Zod schemas, and typed station registrations,
 * then exposes the serializable `WorkflowDefinition` alongside runtime maps
 * for the worker executor.
 *
 * All fluent methods mutate internal state and return `this` so chains can be
 * composed freely. The builder also implements {@link BuiltWorkflow} so it can
 * be passed wherever a built workflow is expected without an explicit `.build()`
 * call.
 * @typeParam TTrigger - Trigger payload type (from the union of added triggers)
 */
export interface WorkflowBuilder<TTrigger = never> extends BuiltWorkflow {
  /**
   * Sets the workflow's input schema.
   *
   * The Zod schema is stored in `zodSchemas.input`; its JSON Schema equivalent
   * is written to `definition.inputSchema`.
   * @param schema - Zod schema describing the workflow's input parameters
   * @returns This builder for chaining
   */
  input(schema: z.ZodTypeAny): WorkflowBuilder<TTrigger>;
  /**
   * Sets the workflow's config schema.
   *
   * The Zod schema is stored in `zodSchemas.config`; its JSON Schema equivalent
   * is written to `definition.configSchema`.
   * @param schema - Zod schema describing the workflow's static configuration
   * @returns This builder for chaining
   */
  config(schema: z.ZodTypeAny): WorkflowBuilder<TTrigger>;
  /**
   * Sets the workflow's output schema.
   *
   * The Zod schema is stored in `zodSchemas.output`; its JSON Schema equivalent
   * is written to `definition.outputSchema`.
   * @param schema - Zod schema describing the workflow's primary output
   * @returns This builder for chaining
   */
  output(schema: z.ZodTypeAny): WorkflowBuilder<TTrigger>;
  /**
   * Binds a primary artifact to the workflow.
   *
   * The artifact Zod schema (if provided) is stored in `zodSchemas.artifact`;
   * the binding metadata is written to `definition.artifact`.
   * @param options - Artifact binding configuration
   * @returns This builder for chaining
   */
  artifact(options: ArtifactBindingOptions): WorkflowBuilder<TTrigger>;
  /**
   * Appends a station node to the root sequence and registers the handler.
   *
   * The handler is captured in `runtimeHandlers[id]`; the station node in
   * `definition.root.nodes` carries only serializable metadata.
   * @param id - Unique station identifier within this workflow
   * @param handler - Station handler function
   * @param options - Optional node conditions (`when`, `skip`)
   * @returns This builder for chaining
   */
  station(id: string, handler: StationHandler, options?: NodeOptions): WorkflowBuilder<TTrigger>;
  /**
   * Appends a delegate-agent node to the root sequence.
   * @param id - Unique node identifier
   * @param agentConfig - Agent delegation configuration
   * @param options - Optional node conditions
   * @returns This builder for chaining
   */
  delegateToAgent(id: string, agentConfig: AgentConfig, options?: NodeOptions): WorkflowBuilder<TTrigger>;
  /**
   * Appends a delegate-role node to the root sequence.
   * @param id - Unique node identifier
   * @param role - Named product role to delegate to
   * @param options - Optional node conditions; `prompt` defaults to the node ID
   * @returns This builder for chaining
   */
  delegateToRole(
    id: string,
    role: string,
    options?: NodeOptions & { readonly prompt?: string },
  ): WorkflowBuilder<TTrigger>;
  /**
   * Appends a parallel node with static branches to the root sequence.
   *
   * Each branch is a {@link WorkflowNode} produced by one of the standalone
   * factory functions (`station`, `delegateToAgent`, `delegateToRole`, etc.).
   * The nodes are wrapped in a sequence branch per entry in `branches`.
   * @param id - Unique parallel node identifier
   * @param options - Parallel execution options
   * @param branches - Ordered list of branch nodes
   * @returns This builder for chaining
   */
  parallel(id: string, options: ParallelOptions, branches: WorkflowNode[]): WorkflowBuilder<TTrigger>;
  /**
   * Appends a gate node to the root sequence.
   *
   * When a `resume` Zod schema is provided in `options`, it is stored in
   * `zodSchemas.gates[id]` and its JSON Schema equivalent is written to
   * the node's `resumeSchema` field.
   * @param id - Unique gate node identifier
   * @param options - Gate configuration including prompt and timeout
   * @returns This builder for chaining
   */
  gate(id: string, options: GateOptions): WorkflowBuilder<TTrigger>;
  /**
   * Appends an iterate node to the root sequence and registers the handler.
   * @param id - Unique iterate node identifier
   * @param handler - Station handler executed for each collection item
   * @param options - Iterate configuration including collection expression
   * @returns This builder for chaining
   */
  iterate(id: string, handler: IterateHandler, options: IterateOptions): WorkflowBuilder<TTrigger>;
  /**
   * Appends an iterate-chain node to the root sequence.
   *
   * Unlike `iterate`, the sub-chain is expressed as a static list of
   * {@link WorkflowNode} objects rather than a single handler.
   * @param id - Unique iterate-chain node identifier
   * @param chain - Ordered list of nodes forming the chain body
   * @param options - Iterate configuration including collection expression
   * @returns This builder for chaining
   */
  iterateChain(id: string, chain: WorkflowNode[], options: IterateOptions): WorkflowBuilder<TTrigger>;
  /**
   * Appends a trigger to the workflow definition.
   * @param trigger - The trigger to add
   * @returns This builder with an expanded trigger payload union
   */
  addTrigger<TPayload>(trigger: WorkflowTriggerDef<TPayload>): WorkflowBuilder<TTrigger | TPayload>;
  /**
   * Appends an arbitrary pre-built node to the root sequence.
   *
   * Use this escape hatch to include gate nodes, parallel nodes, iterate nodes,
   * and other primitive node types without registering a runtime handler.
   * @param node - A fully-constructed workflow node (schema-validated at runtime)
   */
  addNode(node: WorkflowNode): void;
}

// Re-export StepContext for use in builder method signatures
export type { StepContext };
