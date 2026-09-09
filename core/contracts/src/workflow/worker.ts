import { z } from 'zod';
import { WorkflowDefinitionSchema, WorkflowExecutionScopeSchema } from './schemas.js';
import { JsonObjectContractSchema, JsonValueSchema } from '../shared/json-value.js';
import { WorkflowArtifactRefSchema } from './artifact-ref.js';
import { SuspensionStrategySchema } from '../worker/suspension.js';
import { ArtifactRevisionSchema, type ArtifactRevision } from '../artifact/index.js';
import { WorkerContributionRefSchema, WorkerMaterializationSpecSchema } from '../capabilities/worker/types.js';

// ─────────────────────────────────────────────────────────────
// Worker Bus Auth
// ─────────────────────────────────────────────────────────────

/**
 * Bus authentication strategy for a workflow worker connection.
 *
 * Discriminated on `kind`:
 * - `none`: no authentication (local/trusted environments)
 * - `hmac`: shared-secret HMAC signing
 */
export const WorkflowWorkerBusAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('hmac'), secret: z.string().min(1) }).strict(),
]);

export type WorkflowWorkerBusAuth = z.infer<typeof WorkflowWorkerBusAuthSchema>;

// ─────────────────────────────────────────────────────────────
// Worker Source
// ─────────────────────────────────────────────────────────────

/**
 * Workflow source descriptor for a worker process.
 *
 * Discriminated on `kind`:
 * - `path`: load workflow from a file path on disk
 * - `source`: load workflow from inline source code with a virtual filename
 * - `definition`: load workflow by its registered definition ID
 */
export const WorkflowWorkerSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('source'), filename: z.string().min(1), source: z.string() }).strict(),
  z.object({ kind: z.literal('definition'), workflowId: z.string().min(1) }).strict(),
]);

export type WorkflowWorkerSource = z.infer<typeof WorkflowWorkerSourceSchema>;

/**
 * Determines whether a workflow worker executes immediately or first waits for
 * one of the workflow's declared automation triggers.
 */
export const WorkflowTriggerModeSchema = z.enum(['immediate', 'await-trigger']);

/** Explicit workflow trigger execution mode. */
export type WorkflowTriggerMode = z.infer<typeof WorkflowTriggerModeSchema>;

// ─────────────────────────────────────────────────────────────
// Worker Config
// ─────────────────────────────────────────────────────────────

/**
 * Full configuration passed to a workflow worker process at startup.
 *
 * Contains all information needed for the worker to connect to the bus,
 * load the workflow definition, and begin execution in isolation.
 */
export const WorkflowWorkerConfigSchema = z.object({
  /** Workflow source descriptor — tells the worker where to load the workflow from. */
  source: WorkflowWorkerSourceSchema,
  /**
   * Serialized workflow definition for workers.
   *
   * Definition-sourced workers construct a {@link LoadedWorkflow} directly from
   * this field. Source-backed workers may also receive it when the executor
   * must pin execution to a stored snapshot while loading runtime handlers from
   * the source module.
   */
  definition: WorkflowDefinitionSchema.optional(),
  /** Unique execution identifier for this workflow run. */
  executionId: z.string().min(1),
  /** Workflow definition identifier. */
  workflowId: z.string().min(1),
  /**
   * Payload from the trigger that started this execution.
   * Available to workflow expressions as `trigger.*`.
   */
  triggerPayload: JsonObjectContractSchema.default({}),
  /** Explicitly selects immediate execution or trigger-awaiting execution. */
  triggerMode: WorkflowTriggerModeSchema.optional(),
  /**
   * Bound workflow input value for this execution.
   * Available to workflow expressions as `inputs`.
   */
  inputs: JsonValueSchema.default({}),
  /**
   * Bound workflow configuration values for this execution.
   * Available to workflow expressions as `config.*`.
   */
  config: JsonObjectContractSchema.optional(),
  /**
   * Explicit artifact reference supplied by the execution starter.
   *
   * Isolated workers include this in their reconstructed run context so
   * artifact binding observes the same precedence as in-process execution.
   */
  artifactRef: WorkflowArtifactRefSchema.optional(),
  /**
   * Resolved execution scope. Caller overrides are resolved in the main
   * process before worker dispatch so isolated execution persists the same
   * scope row as in-process execution.
   */
  scope: WorkflowExecutionScopeSchema.default({ type: 'global' }),
  /** Bus server WebSocket URL for the worker to connect to. */
  busUrl: z.string().optional(),
  /** Bus authentication strategy. Defaults to `{ kind: 'none' }` when omitted. */
  busAuth: WorkflowWorkerBusAuthSchema.default({ kind: 'none' }),
  /**
   * Extra environment variables injected into the worker process.
   * Merged with the runtime environment; values are fully resolved strings.
   */
  env: z.record(z.string(), z.string()).default({}),
  /** Coordinator session ID that owns this execution. */
  coordinatorSessionId: z.string().min(1),
  /** Bus subject the worker subscribes to for cancellation signals. */
  cancelSubject: z.string().min(1),
  /** Selected provider suspension behavior for this execution. */
  suspensionStrategy: SuspensionStrategySchema.default('wait-in-process'),
  /** Process that owns durable terminal state and lifecycle publication. */
  terminalAuthority: z.enum(['worker', 'authority']).optional(),
  /** Portable workspace reference retained while a worker starts. */
  materializationSpec: WorkerMaterializationSpecSchema.optional(),
});

export type WorkflowWorkerConfig = z.infer<typeof WorkflowWorkerConfigSchema>;

// ─────────────────────────────────────────────────────────────
// Worker Runtime Context (ephemeral, worker-local)
// ─────────────────────────────────────────────────────────────

/**
 * Ephemeral realization context produced by the materializer on the worker.
 *
 * Contains worker-local absolute paths and platform information. This type
 * is NEVER persisted as part of {@link WorkflowRunContext} or any durable
 * record. It exists only for the lifetime of a single worker process and
 * is constructed from the portable {@link WorkerMaterializationSpec} after
 * the materializer resolves the workspace on the local filesystem.
 *
 * - `workspaceRoot`: absolute path to the realized workspace root on this worker.
 * - `sourcePath`: absolute path to the workflow source file within the workspace.
 * - `contributionEntrypoints`: absolute paths to resolved contribution entrypoints.
 * - `platform`: worker operating system (`darwin`, `linux`, `win32`).
 * - `arch`: worker CPU architecture (e.g. `arm64`, `x64`).
 */
export interface WorkerRuntimeContext {
  /** Absolute path to the realized workspace root on this worker. */
  readonly workspaceRoot: string;
  /** Absolute path to the workflow source file within the workspace. */
  readonly sourcePath: string;
  /** Absolute paths to resolved contribution entrypoints in load order. */
  readonly contributionEntrypoints: readonly string[];
  /** Worker operating system. */
  readonly platform: 'darwin' | 'linux' | 'win32';
  /** Worker CPU architecture (e.g. `'arm64'`, `'x64'`). */
  readonly arch: string;
}

// ─────────────────────────────────────────────────────────────
// Worker Run Result
// ─────────────────────────────────────────────────────────────

/**
 * Shared identity fields present on every workflow run result variant.
 */
interface WorkflowRunResultBase {
  /** Unique identifier for this execution run. */
  readonly executionId: string;
  /** Workflow definition identifier. */
  readonly workflowId: string;
}

/**
 * Result produced when execution completes successfully.
 *
 * Carries an optional {@link ArtifactRevision} written by the workflow.
 * Never carries top-level output, error, reason, or pause identity fields.
 */
export interface WorkflowCompletedRunResult extends WorkflowRunResultBase {
  /** Completed execution status. */
  readonly status: 'completed';
  /** Artifact revision written by the workflow, if any. */
  readonly artifact?: ArtifactRevision;
  /** Top-level output is no longer carried on run results. */
  readonly output?: never;
  /** Error is only valid on failed results. */
  readonly error?: never;
  /** Reason is only valid on cancelled results. */
  readonly reason?: never;
  /** Pause identity is only valid for paused results. */
  readonly pausedAtGateId?: never;
  /** Pause identity is only valid for paused results. */
  readonly pausedAtFrameId?: never;
}

/**
 * Result produced when execution terminates with an error.
 *
 * Carries a required human-readable {@link error} string describing the failure.
 */
export interface WorkflowFailedRunResult extends WorkflowRunResultBase {
  /** Failed execution status. */
  readonly status: 'failed';
  /** Human-readable description of the failure. */
  readonly error: string;
  /** Artifact is only valid on completed results. */
  readonly artifact?: never;
  /** Top-level output is not carried on run results. */
  readonly output?: never;
  /** Reason is only valid on cancelled results. */
  readonly reason?: never;
  /** Pause identity is only valid for paused results. */
  readonly pausedAtGateId?: never;
  /** Pause identity is only valid for paused results. */
  readonly pausedAtFrameId?: never;
}

/**
 * Result produced when execution is stopped by an abort signal.
 *
 * Carries an optional human-readable {@link reason} string.
 */
export interface WorkflowCancelledRunResult extends WorkflowRunResultBase {
  /** Cancelled execution status. */
  readonly status: 'cancelled';
  /** Optional human-readable description of why execution was cancelled. */
  readonly reason?: string;
  /** Artifact is only valid on completed results. */
  readonly artifact?: never;
  /** Top-level output is not carried on run results. */
  readonly output?: never;
  /** Error is only valid on failed results. */
  readonly error?: never;
  /** Pause identity is only valid for paused results. */
  readonly pausedAtGateId?: never;
  /** Pause identity is only valid for paused results. */
  readonly pausedAtFrameId?: never;
}

/**
 * Result produced when execution parks at a gate and will resume later.
 *
 * Both {@link pausedAtGateId} and {@link pausedAtFrameId} are required to
 * uniquely identify the suspended gate frame for redispatch.
 */
export interface WorkflowPausedRunResult extends WorkflowRunResultBase {
  /**
   * Execution suspended at a gate; the worker has exited and will be
   * redispatched or resumed when the gate resolves.
   */
  readonly status: 'paused';
  /** Node ID of the gate at which execution paused. */
  readonly pausedAtGateId: string;
  /** Frame ID of the suspended gate instance at which execution paused. */
  readonly pausedAtFrameId: string;
  /** Artifact is only valid on completed results. */
  readonly artifact?: never;
  /** Top-level output is not carried on run results. */
  readonly output?: never;
  /** Error is only valid on failed results. */
  readonly error?: never;
  /** Reason is only valid on cancelled results. */
  readonly reason?: never;
}

/**
 * Result produced when a workflow execution completes in an isolated worker.
 *
 * Fully serializable so it can be transferred across process / thread
 * boundaries (Piscina worker threads, child processes, Docker containers).
 *
 * Discriminated on `status`:
 * - `completed`: finished successfully — carries an optional artifact revision
 * - `failed`: terminated with an error — carries a required error string
 * - `cancelled`: stopped by an abort signal — carries an optional reason
 * - `paused`: parked at a gate — carries required pause identity fields
 *
 * NOTE: A companion {@link WorkflowRunResultSchema} exists for runtime
 * validation. Both definitions must stay in sync.
 */
export type WorkflowRunResult =
  | WorkflowCompletedRunResult
  | WorkflowFailedRunResult
  | WorkflowCancelledRunResult
  | WorkflowPausedRunResult;

/** Base Zod fields shared by all result variants. */
const WorkflowRunResultBaseSchema = z.object({
  /** Unique identifier for this execution run. */
  executionId: z.string().min(1),
  /** Workflow definition identifier. */
  workflowId: z.string().min(1),
});

/**
 * Zod schema for the serializable result returned by isolated workflow workers.
 *
 * Each variant uses `.strict()` to reject unknown fields (including the
 * former top-level `output` field) at runtime.
 *
 * When `status` is `'paused'`, both `pausedAtGateId` and `pausedAtFrameId`
 * are required to uniquely identify the suspended gate frame.
 */
export const WorkflowRunResultSchema = z.discriminatedUnion('status', [
  WorkflowRunResultBaseSchema.extend({
    /** Completed execution status. */
    status: z.literal('completed'),
    /** Artifact revision written by the workflow, if any. */
    artifact: ArtifactRevisionSchema.optional(),
  }).strict(),
  WorkflowRunResultBaseSchema.extend({
    /** Failed execution status. */
    status: z.literal('failed'),
    /** Human-readable description of the failure. */
    error: z.string().min(1),
  }).strict(),
  WorkflowRunResultBaseSchema.extend({
    /** Cancelled execution status. */
    status: z.literal('cancelled'),
    /** Optional human-readable description of why execution was cancelled. */
    reason: z.string().min(1).optional(),
  }).strict(),
  WorkflowRunResultBaseSchema.extend({
    /** Paused execution status. */
    status: z.literal('paused'),
    /** Node ID of the gate at which execution paused. */
    pausedAtGateId: z.string().min(1),
    /** Frame ID of the suspended gate instance at which execution paused. */
    pausedAtFrameId: z.string().min(1),
  }).strict(),
]);

// ─────────────────────────────────────────────────────────────
// Worker Contribution Manifest
// ─────────────────────────────────────────────────────────────

/**
 * Reference to an extension package that a workflow worker process should import.
 *
 * Fully serializable so it can cross worker-thread, process, container, or
 * remote host boundaries without carrying runtime objects.
 *
/**
 * Serializable manifest declaring the exact worker-local extension packages.
 *
 * Product pool dispatch resolves project-level package pins into this exact
 * identity before provisioning. Materializers verify every ref, and workers
 * load only the verified worker-local entrypoints returned by materialization.
 */
export const WorkerContributionManifestSchema = z
  .object({
    /** Exact package identity and SRI integrity for every worker contribution. */
    contributionRefs: z.array(WorkerContributionRefSchema),
  })
  .strict();

export type WorkerContributionManifest = z.infer<typeof WorkerContributionManifestSchema>;

/**
 * Optional controls for one workflow runner invocation.
 */
export interface WorkflowRunnerRunOptions {
  /**
   * Local owner admission around durable attempt creation only. A runner must
   * release this boundary before dispatching or awaiting the workload outcome.
   * This callback never travels in worker configuration or dispatch metadata.
   * Direct runner consumers that omit it own their own admission policy.
   * @param create - Creation operation executed only while the owner permits new work.
   * @returns The result of the admitted creation operation.
   * @typeParam T - Creation result retained by the dispatch runner.
   */
  readonly withAttemptCreation?: <T>(create: () => Promise<T>) => Promise<T>;
  /**
   * Opaque metadata forwarded to dispatch layers that support it.
   *
   * Runners that do not call through Worker dispatch may ignore this.
   */
  readonly dispatchMetadata?: z.infer<typeof JsonObjectContractSchema>;
}

// ─────────────────────────────────────────────────────────────
// Workflow Runner Completion
// ─────────────────────────────────────────────────────────────

/**
 * Envelope returned by {@link IWorkflowRunner.run} that tells the caller
 * whether the terminal result has already been durably committed by an
 * Authority or still needs host-side finalization.
 *
 * - `uncommitted`: the runner produced the result but the durable lifecycle
 *   transition has not been performed. The host executor must finalize or
 *   park the execution (in-process and Piscina runners).
 * - `authority-committed`: the Authority outcome RPC has converged canonical
 *   state. The host executor verifies durable state but must not invoke
 *   the fallback finalizer (Worker dispatch runners).
 */
export type WorkflowRunnerCompletion =
  | { readonly state: 'uncommitted'; readonly result: WorkflowRunResult }
  | { readonly state: 'authority-committed'; readonly result: WorkflowRunResult };

// ─────────────────────────────────────────────────────────────
// Workflow Runner Interface
// ─────────────────────────────────────────────────────────────

/**
 * Contract for dispatching a full workflow execution to an isolated environment.
 *
 * Implementations may use worker threads (Piscina), child processes, or
 * containers. The executor delegates to this interface so the dispatch
 * strategy is swappable without changing the engine.
 */
export interface IWorkflowRunner {
  /**
   * Completion ownership known before the owner persists and starts a run.
   * Authority runners return an authority-committed completion; worker runners
   * leave finalization to the invoking executor. Omission retains the worker
   * completion protocol. This declaration does not select a compute provider.
   */
  readonly terminalAuthority?: 'authority' | 'worker';

  /**
   * Execute a complete workflow in an isolated worker.
   *
   * When `manifest` is supplied it takes precedence over any manifest baked
   * into the runner at construction time, enabling per-call contribution
   * sets (e.g. when the Worker pool dispatches with a request-specific
   * manifest). Callers that do not need per-call control may omit it.
   * @param config - Full workflow worker configuration including source, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @param manifest - Optional per-call contribution manifest. Overrides the runner's default.
   * @param options - Optional per-run controls for dispatch-capable runners.
   * @returns Completion envelope indicating whether the result needs host finalization.
   */
  run(
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    manifest?: WorkerContributionManifest,
    options?: WorkflowRunnerRunOptions,
  ): Promise<WorkflowRunnerCompletion>;

  /**
   * Release underlying resources (thread pool, processes, connections).
   *
   * Optional: runners that share resources may choose not to implement this.
   */
  dispose?(): Promise<void>;
}
