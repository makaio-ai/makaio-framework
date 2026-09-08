import { createLocalGitSourceRealizer, type LocalGitSourceOptions } from '../workspace-preparation/git-source.js';
import { bindLocalWorkspace } from '../workspace-preparation/workspace-preparation.js';
import type { WorkloadInvocationPreparation } from './workload-invocation.js';

/**
 * Create local Workspace Preparation that realizes declared Git sources.
 *
 * Repository access remains host-owned through {@link LocalGitSourceOptions}.
 * The returned Preparation is passed to an admitted workload invocation; it
 * does not acquire sources until that invocation prepares a Workspace.
 * @param options - Host-local repository resolver and Git command budget.
 * @returns Preparation that binds a Workspace and realizes its Git sources.
 */
export function createLocalGitWorkspacePreparation(options: LocalGitSourceOptions): WorkloadInvocationPreparation {
  const realizeSource = createLocalGitSourceRealizer(options);
  return {
    prepare: (input) => bindLocalWorkspace({ ...input, realizeSource }),
  };
}

export type { LocalGitSourceOptions } from '../workspace-preparation/git-source.js';
