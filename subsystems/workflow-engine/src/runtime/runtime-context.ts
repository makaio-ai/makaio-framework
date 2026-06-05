import * as os from 'node:os';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExpressionContext } from '@makaio/expression';
import type {
  BuiltWorkflow,
  JsonValue,
  PreviousStepOutput,
  StationHandler,
  SpanRecord,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowFrameState,
  WorkflowNodeType,
  WorkflowWorkerConfig,
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
 * `previous` so body nodes and station handlers can reference per-item state.
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
   * the same dependency shape station handlers receive.
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
 * Platform fields made available to station handlers during runtime.
 */
export interface RuntimePlatformContext {
  /** Host/workspace context for station handlers. */
  readonly context: WorkflowWorkerConfig['context'];
  /** Extra environment variables injected into this workflow run. */
  readonly env: Record<string, string>;
}

/**
 * Resolve a non-empty local platform context for tests and direct runtime use.
 * @returns Runtime platform context based on the current process.
 */
function resolveDefaultPlatformContext(): RuntimePlatformContext {
  return {
    context: {
      repoPath: process.cwd(),
      makaioHome: process.env['MAKAIO_HOME'] ?? `${os.homedir()}/.makaio`,
      os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      arch: process.arch,
    },
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
  if (nodeType === 'station' || nodeType === 'delegate-agent' || nodeType === 'delegate-role' || nodeType === 'gate') {
    return nodeType;
  }
  return undefined;
}

/**
 * Convert a persisted frame snapshot into the span read-model row used by
 * workflow dashboards.
 *
 * Structural frames and pending, waiting, or cancelled states have no
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

// ─────────────────────────────────────────────────────────────
// RuntimeContext
// ─────────────────────────────────────────────────────────────

/**
 * Execution-wide state container for the primitive runtime.
 *
 * Provides the shared execution identifier, workflow definition, abort
 * signal, bus reference, and station handler map. Manages frame state in
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
  /** Per-frame persistence queues preserving transition order. */
  private readonly framePersistenceTasks = new Map<string, Promise<void>>();

  /**
   * Mutable artifact binding state for the workflow's primary artifact.
   *
   * `undefined` when no artifact binding is configured on the workflow
   * definition. Updated in place after every successful artifact revision
   * write so all stations share the same authoritative current revision.
   */
  public artifactBinding: ArtifactBindingState | undefined;

  /**
   * Create a runtime context for a single workflow execution.
   * @param executionId - Unique execution identifier.
   * @param workflowId - Workflow definition identifier.
   * @param definition - Workflow definition containing the node tree.
   * @param execution - Current execution state (inputs, trigger payload).
   * @param runtimeHandlers - Station handler functions keyed by node ID.
   * @param bus - Message bus for event emission.
   * @param signal - Cooperative cancellation signal.
   * @param sharedFrameRegistry - Optional shared frame registry for child contexts.
   * @param artifactBinding - Optional pre-resolved artifact binding state.
   * @param platform - Platform context and environment exposed to station handlers.
   */
  public constructor(
    public readonly executionId: string,
    public readonly workflowId: string,
    public readonly definition: WorkflowDefinition,
    public readonly execution: WorkflowExecution,
    public readonly runtimeHandlers: ReadonlyMap<string, StationHandler>,
    public readonly bus: IMakaioBus,
    public readonly signal: AbortSignal,
    sharedFrameRegistry?: Map<string, WorkflowFrameState>,
    artifactBinding?: ArtifactBindingState,
    platform: RuntimePlatformContext = resolveDefaultPlatformContext(),
  ) {
    this.frameRegistry = sharedFrameRegistry ?? new Map<string, WorkflowFrameState>();
    this.artifactBinding = artifactBinding;
    this.platformContext = platform.context;
    this.env = platform.env;
  }

  /** Platform/workspace context exposed to station handlers. */
  public readonly platformContext: WorkflowWorkerConfig['context'];

  /** Extra environment variables exposed to station handlers. */
  public readonly env: Record<string, string>;

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
   * Persistence errors are swallowed so a missing storage handler (e.g. in
   * unit tests without a DB) does not abort execution. The in-memory registry
   * is the authoritative source of truth during a single execution run.
   *
   * The returned frame is mutable; since it is the same reference stored in the
   * registry, direct mutations are sufficient for lifecycle helpers. Callers that
   * know only the frame ID (e.g. gate suspension) use {@link updateFrame} instead.
   * The frame ID is auto-generated and included in the returned path.
   * @param params - Node identity and tree position for the new frame.
   * @returns The newly created frame (status `pending`).
   */
  public createFrame(params: CreateFrameParams): WorkflowFrameState {
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
    void this.persistFrame(frame);
    return frame;
  }

  /**
   * Persist the current frame state via the workflow storage subject and mirror
   * observable node frames into the span read model consumed by public traces.
   *
   * Writes are ordered per frame so the initial pending row cannot race after
   * a later running/completed transition. Missing storage handlers are allowed
   * for isolated unit tests; handler failures are downgraded to warnings.
   * @param frame - Frame state to persist.
   */
  public async persistFrame(frame: WorkflowFrameState): Promise<void> {
    const snapshot = snapshotFrame(frame);
    const span = toFrameSpanRecord(this.executionId, snapshot);
    const previous = this.framePersistenceTasks.get(frame.frameId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        await this.bus.requestOptional(WorkflowStorageSubjects.setFrame, {
          executionId: this.executionId,
          frame: snapshot,
        });
        if (span !== undefined) {
          await this.bus.requestOptional(WorkflowStorageSubjects.setSpan, { span });
        }
      })
      .catch((error: unknown) => {
        console.warn(`[RuntimeContext] Failed to persist frame ${frame.frameId}:`, error);
      });

    this.framePersistenceTasks.set(frame.frameId, task);
    await task;
    if (this.framePersistenceTasks.get(frame.frameId) === task) {
      this.framePersistenceTasks.delete(frame.frameId);
    }
  }

  /**
   * Apply a partial update to an existing frame.
   *
   * Only the provided fields are merged; all other fields remain unchanged.
   * Throws if the frame ID is not found in the registry.
   * @param frameId - The frame to update.
   * @param patch - Fields to merge into the frame.
   */
  public async updateFrame(frameId: string, patch: Partial<WorkflowFrameState>): Promise<void> {
    const frame = this.frameRegistry.get(frameId);
    if (!frame) {
      throw new Error(`Frame not found: ${frameId}`);
    }
    Object.assign(frame, patch);
    await this.persistFrame(frame);
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
   * @param frame - The started frame.
   */
  public async emitFrameStarted(frame: WorkflowFrameState): Promise<void> {
    try {
      await this.bus.emit(WorkflowSubjects.frame.started, {
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
   * @param frame - The completed frame.
   * @param durationMs - Wall-clock duration from frame start to completion.
   */
  public async emitFrameCompleted(frame: WorkflowFrameState, durationMs?: number): Promise<void> {
    try {
      await this.bus.emit(WorkflowSubjects.frame.completed, {
        executionId: this.executionId,
        frameId: frame.frameId,
        nodeId: frame.nodeId,
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
   * @param frame - The failed frame.
   * @param error - Human-readable failure reason.
   * @param durationMs - Wall-clock duration from frame start to failure.
   */
  public async emitFrameFailed(frame: WorkflowFrameState, error: string, durationMs?: number): Promise<void> {
    try {
      await this.bus.emit(WorkflowSubjects.frame.failed, {
        executionId: this.executionId,
        frameId: frame.frameId,
        nodeId: frame.nodeId,
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
  );
}
