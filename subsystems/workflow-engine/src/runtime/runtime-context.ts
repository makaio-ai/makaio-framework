import * as os from 'node:os';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import type { ExpressionContext } from '@makaio/expression';
import {
  WorkflowStepTypeSchema,
  type BuiltWorkflow,
  type CodeStepHandler,
  type JsonValue,
  type LoopCheckHandler,
  type PreviousStepOutput,
  type SpanRecord,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowFrameState,
  type WorkflowNodeType,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { generateId } from '../executor-helpers.js';
import type { ArtifactBindingState } from '../artifact-context/artifact-binding.js';

// ─────────────────────────────────────────────────────────────
// Expression context
// ─────────────────────────────────────────────────────────────

/**
 * Immutable expression evaluation context for `when` and `skip` conditions.
 *
 * Supplied to every node during execution. Contains the workflow's resolved
 * inputs, resolved config, the trigger payload, and a map of completed frame
 * outputs keyed by node ID (for downstream dependency access within a sequence).
 *
 * When a node runs inside an `iterate` or `iterate-chain` body, the iterate
 * executor extends this context with `item`, `index`, and (for chain only)
 * `previous` so body nodes and code step handlers can reference per-item state.
 */
export interface PrimitiveExpressionContext {
  /** Workflow input value bound at execution start. */
  readonly inputs: JsonValue;
  /** Workflow configuration values bound at execution start. */
  readonly config?: Record<string, unknown>;
  /** Trigger payload that started the workflow. Absent for manual starts. */
  readonly trigger: Record<string, unknown>;
  /**
   * Terminal frame entries keyed by node ID.
   * Populated after a node reaches `completed` or `skipped` status.
   * Used by downstream `when`/`skip` conditions in the same sequence.
   */
  readonly frames: Record<string, { output?: JsonValue; status: WorkflowFrameState['status'] }>;
  /**
   * Handler-compatible aliases for earlier completed or skipped nodes,
   * keyed by node ID. Derived from `frames` so expression conditions can use
   * the same dependency shape code step handlers receive.
   */
  readonly previousSteps: Record<string, PreviousStepOutput<JsonValue>>;
  /**
   * Output from the most recent completed node in the current sequence scope.
   * Updated after completed nodes only; skipped nodes keep the previous value.
   */
  readonly output?: JsonValue;
  /**
   * Current collection item when the node runs inside an `iterate` or
   * `iterate-chain` body. Absent at the top-level sequence.
   */
  readonly item?: unknown;
  /**
   * Zero-based iteration index when the node runs inside an `iterate` or
   * `iterate-chain` body. Absent at the top-level sequence.
   */
  readonly index?: number;
  /**
   * Output from the previous item's body when the node runs inside an
   * `iterate-chain` body. Absent for the first item and at all other levels.
   */
  readonly previous?: JsonValue;
}

/**
 * Convert primitive frame entries into the handler-compatible previous-step map.
 *
 * Only completed and skipped entries are consumable by downstream workflow
 * expressions. Failed, cancelled, pending, and running entries are omitted.
 * @param frames - Primitive expression frame entries keyed by node ID.
 * @returns Previous-step aliases keyed by node ID.
 */
export function buildPreviousStepsFromFrames(
  frames: PrimitiveExpressionContext['frames'],
): Record<string, PreviousStepOutput<JsonValue>> {
  const result: Record<string, PreviousStepOutput<JsonValue>> = {};
  for (const [nodeId, entry] of Object.entries(frames)) {
    if (entry.status === 'completed') {
      result[nodeId] = {
        status: 'completed',
        output: entry.output as JsonValue,
      };
    } else if (entry.status === 'skipped') {
      result[nodeId] = { status: 'skipped' };
    }
  }
  return result;
}

/**
 * Terminal frame entry that can be merged into a {@link PrimitiveExpressionContext}.
 *
 * Discriminated on `status`:
 * - `completed`: the node finished successfully and may have produced output.
 * - `skipped`: the node was skipped by a `when` condition; no output is produced.
 */
type MergeableFrameEntry =
  | { readonly status: 'completed'; readonly output?: JsonValue }
  | { readonly status: 'skipped' };

/**
 * Merge a terminal frame entry for `nodeId` into an expression context.
 *
 * Produces a new context with the `frames`, `previousSteps`, and `output`
 * fields updated to reflect the completed or skipped node. The original
 * context is not mutated.
 * @param ctx - Current expression context.
 * @param nodeId - Node whose frame entry is being merged.
 * @param entry - Terminal frame entry to merge.
 * @returns Updated expression context reflecting the merged frame.
 */
export function mergeFrameOutput(
  ctx: PrimitiveExpressionContext,
  nodeId: string,
  entry: MergeableFrameEntry,
): PrimitiveExpressionContext {
  const frames = { ...ctx.frames, [nodeId]: entry };
  return {
    ...ctx,
    frames,
    previousSteps: buildPreviousStepsFromFrames(frames),
    output: entry.status === 'completed' ? entry.output : ctx.output,
  };
}

/**
 * Build the public expression/template scope from the runtime primitive context.
 *
 * The workflow authoring contract documents `ctx.*` references while earlier
 * runtime code paths also exposed top-level aliases such as `inputs`, `output`,
 * and `previousSteps`. This adapter is the single boundary where those shapes
 * are normalized before jexl evaluation or template interpolation.
 * @param expressionCtx - Primitive runtime context for the current node.
 * @returns Expression package-compatible variable map.
 */
export function buildRuntimeExpressionScope(expressionCtx: PrimitiveExpressionContext): ExpressionContext {
  const scope: ExpressionContext = {
    ...expressionCtx,
    input: expressionCtx.inputs,
    steps: expressionCtx.frames,
  };
  return {
    ...scope,
    ctx: scope,
  };
}

// ─────────────────────────────────────────────────────────────
// Frame creation params
// ─────────────────────────────────────────────────────────────

/**
 * Parameters for creating a new execution frame.
 */
export interface CreateFrameParams {
  /** Node identifier this frame corresponds to. */
  nodeId: string;
  /** Node type discriminant. */
  nodeType: WorkflowNodeType;
  /** Ordered path of frame IDs from root to this frame (inclusive). */
  path: string[];
  /** Parent frame ID. Absent for root frames. */
  parentFrameId?: string;
  /** Zero-based iteration index for iterate/iterate-chain frames. */
  iteration?: number;
  /** Branch key for parallel branch frames. */
  branchKey?: string;
}

/**
 * Execution-level options for runtime loop checks.
 *
 * All fields are optional; sensible defaults are applied by {@link RuntimeContext}.
 */
export interface RuntimeExecutionOptions {
  /**
   * Loop check handler functions keyed by handler name.
   * Populated by `.loop()` calls and standalone `loop()` factories.
   * Defaults to an empty map when absent.
   */
  readonly runtimeLoopChecks?: ReadonlyMap<string, LoopCheckHandler>;
}

/**
 * Ephemeral platform/workspace fields resolved on the executing machine.
 *
 * These values are NEVER persisted. They are derived at runtime from the
 * worker's local environment (in-process execution) or from a
 * {@link WorkerRuntimeContext} produced by the materializer (isolated workers).
 */
export interface EphemeralPlatformFields {
  /** Absolute path to the active repository/workspace root. */
  readonly repoPath: string;
  /** Absolute path to the Makaio home directory. */
  readonly makaioHome: string;
  /** Host operating system. */
  readonly os: 'darwin' | 'linux' | 'win32';
  /** CPU architecture (e.g. `'arm64'`, `'x64'`). */
  readonly arch: string;
  /** Active git worktree path, if different from `repoPath`. */
  readonly worktree?: string;
}

/**
 * Platform fields made available to code step handlers during runtime.
 */
export interface RuntimePlatformContext {
  /** Host/workspace context for code step handlers (ephemeral, worker-local). */
  readonly context: EphemeralPlatformFields;
  /** Extra environment variables injected into this workflow run. */
  readonly env: Record<string, string>;
}

/**
 * Derive ephemeral platform fields from the current process environment.
 *
 * These fields are never persisted; they describe the executing machine's
 * local filesystem and platform. Both the {@link RuntimeContext} default
 * constructor and the {@link WorkflowExecutor} share this helper to avoid
 * duplicating the OS normalization ternary.
 * @param cwd - Workspace/repository root path. Defaults to `process.cwd()`.
 * @param makaioHome - Explicit Makaio home override. Falls back to the
 *   `MAKAIO_HOME` environment variable, then `~/.makaio`.
 * @returns Ephemeral platform fields for the current machine.
 */
export function resolveEphemeralPlatformFields(cwd?: string, makaioHome?: string): EphemeralPlatformFields {
  const resolvedOs = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return {
    repoPath: cwd ?? process.cwd(),
    makaioHome: makaioHome ?? process.env['MAKAIO_HOME'] ?? `${os.homedir()}/.makaio`,
    os: resolvedOs,
    arch: process.arch,
  };
}

/**
 * Resolve a non-empty local platform context for tests and direct runtime use.
 * @returns Runtime platform context based on the current process.
 */
function resolveDefaultPlatformContext(): RuntimePlatformContext {
  return {
    context: resolveEphemeralPlatformFields(),
    env: {},
  };
}

/**
 * Snapshot a frame before enqueueing persistence so later in-memory mutations
 * cannot change the row being written for this lifecycle transition.
 * @param frame - Frame state to snapshot.
 * @returns A detached frame state copy.
 */
function snapshotFrame(frame: WorkflowFrameState): WorkflowFrameState {
  return { ...frame, path: [...frame.path] };
}

/**
 * Narrow workflow node types to the observable step types accepted by span
 * storage.
 * @param nodeType - Runtime frame node type.
 * @returns Span step type for executable/observable nodes, otherwise `undefined`.
 */
function toSpanStepType(nodeType: WorkflowNodeType): SpanRecord['stepType'] | undefined {
  const parsed = WorkflowStepTypeSchema.safeParse(nodeType);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Convert a persisted frame snapshot into the span read-model row used by
 * workflow dashboards.
 *
 * Structural frames and pending or cancelled states have no
 * equivalent `SpanRecord` shape today, so they remain frame-only lifecycle
 * states.
 * @param executionId - Execution that owns the frame.
 * @param frame - Detached frame snapshot to mirror.
 * @returns Span record for representable frame statuses, otherwise `undefined`.
 */
function toFrameSpanRecord(executionId: string, frame: WorkflowFrameState): SpanRecord | undefined {
  const stepType = toSpanStepType(frame.nodeType);
  if (stepType === undefined) {
    return undefined;
  }
  if (
    frame.status !== 'running' &&
    frame.status !== 'completed' &&
    frame.status !== 'failed' &&
    frame.status !== 'skipped'
  ) {
    return undefined;
  }

  const durationMs =
    frame.startedAt !== undefined && frame.completedAt !== undefined
      ? Math.max(0, frame.completedAt - frame.startedAt)
      : undefined;

  return {
    executionId,
    frameId: frame.frameId,
    stepId: frame.nodeId,
    stepType,
    status: frame.status,
    ...(frame.startedAt !== undefined ? { startedAt: frame.startedAt } : {}),
    ...(frame.completedAt !== undefined ? { completedAt: frame.completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(frame.output !== undefined ? { output: JSON.stringify(frame.output) } : {}),
  };
}

/** A required runtime frame transition failed. */
export class FramePersistenceError extends Error {
  /**
   * @param cause - Original persistence error.
   */
  public constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

// ─────────────────────────────────────────────────────────────
// RuntimeContext
// ─────────────────────────────────────────────────────────────

/**
 * Execution-wide state container for the primitive runtime.
 *
 * Provides the shared execution identifier, workflow definition, abort
 * signal, bus reference, and code step handler map. Manages frame state in
 * memory and emits frame lifecycle events to the bus.
 *
 * Frame persistence is delegated to storage subjects while this class remains
 * the authoritative in-memory registry for the active execution run. Persisted
 * observable frames are also mirrored into the existing span read model so
 * public trace/dashboard reads survive refresh.
 */
export class RuntimeContext {
  /** All frames created during this execution, keyed by frame ID. */
  private readonly frameRegistry: Map<string, WorkflowFrameState>;
  /** Ordered writes per frame. Rejected writes remain until the execution ends. */
  private readonly framePersistenceTasks = new Map<string, Promise<void>>();

  /**
   * Mutable artifact binding state for the workflow's primary artifact.
   *
   * `undefined` when no artifact binding is configured on the workflow
   * definition. Updated in place after every successful artifact revision
   * write so all code steps share the same authoritative current revision.
   */
  public artifactBinding: ArtifactBindingState | undefined;

  /**
   * Create a runtime context for a single workflow execution.
   * @param executionId - Unique execution identifier.
   * @param workflowId - Workflow definition identifier.
   * @param definition - Workflow definition containing the node tree.
   * @param execution - Current execution state (inputs, trigger payload).
   * @param runtimeHandlers - Code step handler functions keyed by node ID.
   * @param bus - Message bus for event emission.
   * @param signal - Cooperative cancellation signal.
   * @param sharedFrameRegistry - Optional shared frame registry for child contexts.
   * @param artifactBinding - Optional pre-resolved artifact binding state.
   * @param platform - Platform context and environment exposed to code step handlers.
   * @param options - Execution-level options for loop checks.
   */
  public constructor(
    public readonly executionId: string,
    public readonly workflowId: string,
    public readonly definition: WorkflowDefinition,
    public readonly execution: WorkflowExecution,
    public readonly runtimeHandlers: ReadonlyMap<string, CodeStepHandler>,
    public readonly bus: IMakaioBus,
    public readonly signal: AbortSignal,
    sharedFrameRegistry?: Map<string, WorkflowFrameState>,
    artifactBinding?: ArtifactBindingState,
    platform: RuntimePlatformContext = resolveDefaultPlatformContext(),
    options: RuntimeExecutionOptions = {},
  ) {
    this.frameRegistry = sharedFrameRegistry ?? new Map<string, WorkflowFrameState>();
    this.artifactBinding = artifactBinding;
    this.platformContext = platform.context;
    this.env = platform.env;
    this.runtimeLoopChecks = options.runtimeLoopChecks ?? new Map();
  }

  /** Platform/workspace context exposed to code step handlers (ephemeral). */
  public readonly platformContext: EphemeralPlatformFields;

  /** Extra environment variables exposed to code step handlers. */
  public readonly env: Record<string, string>;

  /**
   * Loop check handler functions keyed by handler name.
   * Empty when the workflow has no loop nodes.
   */
  public readonly runtimeLoopChecks: ReadonlyMap<string, LoopCheckHandler>;

  /**
   * Create a child context that shares this execution's frame registry and
   * artifact binding state but uses a different abort signal.
   *
   * Used by the parallel executor to propagate a fail-fast cancellation
   * signal into branch executions without forking the frame registry.
   * All frame mutations from the child context affect the same registry,
   * so the parent context remains the authoritative frame store. The shared
   * `artifactBinding` reference means concurrent branches write to the same
   * current revision pointer — callers must not issue concurrent writes.
   * @param signal - The override abort signal for the child context.
   * @returns A new {@link RuntimeContext} sharing the same frame registry and artifact binding.
   */
  public withSignal(signal: AbortSignal): RuntimeContext {
    return new RuntimeContext(
      this.executionId,
      this.workflowId,
      this.definition,
      this.execution,
      this.runtimeHandlers,
      this.bus,
      signal,
      this.frameRegistry,
      this.artifactBinding,
      { context: this.platformContext, env: this.env },
      {
        runtimeLoopChecks: this.runtimeLoopChecks,
      },
    );
  }

  /**
   * Build an initial expression context from the current execution state.
   *
   * Produces a snapshot context with current inputs and trigger payload.
   * The caller is responsible for merging frame outputs into `frames` as
   * nodes complete within a sequence.
   * @returns Base expression context for this execution.
   */
  public buildExpressionContext(): PrimitiveExpressionContext {
    return {
      inputs: this.execution.inputs,
      config: this.execution.config ?? {},
      trigger: this.execution.triggerPayload ?? {},
      frames: {},
      previousSteps: {},
    };
  }

  /**
   * Build a `WorkflowFrameState` record in `pending` status, register it
   * in the in-memory frame registry, and enqueue a bus upsert to persist the
   * initial row to the database.
   *
   * The initial write is ordered before every subsequent transition. The
   * next awaited transition reports an error from either write.
   *
   * The returned frame is mutable; since it is the same reference stored in the
   * registry, direct mutations are sufficient for lifecycle helpers. Callers that
   * know only the frame ID use {@link updateFrame} instead.
   * The frame ID is auto-generated and included in the returned path.
   * @param call - Call context of the message that drives this execution run.
   * @param params - Node identity and tree position for the new frame.
   * @returns The newly created frame (status `pending`).
   */
  public createFrame(call: CallContext, params: CreateFrameParams): WorkflowFrameState {
    const frameId = generateId('frm');
    const path = [...params.path, frameId];
    const frame: WorkflowFrameState = {
      frameId,
      nodeId: params.nodeId,
      nodeType: params.nodeType,
      path,
      parentFrameId: params.parentFrameId,
      status: 'pending',
      attempt: 0,
      iteration: params.iteration,
      branchKey: params.branchKey,
    };
    this.frameRegistry.set(frameId, frame);
    // The first pending write is enqueued from a synchronous factory. Later
    // lifecycle helpers await their own required writes, so observe this
    // promise here only to prevent unhandled rejections from the fire-and-forget
    // pending checkpoint.
    void this.persistFrame(call, frame).catch(() => undefined);
    return frame;
  }

  /**
   * Persist the current frame state via the workflow storage subject and mirror
   * observable node frames into the span read model consumed by public traces.
   *
   * Writes are ordered per frame. A failed frame write remains in the queue
   * so every later transition observes the error before executing side effects.
   * If a confirmed frame exists, a failed write attempts one failed checkpoint.
   * A failed span mirror is reported without blocking required frame writes.
   * @param call - Call context of the message that drives this execution run.
   * @param frame - Frame state to persist.
   */
  public async persistFrame(call: CallContext, frame: WorkflowFrameState): Promise<void> {
    const snapshot = snapshotFrame(frame);
    const previous = this.framePersistenceTasks.get(frame.frameId) ?? Promise.resolve();
    const task = previous.then(() => this.writeFrameTransition(call, frame, snapshot));

    this.framePersistenceTasks.set(frame.frameId, task);
    await task;
    if (this.framePersistenceTasks.get(frame.frameId) === task) {
      this.framePersistenceTasks.delete(frame.frameId);
    }
  }

  /**
   * Write a frame transition and checkpoint its failure once when a row already exists.
   * @param call - Call context of the execution run.
   * @param frame - Frame in the live registry.
   * @param snapshot - Detached state for this write.
   */
  private async writeFrameTransition(
    call: CallContext,
    frame: WorkflowFrameState,
    snapshot: WorkflowFrameState,
  ): Promise<void> {
    try {
      await this.writeFrame(call, snapshot);
    } catch (error) {
      const original = snapshot.status === 'failed' ? snapshot.error : undefined;
      const storageMessage = error instanceof Error ? error.message : String(error);
      const failure = new FramePersistenceError(
        original === undefined
          ? error
          : new Error(original + ' (frame storage: ' + storageMessage + ')', { cause: error }),
      );
      // A rejected initial checkpoint must stop the body before it runs. No
      // previously confirmed frame exists in that case.
      if (snapshot.status !== 'pending') {
        const message = failure.message;
        const completedAt = Date.now();
        const failed: WorkflowFrameState = {
          ...snapshot,
          status: 'failed',
          error: message,
          output: undefined,
          completedAt,
        };
        Object.assign(frame, failed);
        await this.writeFrame(call, failed)
          .then(() =>
            this.emitFrameFailed(
              call,
              failed,
              message,
              failed.startedAt === undefined ? undefined : Math.max(0, completedAt - failed.startedAt),
            ),
          )
          .catch((checkpointError: unknown) => {
            console.warn(`[RuntimeContext] Failed to record terminal frame ${frame.frameId}:`, checkpointError);
          });
      }
      throw failure;
    }
  }

  /**
   * Store one snapshot and mirror its span when the frame is observable.
   * @param call - Call context of the execution run.
   * @param snapshot - Detached frame state to persist.
   */
  private async writeFrame(call: CallContext, snapshot: WorkflowFrameState): Promise<void> {
    await this.bus.request(call, WorkflowStorageSubjects.setFrame, { executionId: this.executionId, frame: snapshot });
    const span = toFrameSpanRecord(this.executionId, snapshot);
    if (span !== undefined) {
      await this.bus.requestOptional(call, WorkflowStorageSubjects.setSpan, { span }).catch((error: unknown) => {
        console.warn(`[RuntimeContext] Failed to mirror span for frame ${snapshot.frameId}:`, error);
      });
    }
  }

  /**
   * Apply a partial update to an existing frame.
   *
   * Only the provided fields are merged; all other fields remain unchanged.
   * Throws if the frame ID is not found in the registry.
   * @param call - Call context of the message that drives this execution run.
   * @param frameId - The frame to update.
   * @param patch - Fields to merge into the frame.
   */
  public async updateFrame(call: CallContext, frameId: string, patch: Partial<WorkflowFrameState>): Promise<void> {
    const frame = this.frameRegistry.get(frameId);
    if (!frame) {
      throw new Error(`Frame not found: ${frameId}`);
    }
    Object.assign(frame, patch);
    await this.persistFrame(call, frame);
  }

  /**
   * Retrieve a frame by ID.
   * @param frameId - Frame identifier.
   * @returns The frame, or `undefined` if not found.
   */
  public getFrame(frameId: string): WorkflowFrameState | undefined {
    return this.frameRegistry.get(frameId);
  }

  /**
   * Find all frames for a given node ID, ordered by their `startedAt`
   * timestamp ascending (frames started earlier come first).
   *
   * In non-iteration executions there will typically be one frame per
   * node ID. In `iterate` expansions the same node ID has one frame
   * per iteration index.
   * @param nodeId - Node identifier to look up.
   * @returns Matching frames ordered by start time.
   */
  public getFramesByNodeId(nodeId: string): WorkflowFrameState[] {
    const matches: WorkflowFrameState[] = [];
    for (const frame of this.frameRegistry.values()) {
      if (frame.nodeId === nodeId) {
        matches.push(frame);
      }
    }
    return matches.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }

  /**
   * Emit a `workflow.frame.started` bus event for the given frame.
   *
   * The frame must already be registered and in `running` status before
   * this method is called. Failures from observers are swallowed so a
   * misbehaving subscriber cannot abort the execution.
   * @param call - Call context of the message that drives this execution run.
   * @param frame - The started frame.
   */
  public async emitFrameStarted(call: CallContext, frame: WorkflowFrameState): Promise<void> {
    try {
      await this.bus.emit(call, WorkflowSubjects.frame.started, {
        executionId: this.executionId,
        frameId: frame.frameId,
        nodeId: frame.nodeId,
        nodeType: frame.nodeType,
        path: frame.path,
        parentFrameId: frame.parentFrameId,
        startedAt: frame.startedAt,
      });
    } catch (error) {
      console.error(`[RuntimeContext] frame.started observer failed for ${frame.frameId}:`, error);
    }
  }

  /**
   * Emit a `workflow.frame.completed` bus event for the given frame.
   *
   * Failures from observers are swallowed so a misbehaving subscriber
   * cannot corrupt the execution outcome.
   * @param call - Call context of the message that drives this execution run.
   * @param frame - The completed frame.
   * @param durationMs - Wall-clock duration from frame start to completion.
   */
  public async emitFrameCompleted(call: CallContext, frame: WorkflowFrameState, durationMs?: number): Promise<void> {
    try {
      await this.bus.emit(call, WorkflowSubjects.frame.completed, {
        executionId: this.executionId,
        frameId: frame.frameId,
        nodeId: frame.nodeId,
        nodeType: frame.nodeType,
        output: frame.output,
        duration: durationMs,
        completedAt: frame.completedAt,
      });
    } catch (error) {
      console.error(`[RuntimeContext] frame.completed observer failed for ${frame.frameId}:`, error);
    }
  }

  /**
   * Emit a `workflow.frame.failed` bus event for the given frame.
   *
   * Failures from observers are swallowed so a misbehaving subscriber
   * cannot mask the original error.
   * @param call - Call context of the message that drives this execution run.
   * @param frame - The failed frame.
   * @param error - Human-readable failure reason.
   * @param durationMs - Wall-clock duration from frame start to failure.
   */
  public async emitFrameFailed(
    call: CallContext,
    frame: WorkflowFrameState,
    error: string,
    durationMs?: number,
  ): Promise<void> {
    try {
      await this.bus.emit(call, WorkflowSubjects.frame.failed, {
        executionId: this.executionId,
        frameId: frame.frameId,
        nodeId: frame.nodeId,
        nodeType: frame.nodeType,
        error,
        duration: durationMs,
        completedAt: frame.completedAt,
      });
    } catch (err) {
      console.error(`[RuntimeContext] frame.failed observer failed for ${frame.frameId}:`, err);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Factory helper
// ─────────────────────────────────────────────────────────────

/**
 * Construct a {@link RuntimeContext} from a {@link BuiltWorkflow} and an
 * active execution record.
 *
 * Centralises the wiring between the authoring-time {@link BuiltWorkflow} and
 * the execution-time {@link RuntimeContext} so callers do not need to manually
 * extract fields from the built workflow.
 * @param builtWorkflow - The fluent authoring result carrying the definition and handlers.
 * @param execution - Active execution record providing inputs and trigger payload.
 * @param bus - Message bus for event emission.
 * @param signal - Cooperative cancellation signal.
 * @returns A new {@link RuntimeContext} ready for execution.
 */
export function createRuntimeContext(
  builtWorkflow: BuiltWorkflow,
  execution: WorkflowExecution,
  bus: IMakaioBus,
  signal: AbortSignal,
): RuntimeContext {
  return new RuntimeContext(
    execution.id,
    builtWorkflow.id,
    builtWorkflow.definition,
    execution,
    builtWorkflow.runtimeHandlers,
    bus,
    signal,
    undefined,
    undefined,
    undefined,
    { runtimeLoopChecks: builtWorkflow.runtimeLoopChecks },
  );
}
