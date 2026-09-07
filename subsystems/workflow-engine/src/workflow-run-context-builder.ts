import { WorkflowRunContextSchema, type SuspensionStrategy, type WorkflowRunContext } from '@makaio/contracts';
import type { ExecutorConfig } from './types.js';

/**
 * Variant fields supplied by each workflow execution start path.
 */
export interface BuildWorkflowRunContextParams {
  /** Execution identifier allocated for this run. */
  readonly executionId: string;
  /** Workflow definition identifier. */
  readonly workflowId: string;
  /** Session coordinating this execution. */
  readonly coordinatorSessionId: string;
  /** Source descriptor used to redispatch or inspect this run. */
  readonly source: WorkflowRunContext['source'];
  /** Optional persisted definition snapshot for resume/replay. */
  readonly definitionSnapshot?: WorkflowRunContext['definitionSnapshot'];
  /** Normalized workflow input payload. */
  readonly inputs: WorkflowRunContext['inputs'];
  /** Normalized workflow config payload. */
  readonly config: WorkflowRunContext['config'];
  /** Execution scope. */
  readonly scope: WorkflowRunContext['scope'];
  /** Trigger payload that started this execution. */
  readonly triggerPayload: WorkflowRunContext['triggerPayload'];
  /** Whether execution starts immediately or waits for a declared trigger. */
  readonly triggerMode?: WorkflowRunContext['triggerMode'];
  /** Optional artifact bound at start. */
  readonly artifactRef?: WorkflowRunContext['artifactRef'];
  /** Suspension strategy selected by the caller for this execution. */
  readonly suspensionStrategy?: SuspensionStrategy;
  /** Terminal owner selected by execution dispatch before the context is persisted. */
  readonly terminalAuthority?: WorkflowRunContext['terminalAuthority'];
  /**
   * Portable materialization specification for path-backed workflows.
   *
   * Required when `source.kind === 'path'` so the worker can obtain its
   * workspace contents without an Authority-local absolute path. The host
   * seam resolves this before calling execution start.
   */
  readonly materializationSpec?: WorkflowRunContext['materializationSpec'];
}

/**
 * Build a {@link WorkflowRunContext} from invariant execution fields plus
 * caller-specific start metadata.
 *
 * The run context is portable: it contains no Authority-local absolute paths,
 * OS, or architecture information. Ephemeral runtime context (workspace root,
 * platform, contribution entrypoints) is derived locally on the worker at
 * execution time via the {@link WorkerRuntimeContext} contract.
 * @param params - Variant fields unique to each start path.
 * @param executorConfig - Executor configuration supplying platform defaults.
 * @returns Fully populated run context ready for persistence.
 */
export function buildWorkflowRunContext(
  params: BuildWorkflowRunContextParams,
  executorConfig: ExecutorConfig,
): WorkflowRunContext {
  return WorkflowRunContextSchema.parse({
    executionId: params.executionId,
    workflowId: params.workflowId,
    source: params.source,
    ...(params.definitionSnapshot !== undefined ? { definitionSnapshot: params.definitionSnapshot } : {}),
    workerManifest: { contributionRefs: [] },
    inputs: params.inputs,
    config: params.config,
    scope: params.scope,
    triggerPayload: params.triggerPayload,
    triggerMode: params.triggerMode ?? 'immediate',
    ...(params.artifactRef !== undefined ? { artifactRef: params.artifactRef } : {}),
    coordinatorSessionId: params.coordinatorSessionId,
    cancelSubject: `workflow.${params.executionId}.cancel`,
    env: executorConfig.platformDefaults.env ?? {},
    createdAt: Date.now(),
    suspensionStrategy: params.suspensionStrategy ?? 'wait-in-process',
    ...(params.terminalAuthority !== undefined ? { terminalAuthority: params.terminalAuthority } : {}),
    ...(params.materializationSpec !== undefined ? { materializationSpec: params.materializationSpec } : {}),
  });
}
