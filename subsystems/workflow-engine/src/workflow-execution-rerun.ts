import { WorkflowError, WorkflowErrorCode, type WorkflowDefinition, type WorkflowRunContext } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import type { DefinitionStartOptions, StartExecutionDeps } from './workflow-execution-start.js';
import { startExecution, startResolvedDefinitionExecution } from './workflow-execution-start.js';

/**
 * Options accepted by {@link rerunExecution}.
 */
export interface RerunExecutionOptions extends DefinitionStartOptions {
  /** Execution to replay. */
  readonly executionId: string;
  /** Replay mode: `snapshot` re-uses the original definition; `current` loads the latest. */
  readonly mode: 'snapshot' | 'current';
  /** Human-readable reason for the rerun (stored in link metadata). */
  readonly reason?: string;
}

/**
 * Load the original run context for the execution being rerun.
 * @param deps - Executor dependencies providing the bus.
 * @param executionId - Execution to look up.
 * @returns The persisted run context.
 * @throws When the run context is not found.
 */
async function loadOriginalRunContext(deps: StartExecutionDeps, executionId: string): Promise<WorkflowRunContext> {
  const { runContext } = await deps.bus.request(WorkflowStorageSubjects.getRunContext, {
    executionId,
  });
  if (runContext === null) {
    throw new WorkflowError(
      WorkflowErrorCode.RUN_CONTEXT_NOT_FOUND,
      `Run context not found for workflow execution '${executionId}'.`,
    );
  }
  return runContext;
}

/**
 * Build the metadata record stored on the provenance link.
 * @param mode - Rerun mode.
 * @param reason - Optional human-readable reason.
 * @returns Link metadata.
 */
function buildRerunLinkMetadata(mode: 'snapshot' | 'current', reason: string | undefined): Record<string, unknown> {
  return reason === undefined ? { mode } : { mode, reason };
}

/**
 * Rerun a workflow execution with a persisted run context.
 *
 * Rerun intentionally keys off the durable run context rather than the
 * execution row status. Recovery, paused resume, failed retry, and completed
 * replay all need the same immutable start metadata.
 *
 * Two modes are supported:
 * - `snapshot`: re-executes using the original execution's
 *   {@link WorkflowRunContext.definitionSnapshot}.
 * - `current`: re-executes using the latest stored workflow definition.
 *
 * Both modes record provenance via an execution link with `linkType: 'rerun-of'`.
 * Request-level overrides win over original run-context values.
 * @param deps - Shared executor state and callbacks.
 * @param options - Rerun configuration.
 * @returns The new execution ID.
 */
export async function rerunExecution(deps: StartExecutionDeps, options: RerunExecutionOptions): Promise<string> {
  const originalRunContext = await loadOriginalRunContext(deps, options.executionId);
  const input = options.input === undefined ? originalRunContext.inputs : options.input;
  const config = options.config ?? originalRunContext.config ?? {};
  const triggerPayload = options.triggerPayload ?? originalRunContext.triggerPayload;
  const artifactRef = options.artifactRef ?? originalRunContext.artifactRef;
  const executionHints =
    options.executionHints ?? (options.mode === 'snapshot' ? originalRunContext.executionHints : undefined);
  const scopeOverride = options.scopeOverride ?? originalRunContext.scope;

  const startOptions: DefinitionStartOptions = {
    input,
    config,
    parentSessionId: options.parentSessionId,
    triggerPayload,
    artifactRef,
    executionHints,
    scopeOverride,
    executionLinks: (rerunExecutionId) => [
      {
        sourceExecutionId: options.executionId,
        targetExecutionId: rerunExecutionId,
        linkType: 'rerun-of',
        metadata: buildRerunLinkMetadata(options.mode, options.reason),
      },
    ],
  };

  const rerunExecutionId =
    options.mode === 'snapshot'
      ? await rerunSnapshot(deps, originalRunContext, startOptions)
      : isEphemeralSourceBacked(originalRunContext)
        ? await rerunCurrentSourceBacked(deps, originalRunContext, startOptions)
        : await startExecution(deps, originalRunContext.workflowId, startOptions);

  return rerunExecutionId;
}

/**
 * Resolve the logical workflow definition ID for a snapshot replay.
 *
 * Ephemeral source-backed starts use `executionId` as `workflowId` so the
 * execution can be persisted without a definition row. Once a runner has loaded
 * and stored a snapshot, rerunning that snapshot should dispatch under the
 * loaded definition's ID. Definition-backed executions already have a stable
 * workflow ID and keep it unchanged.
 * @param originalRunContext - Durable context for the execution being rerun.
 * @param workflow - Snapshot definition selected for replay.
 * @returns Logical workflow ID for the new rerun execution.
 */
function resolveSnapshotRerunWorkflowId(originalRunContext: WorkflowRunContext, workflow: WorkflowDefinition): string {
  if (isEphemeralSourceBacked(originalRunContext)) {
    return workflow.id;
  }
  return originalRunContext.workflowId;
}

/**
 * Check whether a run context came from an ephemeral source-backed start.
 * @param runContext - Durable context for the execution being rerun.
 * @returns True when the logical workflow ID was the original execution ID.
 */
function isEphemeralSourceBacked(runContext: WorkflowRunContext): boolean {
  return runContext.source.kind !== 'definition' && runContext.workflowId === runContext.executionId;
}

/**
 * Execute a snapshot-mode rerun using the original definition snapshot.
 * @param deps - Shared executor state and callbacks.
 * @param originalRunContext - The original execution's run context.
 * @param overrides - Caller-supplied option overrides.
 * @returns The new execution ID.
 * @throws When the original execution has no definition snapshot.
 */
async function rerunSnapshot(
  deps: StartExecutionDeps,
  originalRunContext: WorkflowRunContext,
  overrides: DefinitionStartOptions,
): Promise<string> {
  const workflow = originalRunContext.definitionSnapshot;
  if (workflow === undefined) {
    throw new WorkflowError(
      WorkflowErrorCode.SNAPSHOT_UNAVAILABLE,
      `Workflow execution '${originalRunContext.executionId}' does not have a definition snapshot.`,
    );
  }

  return startResolvedDefinitionExecution(deps, resolveSnapshotRerunWorkflowId(originalRunContext, workflow), {
    workflow,
    executionSource: originalRunContext.source,
    definitionSnapshot: workflow,
    input: overrides.input,
    config: overrides.config,
    parentSessionId: overrides.parentSessionId,
    triggerPayload: overrides.triggerPayload,
    artifactRef: overrides.artifactRef,
    executionHints: overrides.executionHints,
    scopeOverride: overrides.scopeOverride,
    executionLinks: overrides.executionLinks,
  });
}

/**
 * Execute a current-mode rerun for executions that were originally started
 * directly from a source file rather than a stored definition row.
 *
 * The saved snapshot supplies the logical workflow ID and launch-time binding
 * metadata, but is intentionally not passed as `definitionSnapshot`; the worker
 * must reload the current source module and own the executable topology.
 * @param deps - Shared executor state and callbacks.
 * @param originalRunContext - The original execution's run context.
 * @param overrides - Caller-supplied option overrides.
 * @returns The new execution ID.
 * @throws When the original execution has no definition snapshot.
 */
async function rerunCurrentSourceBacked(
  deps: StartExecutionDeps,
  originalRunContext: WorkflowRunContext,
  overrides: DefinitionStartOptions,
): Promise<string> {
  const workflow = originalRunContext.definitionSnapshot;
  if (workflow === undefined) {
    throw new WorkflowError(
      WorkflowErrorCode.SNAPSHOT_UNAVAILABLE,
      `Workflow execution '${originalRunContext.executionId}' does not have a definition snapshot.`,
    );
  }

  return startResolvedDefinitionExecution(deps, workflow.id, {
    workflow,
    executionSource: originalRunContext.source,
    input: overrides.input,
    config: overrides.config,
    parentSessionId: overrides.parentSessionId,
    triggerPayload: overrides.triggerPayload,
    artifactRef: overrides.artifactRef,
    executionHints: overrides.executionHints,
    scopeOverride: overrides.scopeOverride,
    executionLinks: overrides.executionLinks,
  });
}
