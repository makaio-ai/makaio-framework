import type { WorkflowWorkerConfig, WorkerContributionManifest } from '@makaio/contracts';
import { materializeLocalDirectory, type WorkspaceRootResolver } from './local-directory-materializer.js';

/** A worker task whose filesystem references were realized and verified on this host. */
export interface MaterializedWorkerTask {
  /** Configuration whose path source points at the verified local path. */
  readonly config: WorkflowWorkerConfig;
  /** Verified worker-local entrypoints in manifest order. */
  readonly contributionEntrypoints: readonly string[];
}

/**
 * Realize portable filesystem references before a task is handed to a worker thread.
 * @param options - Host workspace-root resolver, required for path sources and declared contributions.
 * @param config - Portable worker configuration.
 * @param manifest - Exact contribution identities for this execution.
 * @param signal - Cancellation signal for the dispatch.
 * @returns Configuration and entrypoints with verified local paths.
 */
export async function materializeWorkerTask(
  options: { readonly resolveWorkspaceRoot?: WorkspaceRootResolver },
  config: WorkflowWorkerConfig,
  manifest: WorkerContributionManifest,
  signal: AbortSignal,
): Promise<MaterializedWorkerTask> {
  signal.throwIfAborted();
  if (config.source.kind !== 'path' && manifest.contributionRefs.length === 0) {
    return { config, contributionEntrypoints: [] };
  }

  const spec = config.materializationSpec;
  if (spec?.kind !== 'local-directory') {
    throw new Error(
      'ThinWorkflowPiscinaRunner requires a local-directory materialization spec for path-backed workflows or declared contributions.',
    );
  }
  if (options.resolveWorkspaceRoot === undefined) {
    throw new Error(
      'ThinWorkflowPiscinaRunner requires a host workspace-root resolver for local-directory materialization.',
    );
  }

  const runtimeContext = await materializeLocalDirectory(spec, manifest.contributionRefs, {
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
  });
  signal.throwIfAborted();
  if (config.source.kind !== 'path') {
    throw new Error('local-directory materialization requires a path-backed workflow source.');
  }
  return {
    config: { ...config, source: { kind: 'path', path: runtimeContext.sourcePath } },
    contributionEntrypoints: runtimeContext.contributionEntrypoints,
  };
}
