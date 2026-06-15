import {
  WorkflowError,
  WorkflowErrorCode,
  type JsonValue,
  type WorkflowExecutionScope,
  type WorkflowRunContext,
} from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import type { StartExecutionDeps } from './workflow-execution-start.js';
import { startExecution, startResolvedDefinitionExecution } from './workflow-execution-start.js';

/**
 * Options accepted by {@link rerunExecution}.
 */
export interface RerunExecutionOptions {
  /** Execution to replay. */
  readonly executionId: string;
  /** Replay mode: `snapshot` re-uses the original definition; `current` loads the latest. */
  readonly mode: 'snapshot' | 'current';
  /** Override the original input payload. */
  readonly input?: JsonValue;
  /** Override the original configuration. */
  readonly config?: Record<string, unknown>;
  /** Optional parent coordinator session for the rerun. */
  readonly parentSessionId?: string;
  /** Override the original trigger payload. */
  readonly triggerPayload?: Record<string, unknown>;
  /** Override the original artifact binding reference. */
  readonly artifactRef?: WorkflowRunContext['artifactRef'];
  /** Override the original execution hints. */
  readonly executionHints?: WorkflowRunContext['executionHints'];
  /** Override the original execution scope. */
  readonly scopeOverride?: WorkflowExecutionScope;
  /** Human-readable reason for the rerun (stored in link metadata). */
  readonly reason?: string;
}

/**
 * Format a {@link WorkflowError} as a plain `Error` with the code prefix.
 *
 * Bus handlers wrap errors in generic `Error` instances during transport, so
 * the code must be embedded in the message string for callers to match on.
 * @param error - Workflow error to format.
 * @returns Plain error with `"CODE: message"` format.
 */
function withCode(error: WorkflowError): Error {
  return new Error(`${error.code}: ${error.message}`);
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
    throw withCode(
      new WorkflowError(
        WorkflowErrorCode.RUN_CONTEXT_NOT_FOUND,
        `Run context not found for workflow execution '${executionId}'.`,
      ),
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
 * Rerun a completed workflow execution.
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
  const executionHints = options.executionHints ?? originalRunContext.executionHints;
  const scopeOverride = options.scopeOverride ?? originalRunContext.scope;

  const rerunExecutionId =
    options.mode === 'snapshot'
      ? await rerunSnapshot(deps, originalRunContext, {
          input,
          config,
          parentSessionId: options.parentSessionId,
          triggerPayload,
          artifactRef,
          executionHints,
          scopeOverride,
        })
      : await startExecution(deps, originalRunContext.workflowId, {
          input,
          config,
          parentSessionId: options.parentSessionId,
          triggerPayload,
          artifactRef,
          executionHints,
          scopeOverride,
        });

  await deps.bus.request(WorkflowStorageSubjects.setExecutionLink, {
    link: {
      sourceExecutionId: options.executionId,
      targetExecutionId: rerunExecutionId,
      linkType: 'rerun-of',
      metadata: buildRerunLinkMetadata(options.mode, options.reason),
    },
  });

  return rerunExecutionId;
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
  overrides: Omit<RerunExecutionOptions, 'executionId' | 'mode' | 'reason'>,
): Promise<string> {
  const workflow = originalRunContext.definitionSnapshot;
  if (workflow === undefined) {
    throw withCode(
      new WorkflowError(
        WorkflowErrorCode.SNAPSHOT_UNAVAILABLE,
        `Workflow execution '${originalRunContext.executionId}' does not have a definition snapshot.`,
      ),
    );
  }

  return startResolvedDefinitionExecution(deps, originalRunContext.workflowId, {
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
  });
}
