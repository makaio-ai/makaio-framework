import type { JsonValue } from '../shared/json-value.js';
import type { WorkflowProgressUpdate } from './namespace.js';

// ─────────────────────────────────────────────────────────────
// Artifact Context
// ─────────────────────────────────────────────────────────────

/**
 * Declarative operations for {@link ArtifactContext.updateArtifact} patches.
 *
 * - `merge`  — deep-merge the patch into the current data
 * - `set`    — replace the current data entirely with the patch
 * - `append` — for array-typed fields in the patch, append items instead of replacing
 */
export type ArtifactUpdateOperation = 'merge' | 'set' | 'append';

/**
 * Declarative patch descriptor for {@link ArtifactContext.updateArtifact}.
 *
 * When passed instead of a functional updater, `operation` controls how the
 * runtime merges `data` into the current artifact snapshot.
 * @typeParam TData - Artifact data shape for this workflow's binding.
 */
export interface ArtifactPatch<TData extends Record<string, unknown>> {
  /** Declarative operation applied to the current data. */
  readonly operation: ArtifactUpdateOperation;
  /** Partial or full data payload to apply. */
  readonly data: Partial<TData>;
}

/**
 * Functional updater signature for {@link ArtifactContext.updateArtifact}.
 *
 * Receives the current artifact data snapshot and returns the full next state.
 * The runtime validates the returned value against the workflow's artifact
 * schema before writing a new revision.
 * @typeParam TData - Artifact data shape for this workflow's binding.
 * @param current - Read-only snapshot of the current artifact data.
 * @returns The full next artifact data payload.
 */
export type ArtifactUpdater<TData extends Record<string, unknown>> = (
  current: Readonly<TData>,
) => TData | Promise<TData>;

/**
 * Artifact access API exposed on {@link StepContext}.
 *
 * Provides a read-only snapshot of the current artifact data and the two
 * mutation methods — `updateArtifact` and `updateStatus` — that write new
 * revisions through the generic artifact bus.
 *
 * Present only when the workflow declares an artifact binding via `.artifact()`.
 * @typeParam TData - Artifact data shape for this workflow's binding.
 */
export interface ArtifactContext<TData extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Read-only snapshot of the artifact data as it was at the start of the
   * current station execution.
   *
   * Mutations are not allowed directly on this object — use `updateArtifact`
   * or `updateStatus` to produce a new revision.
   */
  readonly data: Readonly<TData>;

  /**
   * Write a new artifact revision using a declarative patch or a functional
   * updater.
   *
   * When a {@link ArtifactPatch} is supplied, the runtime applies the
   * declared `operation` to produce the next data payload. When an
   * {@link ArtifactUpdater} function is supplied, it receives the current
   * data snapshot and must return the full next state.
   *
   * Every call validates the next data against the workflow's declared artifact
   * schema and writes a new revision through the artifact bus before emitting
   * a `workflow.artifact.updated` event.
   * @param update - Declarative patch or functional updater.
   * @returns The revision identifier assigned by the artifact service.
   */
  updateArtifact(update: ArtifactPatch<TData> | ArtifactUpdater<TData>): Promise<string>;

  /**
   * Convenience shorthand for updating the status field declared via
   * `statusPath` on the artifact binding.
   *
   * Equivalent to calling `updateArtifact` with a `set` patch targeting only
   * the status field. Throws if the workflow's artifact binding has no
   * `statusPath` configured.
   * @param value - The new status string value.
   * @returns The revision identifier assigned by the artifact service.
   */
  updateStatus(value: string): Promise<string>;
}

// ─────────────────────────────────────────────────────────────
// Workflow State Context
// ─────────────────────────────────────────────────────────────

/**
 * Run-scoped mutable state API exposed on {@link StepContext}.
 *
 * Provides read and update access to the workflow's typed run state.
 * State mutations are sequence-numbered and conflict-checked by the
 * engine; the `update` method applies a producer function to a
 * structured clone of the current state, or accepts a returned replacement
 * value for primitive state.
 * @typeParam TState - The workflow's declared state type
 */
export interface WorkflowStateContext<TState> {
  /**
   * Retrieve the current state snapshot.
   * @returns The current state value
   */
  get(): Promise<TState>;
  /**
   * Apply a mutation to the current state.
   *
   * The `mutator` receives a mutable draft of the current state. Object and
   * array states can be mutated in place; primitive states should return the
   * replacement value.
   * The engine computes a JSON Patch from the mutation, persists it
   * with sequence numbering, and returns the accepted next state.
   * @param mutator - Function that mutates the draft state or returns a replacement
   * @returns The accepted next state after the mutation
   */
  update(mutator: (draft: TState) => TState | void | Promise<TState | void>): Promise<TState>;
}

// ─────────────────────────────────────────────────────────────
// Workflow Context
// ─────────────────────────────────────────────────────────────

/**
 * Platform and workspace context fields shared by both {@link WorkflowContext}
 * and {@link StepContext}.
 *
 * Separating these base fields from the trigger field allows {@link StepContext}
 * to narrow `trigger` to the concrete payload type while re-using all other fields.
 */
export interface WorkflowContextBase {
  /** Absolute path to the active repository root. */
  readonly repoPath: string;
  /** Absolute path to the Makaio home directory. */
  readonly makaioHome: string;
  /** Host operating system. */
  readonly os: 'darwin' | 'linux' | 'win32';
  /** CPU architecture (e.g. `'arm64'`, `'x64'`). */
  readonly arch: string;
  /** Active git worktree path, if different from `repoPath`. */
  readonly worktree?: string;
  /** Bound input value for this execution. */
  readonly inputs: JsonValue;
  /** Bound workflow configuration values for this execution. */
  readonly config: Record<string, unknown>;
  /** Extra environment variables injected into the worker process. */
  readonly env: Record<string, string>;
  /** Unique execution identifier. */
  readonly executionId: string;
  /** Workflow definition identifier. */
  readonly workflowId: string;
}

/**
 * Platform and workspace context available to every workflow station function.
 *
 * These fields are populated from the coordinator context at dispatch time.
 */
export interface WorkflowContext extends WorkflowContextBase {
  /** Payload from the trigger that started this execution. */
  readonly trigger: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// Previous Step Output Types
// ─────────────────────────────────────────────────────────────

/**
 * The shape of a declared predecessor entry in `ctx.previousSteps`.
 *
 * Predecessors can be completed or skipped. Both remain visible so downstream
 * functions can branch on the terminal status of every declared predecessor.
 * @typeParam TOutput - The station's inferred output type
 */
export type PreviousStepOutput<TOutput extends JsonValue> =
  | {
      /** JSON-serializable value produced by the completed station. */
      readonly output: TOutput;
      /** Upstream station completed and produced an output. */
      readonly status: 'completed';
    }
  | {
      /** Skipped upstream stations do not produce an output. */
      readonly output?: undefined;
      /** Upstream station was skipped by its `when`/`skip` condition. */
      readonly status: 'skipped';
    };

// ─────────────────────────────────────────────────────────────
// Progress Update
// ─────────────────────────────────────────────────────────────

export type { WorkflowProgressUpdate };

// ─────────────────────────────────────────────────────────────
// Step Context
// ─────────────────────────────────────────────────────────────

/**
 * Full execution context passed to a station handler function.
 *
 * Extends {@link WorkflowContextBase} with a typed `trigger` field and the
 * `previousSteps` map.
 * @typeParam TTrigger - The trigger payload type
 * @typeParam TPreviousSteps - Map of completed predecessor station outputs
 * @typeParam TArtifactData - Artifact data shape; defaults to `Record<string, unknown>`
 *   when no artifact binding is declared
 * @typeParam TBus - Runtime bus type supplied by the host runtime; defaults to
 *   `unknown` so the contracts package stays free of any bus implementation dependency.
 *   Bind to `IMakaioBus` (from `@makaio/bus-core`) in host layers that need full bus
 *   authoring surface access inside station handlers.
 * @typeParam TState - The workflow's declared run state type; defaults to `unknown`
 *   when no state contract is declared on the workflow definition.
 */
export interface StepContext<
  TTrigger,
  TPreviousSteps extends Record<string, PreviousStepOutput<JsonValue>>,
  TArtifactData extends Record<string, unknown> = Record<string, unknown>,
  TBus = unknown,
  TState = unknown,
> extends WorkflowContextBase {
  /** Typed payload from the trigger that started this execution. */
  readonly trigger: TTrigger;
  /**
   * Outputs from earlier completed nodes keyed by node ID.
   * Entries may be absent when an earlier node was not executed in this path.
   */
  readonly previousSteps: TPreviousSteps;
  /** Current collection item when running inside an `iterate` expansion. */
  readonly item?: unknown;
  /** Zero-based iteration index when running inside an `iterate` expansion. */
  readonly index?: number;
  /** Output from the previous chain item when running inside an `iterate-chain`. */
  readonly previous?: JsonValue;
  /** Abort signal for cooperative cancellation of long-running station handlers. */
  readonly signal: AbortSignal;
  /**
   * Artifact access API for the workflow's primary artifact binding.
   *
   * Present when the workflow declares an artifact binding via `.artifact()`
   * and the runtime has successfully resolved or created the artifact at
   * execution start. `undefined` when no binding is configured or the
   * artifact could not be initialised.
   */
  readonly artifact?: ArtifactContext<TArtifactData>;
  /**
   * Run-scoped mutable state API.
   *
   * Present when the workflow declares a state contract via the `state`
   * field on the definition. Provides `get()` and `update()` methods
   * for reading and mutating the execution's working memory.
   *
   * `undefined` when no state contract is declared on the workflow.
   */
  readonly state?: WorkflowStateContext<TState>;
  /**
   * Runtime bus for station handlers that need to query or write durable
   * artifacts as part of their authored output.
   *
   * Typed as the `TBus` type parameter (defaults to `unknown` in the
   * contracts package). Host runtimes that thread `IMakaioBus` through the
   * execution pipeline will expose the fully-typed bus here.
   */
  readonly bus: TBus;
  /**
   * Emit a structured progress signal.
   *
   * Progress updates are consumed by observers and materialization providers
   * for real-time projections, but are not durable WorkLog entries.
   * @param update - The progress signal to emit.
   */
  readonly updateProgress: (update: WorkflowProgressUpdate) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Handler Types
// ─────────────────────────────────────────────────────────────

/**
 * Station handler context with state presence refined by the builder.
 *
 * Base {@link StepContext} keeps `state` optional because runtime contexts can
 * be constructed without a state contract. The authoring builder uses this
 * type so workflows that declare `.state<T>()` receive a required
 * `WorkflowStateContext<T>` in station handlers, while workflows without state
 * expose `state` as absent.
 * @typeParam TTrigger - The trigger payload type
 * @typeParam TPreviousSteps - Map of completed predecessor station outputs
 * @typeParam TArtifactData - Artifact data shape
 * @typeParam TBus - Runtime bus type supplied by the host runtime
 * @typeParam TState - The workflow's declared run state type
 */
export type StationStepContext<
  TTrigger,
  TPreviousSteps extends Record<string, PreviousStepOutput<JsonValue>>,
  TArtifactData extends Record<string, unknown> = Record<string, unknown>,
  TBus = unknown,
  TState = undefined,
> = Omit<StepContext<TTrigger, TPreviousSteps, TArtifactData, TBus, TState>, 'state'> &
  (unknown extends TState
    ? { readonly state?: WorkflowStateContext<TState> }
    : [TState] extends [undefined]
      ? { readonly state?: undefined }
      : { readonly state: WorkflowStateContext<TState> });

/**
 * Generic station handler — a function accepting a {@link StationStepContext} and
 * returning a JSON-serializable value.
 *
 * Used in the fluent builder methods where trigger and dependency types are
 * tracked by the builder and erased for runtime handler storage.
 * @typeParam TTrigger - The trigger payload type
 * @typeParam TPreviousSteps - Map of completed predecessor station outputs
 * @typeParam TArtifactData - Artifact data shape
 * @typeParam TBus - Runtime bus type supplied by the host runtime
 * @typeParam TState - The workflow's declared run state type; defaults to
 *   `unknown` for erased runtime-handler storage.
 */
export type StationHandler<
  TTrigger = unknown,
  TPreviousSteps extends Record<string, PreviousStepOutput<JsonValue>> = Record<string, PreviousStepOutput<JsonValue>>,
  TArtifactData extends Record<string, unknown> = Record<string, unknown>,
  TBus = unknown,
  TState = unknown,
> = {
  bivarianceHack(
    ctx: StationStepContext<TTrigger, TPreviousSteps, TArtifactData, TBus, TState>,
  ): JsonValue | Promise<JsonValue>;
}['bivarianceHack'];

/**
 * Generic iterate handler — same signature as {@link StationHandler} but
 * semantically used for `iterate` node bodies.
 * @typeParam TTrigger - The trigger payload type
 * @typeParam TPreviousSteps - Map of completed predecessor station outputs
 * @typeParam TArtifactData - Artifact data shape
 * @typeParam TBus - Runtime bus type supplied by the host runtime
 * @typeParam TState - The workflow's declared run state type
 */
export type IterateHandler<
  TTrigger = unknown,
  TPreviousSteps extends Record<string, PreviousStepOutput<JsonValue>> = Record<string, PreviousStepOutput<JsonValue>>,
  TArtifactData extends Record<string, unknown> = Record<string, unknown>,
  TBus = unknown,
  TState = unknown,
> = StationHandler<TTrigger, TPreviousSteps, TArtifactData, TBus, TState>;
