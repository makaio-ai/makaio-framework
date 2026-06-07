import * as os from 'node:os';
import type { SuspensionStrategy, WorkflowRunContext, WorkflowWorkerConfig } from '@makaio/contracts';
import type { ExecutorConfig } from './types.js';
import { resolveWorkerOs } from './workflow-runner-tasks.js';

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
  /** Optional artifact bound at start. */
  readonly artifactRef?: WorkflowRunContext['artifactRef'];
  /** Optional provider execution hints. */
  readonly executionHints?: WorkflowRunContext['executionHints'];
  /** Workspace root resolved for this execution. */
  readonly workspaceRoot: string;
  /** Suspension strategy selected by the caller for this execution. */
  readonly suspensionStrategy?: SuspensionStrategy;
}

/**
 * Build the worker context embedded in a {@link WorkflowRunContext}.
 *
 * The context is derived from `ExecutorConfig.platformDefaults` and the current
 * process environment. `repoPath` is the execution workspace root; `makaioHome`
 * comes from executor config, `MAKAIO_HOME`, or `~/.makaio`.
 * @param config - Executor configuration.
 * @param workspaceRoot - Resolved workspace root for this execution.
 * @returns Fully populated workflow worker context.
 */
export function resolveWorkflowContext(config: ExecutorConfig, workspaceRoot: string): WorkflowWorkerConfig['context'] {
  const makaioHome = config.makaioHome ?? process.env['MAKAIO_HOME'] ?? `${os.homedir()}/.makaio`;
  const resolvedOs = resolveWorkerOs(process.platform);

  return {
    repoPath: workspaceRoot,
    makaioHome,
    os: resolvedOs,
    arch: process.arch,
  };
}

/**
 * Build a {@link WorkflowRunContext} from invariant execution fields plus
 * caller-specific start metadata.
 * @param params - Variant fields unique to each start path.
 * @param executorConfig - Executor configuration supplying platform defaults.
 * @returns Fully populated run context ready for persistence.
 */
export function buildWorkflowRunContext(
  params: BuildWorkflowRunContextParams,
  executorConfig: ExecutorConfig,
): WorkflowRunContext {
  return {
    executionId: params.executionId,
    workflowId: params.workflowId,
    source: params.source,
    ...(params.definitionSnapshot !== undefined ? { definitionSnapshot: params.definitionSnapshot } : {}),
    workerManifest: { packages: [] },
    inputs: params.inputs,
    config: params.config,
    scope: params.scope,
    triggerPayload: params.triggerPayload,
    ...(params.artifactRef !== undefined ? { artifactRef: params.artifactRef } : {}),
    ...(params.executionHints !== undefined ? { executionHints: params.executionHints } : {}),
    coordinatorSessionId: params.coordinatorSessionId,
    cancelSubject: `workflow.${params.executionId}.cancel`,
    context: resolveWorkflowContext(executorConfig, params.workspaceRoot),
    env: executorConfig.platformDefaults.env ?? {},
    createdAt: Date.now(),
    suspensionStrategy: params.suspensionStrategy ?? 'wait-in-process',
  };
}
