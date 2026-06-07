import { z } from 'zod';
import { WorkflowDefinitionSchema, WorkflowExecutionScopeSchema } from './schemas.js';
import { JsonObjectContractSchema, JsonValueSchema, type JsonValue } from '../shared/json-value.js';
import { WorkflowArtifactRefSchema } from './artifact-ref.js';
import { ExecutionHintsSchema } from './execution-hints.js';
import { SuspensionStrategySchema } from '../worker-node/suspension.js';

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
   * Serialized workflow definition for `'definition'`-sourced workers.
   *
   * When `source.kind === 'definition'`, the executor populates this field so
   * the worker can construct a {@link LoadedWorkflow} directly without querying
   * storage. Absent for `'path'` and `'source'` kinds.
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
  /** Platform and workspace context for expression resolution and tool access. */
  context: z.object({
    /** Absolute path to the active repository root. */
    repoPath: z.string().min(1),
    /** Absolute path to the Makaio home directory. */
    makaioHome: z.string().min(1),
    /** Host operating system. */
    os: z.enum(['darwin', 'linux', 'win32']),
    /** CPU architecture (e.g. `'arm64'`, `'x64'`). */
    arch: z.string().min(1),
    /** Active git worktree path, if different from `repoPath`. */
    worktree: z.string().optional(),
  }),
  /**
   * Extra environment variables injected into the worker process.
   * Merged with the runtime environment; values are fully resolved strings.
   */
  env: z.record(z.string(), z.string()).default({}),
  /** Coordinator session ID that owns this execution. */
  coordinatorSessionId: z.string().min(1),
  /**
   * Advisory worker provisioning hints supplied by the start request.
   * Runners may inspect these values before selecting a concrete execution host.
   */
  executionHints: ExecutionHintsSchema.optional(),
  /** Bus subject the worker subscribes to for cancellation signals. */
  cancelSubject: z.string().min(1),
  /** Selected provider suspension behavior for this execution. */
  suspensionStrategy: SuspensionStrategySchema.default('wait-in-process'),
});

export type WorkflowWorkerConfig = z.infer<typeof WorkflowWorkerConfigSchema>;

// ─────────────────────────────────────────────────────────────
// Worker Run Result
// ─────────────────────────────────────────────────────────────

/**
 * Result produced when a workflow execution completes in an isolated worker.
 *
 * Fully serializable so it can be transferred across process / thread
 * boundaries (Piscina worker threads, child processes, Docker containers).
 *
 * NOTE: A companion {@link WorkflowRunResultSchema} exists for runtime
 * validation. Both definitions must stay in sync.
 */
interface WorkflowRunResultBase {
  /** Unique identifier for this execution run. */
  readonly executionId: string;
  /** Workflow definition identifier. */
  readonly workflowId: string;
  /** Final output produced by the workflow, if any. */
  readonly output?: JsonValue;
}

/**
 * Result produced when execution reaches a terminal, non-paused status.
 */
type WorkflowTerminalRunResult = WorkflowRunResultBase & {
  /**
   * Terminal status of the execution.
   *
   * - `completed`: execution finished successfully
   * - `failed`: execution terminated with an error
   * - `cancelled`: execution was stopped by an abort signal
   */
  readonly status: 'completed' | 'failed' | 'cancelled';
  /** Pause identity is only valid for paused results. */
  readonly pausedAtGateId?: never;
  /** Pause identity is only valid for paused results. */
  readonly pausedAtFrameId?: never;
};

/**
 * Result produced when execution parks at a gate and will resume later.
 */
type WorkflowPausedRunResult = WorkflowRunResultBase & {
  /**
   * Execution suspended at a gate; the worker has exited and will be
   * redispatched or resumed when the gate resolves.
   */
  readonly status: 'paused';
  /**
   * Node ID of the gate at which execution paused.
   */
  readonly pausedAtGateId: string;
  /**
   * Frame ID of the suspended gate instance at which execution paused.
   */
  readonly pausedAtFrameId: string;
};

export type WorkflowRunResult = WorkflowTerminalRunResult | WorkflowPausedRunResult;

/**
 * Zod schema for the serializable result returned by isolated workflow workers.
 *
 * When `status` is `'paused'`, both `pausedAtGateId` and `pausedAtFrameId`
 * are required to uniquely identify the suspended gate frame.
 */
const WorkflowRunResultBaseSchema = z.object({
  /** Unique identifier for this execution run. */
  executionId: z.string().min(1),
  /** Workflow definition identifier. */
  workflowId: z.string().min(1),
  /** Final output produced by the workflow, if any. */
  output: JsonValueSchema.optional(),
});

export const WorkflowRunResultSchema = z.discriminatedUnion('status', [
  WorkflowRunResultBaseSchema.extend({
    /** Terminal execution status. */
    status: z.enum(['completed', 'failed', 'cancelled']),
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
 * remote node boundaries without carrying runtime objects.
 */
export const WorkerContributionPackageRefSchema = z.object({
  /** Package name used for diagnostics and installed-package matching. */
  name: z.string().min(1),
  /**
   * Import path for the package's server entrypoint.
   *
   * Two formats are accepted:
   * - **Absolute path** – used as-is (e.g. local-source extensions or
   *   explicit manifests supplied by the caller).
   * - **`makaioHome`-relative path** – a path relative to the Makaio home
   *   directory, e.g. `node_modules/@acme/tools/dist/server.mjs`.  The
   *   worker loader reconstructs the absolute path from the machine's own
   *   `makaioHome`, making the manifest portable across machines (local
   *   Piscina thread, Docker container, GitHub Actions runner, etc.).
   */
  importPath: z.string().min(1),
});

export type WorkerContributionPackageRef = z.infer<typeof WorkerContributionPackageRefSchema>;

/**
 * Serializable manifest declaring worker-local extension packages.
 *
 * The manifest contains concrete import paths, not project-level desired
 * package specs. Product pool dispatch resolves desired project manifests into
 * this worker manifest before provisioning a WorkerNode.
 */
export const WorkerContributionManifestSchema = z.object({
  /** Explicit packages whose server entrypoints are importable in the worker. */
  packages: z.array(WorkerContributionPackageRefSchema).default([]),
});

export type WorkerContributionManifest = z.infer<typeof WorkerContributionManifestSchema>;

/**
 * Optional controls for one workflow runner invocation.
 */
export interface WorkflowRunnerRunOptions {
  /**
   * Opaque metadata forwarded to dispatch layers that support it.
   *
   * Runners that do not call through WorkerNode dispatch may ignore this.
   */
  readonly dispatchMetadata?: z.infer<typeof JsonObjectContractSchema>;
}

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
   * Execute a complete workflow in an isolated worker.
   *
   * When `manifest` is supplied it takes precedence over any manifest baked
   * into the runner at construction time, enabling per-call contribution
   * sets (e.g. when the WorkerNode pool dispatches with a request-specific
   * manifest). Callers that do not need per-call control may omit it.
   * @param config - Full workflow worker configuration including source, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @param manifest - Optional per-call contribution manifest. Overrides the runner's default.
   * @param options - Optional per-run controls for dispatch-capable runners.
   * @returns The execution result with terminal status and optional output.
   */
  run(
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    manifest?: WorkerContributionManifest,
    options?: WorkflowRunnerRunOptions,
  ): Promise<WorkflowRunResult>;

  /**
   * Release underlying resources (thread pool, processes, connections).
   *
   * Optional: runners that share resources may choose not to implement this.
   */
  dispose?(): Promise<void>;
}
