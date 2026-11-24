import { z } from 'zod';
import type { ExtensionName } from '@makaio/core';
import type { JsonValue } from '../shared/json-value.js';
import type {
  WorkflowArtifactBinding,
  WorkflowDefinition,
  WorkflowLoopNode,
  WorkflowNode,
  WorkflowSourceLocation,
} from './schemas.js';
import type { WorkflowFinalizerId } from './finalization.js';
import type { CompletionMode } from '../subagent/schemas.js';
import type { CodeStepHandler, IterateHandler, StepContext } from './authoring-context.js';
import type { WorkflowTriggerDef } from './authoring-triggers.js';
import type { LoopCheckHandler } from './loop.js';

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
 * Options for agent steps created via the fluent builder or the standalone factory.
 */
export type AgentStepOptions = NodeOptions & {
  /** Prompt text passed to the agent. Defaults to the node ID. */
  readonly prompt?: string;
  /** JSON Schema for the expected agent output. */
  readonly outputSchema?: Record<string, JsonValue>;
  /** Timeout in milliseconds for the agent step. */
  readonly timeoutMs?: number;
  /** Completion behavior requested from the agent. */
  readonly completion?: CompletionMode;
  /**
   * Exact tool allowlist (Makaio tool names; format: `ToolLists` in `@makaio/contracts`
   * tool-names).
   */
  readonly allowedTools?: string[];
  /** Authority-owned finalizer applied to the successful result. */
  readonly resultFinalizerId?: string;
};

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
// Loop Options (builder-level)
// ─────────────────────────────────────────────────────────────

/**
 * Associates a check handler name with its runtime function.
 *
 * The `handler` string is serialized into the definition; the `evaluate`
 * function is stored in `runtimeLoopChecks` and never persisted.
 */
export interface LoopCheckRegistration {
  /** Registered check handler name resolved at runtime. */
  readonly handler: string;
  /** Runtime check function stored in `runtimeLoopChecks`. */
  readonly evaluate: LoopCheckHandler;
}

/**
 * Options for loop nodes created via the fluent builder or standalone factory.
 *
 * Extends {@link NodeOptions} with a round limit and a check handler registration.
 */
export interface LoopOptions extends NodeOptions {
  /** Maximum number of rounds to run if the check has yet to pass. */
  readonly maxRounds: number;
  /** How to finish after all rounds are exhausted. Defaults to failing the loop. */
  readonly onExhausted?: WorkflowLoopNode['onExhausted'];
  /** Check registration and optional input and configuration. */
  readonly check: LoopCheckRegistration & {
    /**
     * Optional expression resolving to the check handler's input value.
     * Typically a frame output reference like `'frames.aggregate.output'`.
     */
    readonly input?: string;
    /** Optional static configuration forwarded to the check handler. */
    readonly config?: JsonValue;
  };
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
  readonly schemaVersion: WorkflowArtifactBinding['schemaVersion'];
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
}

// ─────────────────────────────────────────────────────────────
// State definition options (builder-level)
// ─────────────────────────────────────────────────────────────

/**
 * Typed state contract accepted by the fluent `.state()` builder method.
 *
 * The JSON Schema is serialized onto the workflow definition. The optional
 * initial value is typed when the state contract is declared and is stored
 * on the serializable definition when provided.
 * @typeParam TState - Workflow run-state shape declared by the author.
 */
export interface WorkflowStateAuthoringDefinition<TState extends JsonValue = JsonValue> {
  /** JSON Schema describing the workflow run-state shape. */
  readonly schema: Record<string, JsonValue>;
  /** Optional initial value for a new workflow execution. */
  readonly initial?: TState;
}

// ─────────────────────────────────────────────────────────────
// Built Workflow Return Type
// ─────────────────────────────────────────────────────────────

/**
 * The result of defining a workflow via the fluent builder.
 *
 * `definition` is fully serializable — it contains no functions.
 * Code step handlers and dynamic factories are carried in the runtime maps,
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
   * Code step handler functions keyed by node ID.
   * Populated by `.codeStep()` calls and standalone `codeStep()` factories.
   */
  readonly runtimeHandlers: ReadonlyMap<string, CodeStepHandler>;
  /**
   * Dynamic region factory functions keyed by factory ID.
   * Empty while the v1 authoring surface exposes only static topology.
   */
  readonly runtimeFactories: ReadonlyMap<string, () => WorkflowNode[]>;
  /**
   * Loop check handler functions keyed by handler name.
   * Populated by `.loop()` calls and standalone `loop()` factories.
   */
  readonly runtimeLoopChecks: ReadonlyMap<string, LoopCheckHandler>;
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
  /** Definition-owned finalizer selected after a successful workflow execution. */
  readonly successFinalizerId?: WorkflowFinalizerId;
  /**
   * Declarations addressed to extensions, keyed by extension name. Copied into
   * `definition.extensions`; the workflow core interprets none of them.
   */
  readonly extensions?: Readonly<Record<ExtensionName, JsonValue>>;
}

// ─────────────────────────────────────────────────────────────
// Workflow Builder
// ─────────────────────────────────────────────────────────────

/**
 * A fluent workflow builder returned by {@link defineWorkflow}.
 *
 * Collects trigger definitions, Zod schemas, and typed code step registrations,
 * then exposes the serializable `WorkflowDefinition` alongside runtime maps
 * for the worker executor.
 *
 * All fluent methods mutate internal state and return `this` so chains can be
 * composed freely. The builder also implements {@link BuiltWorkflow} so it can
 * be passed wherever a built workflow is expected without an explicit `.build()`
 * call.
 * @typeParam TTrigger - Trigger payload type (from the union of added triggers)
 * @typeParam TState - Workflow run-state type declared via `.state()`.
 */
export interface WorkflowBuilder<TTrigger = never, TState extends JsonValue | undefined = undefined>
  extends BuiltWorkflow {
  /**
   * Sets the workflow's input schema.
   *
   * The Zod schema is stored in `zodSchemas.input`; its JSON Schema equivalent
   * is written to `definition.inputSchema`.
   * @param schema - Zod schema describing the workflow's input parameters
   * @returns This builder for chaining
   */
  input(schema: z.ZodTypeAny): WorkflowBuilder<TTrigger, TState>;
  /**
   * Sets the workflow's config schema.
   *
   * The Zod schema is stored in `zodSchemas.config`; its JSON Schema equivalent
   * is written to `definition.configSchema`.
   * @param schema - Zod schema describing the workflow's static configuration
   * @returns This builder for chaining
   */
  config(schema: z.ZodTypeAny): WorkflowBuilder<TTrigger, TState>;
  /**
   * Sets the workflow's output schema.
   *
   * The Zod schema is stored in `zodSchemas.output`; its JSON Schema equivalent
   * is written to `definition.outputSchema`.
   * @param schema - Zod schema describing the workflow's primary output
   * @returns This builder for chaining
   */
  output(schema: z.ZodTypeAny): WorkflowBuilder<TTrigger, TState>;
  /**
   * Binds a primary artifact to the workflow.
   *
   * The artifact Zod schema (if provided) is stored in `zodSchemas.artifact`;
   * the binding metadata is written to `definition.artifact`.
   * @param options - Artifact binding configuration
   * @returns This builder for chaining
   */
  artifact(options: ArtifactBindingOptions): WorkflowBuilder<TTrigger, TState>;
  /**
   * Declares a typed run-state contract for this workflow.
   *
   * The state definition specifies a JSON Schema and optional initial value.
   * At execution start, the engine initializes the state snapshot from
   * `initial` (or `{}` when omitted). Code step handlers access the state
   * through the registered workflow state requests.
   * @param definition - State contract with JSON Schema and optional initial value
   * @returns This builder for chaining
   */
  state<TNextState extends JsonValue>(
    definition: WorkflowStateAuthoringDefinition<TNextState>,
  ): WorkflowBuilder<TTrigger, TNextState>;
  /**
   * Appends a code step node to the root sequence and registers the handler.
   *
   * The handler is captured in `runtimeHandlers[id]`; the code step node in
   * `definition.root.nodes` carries only serializable metadata.
   * @param id - Unique code step identifier within this workflow
   * @param handler - Code step handler function
   * @param options - Optional node conditions (`when`, `skip`)
   * @returns This builder for chaining
   */
  codeStep(id: string, handler: CodeStepHandler, options?: NodeOptions): WorkflowBuilder<TTrigger, TState>;
  /**
   * Appends an agent step node to the root sequence.
   * @param id - Unique node identifier
   * @param role - Named product role to delegate the agent step to
   * @param options - Optional node conditions and agent step settings; `prompt` defaults to the node ID
   * @returns This builder for chaining
   */
  agentStep(id: string, role: string, options?: AgentStepOptions): WorkflowBuilder<TTrigger, TState>;
  /**
   * Appends a parallel node with static branches to the root sequence.
   *
   * Each branch is a {@link WorkflowNode} produced by one of the standalone
   * factory functions (`codeStep`, `agentStep`, etc.).
   * The nodes are wrapped in a sequence branch per entry in `branches`.
   * @param id - Unique parallel node identifier
   * @param options - Parallel execution options
   * @param branches - Ordered list of branch nodes
   * @returns This builder for chaining
   */
  parallel(id: string, options: ParallelOptions, branches: WorkflowNode[]): WorkflowBuilder<TTrigger, TState>;
  /**
   * Appends an iterate node to the root sequence and registers the handler.
   * @param id - Unique iterate node identifier
   * @param handler - Code step handler executed for each collection item
   * @param options - Iterate configuration including collection expression
   * @returns This builder for chaining
   */
  iterate(id: string, handler: IterateHandler, options: IterateOptions): WorkflowBuilder<TTrigger, TState>;
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
  iterateChain(id: string, chain: WorkflowNode[], options: IterateOptions): WorkflowBuilder<TTrigger, TState>;
  /**
   * Appends a loop node to the root sequence with a convergence check.
   *
   * The check runs after each round. A passing check completes the loop.
   * A throwing check fails the loop. Exhaustion fails by default or completes
   * when `onExhausted` is set to `'complete'`. Code step handlers from standalone
   * `codeStep()` factories in the body are automatically collected into `runtimeHandlers`.
   *
   * V1 does not support nested loops; the builder validates this constraint
   * at authoring time.
   * @param id - Unique loop node identifier
   * @param bodyNodes - Ordered list of nodes forming the loop body
   * @param options - Loop configuration including maxRounds and the check
   * @returns This builder for chaining
   */
  loop(id: string, bodyNodes: WorkflowNode[], options: LoopOptions): WorkflowBuilder<TTrigger, TState>;
  /**
   * Appends a trigger to the workflow definition.
   * @param trigger - The trigger to add
   * @returns This builder with an expanded trigger payload union
   */
  addTrigger<TPayload>(trigger: WorkflowTriggerDef<TPayload>): WorkflowBuilder<TTrigger | TPayload, TState>;
  /**
   * Appends an arbitrary pre-built node to the root sequence.
   *
   * Use this escape hatch to include parallel nodes, iterate nodes,
   * and other primitive node types without registering a runtime handler.
   * @param node - A fully-constructed workflow node (schema-validated at runtime)
   */
  addNode(node: WorkflowNode): void;
}

// Re-export StepContext for use in builder method signatures
export type { StepContext };
