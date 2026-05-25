import { z } from 'zod';
import { WorkflowDefinitionSchema, WorkflowExecutionScopeSchema } from './schemas.js';
import { JsonObjectContractSchema, type JsonValue } from '../shared/json-value.js';

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
   * Bound workflow input values for this execution.
   * Available to workflow expressions as `inputs.*`.
   */
  inputs: JsonObjectContractSchema.default({}),
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
  /** Bus subject the worker subscribes to for cancellation signals. */
  cancelSubject: z.string().min(1),
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
 */
export interface WorkflowRunResult {
  /** Unique identifier for this execution run. */
  readonly executionId: string;
  /** Workflow definition identifier. */
  readonly workflowId: string;
  /**
   * Terminal status of the execution.
   *
   * - `completed`: execution finished successfully
   * - `failed`: execution terminated with an error
   * - `cancelled`: execution was stopped by an abort signal
   */
  readonly status: 'completed' | 'failed' | 'cancelled';
  /** Final output produced by the workflow, if any. */
  readonly output?: JsonValue;
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
   * @param config - Full workflow worker configuration including source, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @returns The execution result with terminal status and optional output.
   */
  run(config: WorkflowWorkerConfig, signal: AbortSignal): Promise<WorkflowRunResult>;

  /**
   * Release underlying resources (thread pool, processes, connections).
   *
   * Optional: runners that share resources may choose not to implement this.
   */
  dispose?(): Promise<void>;
}
