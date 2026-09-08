import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExecutionAttemptWorkspaceBinding, WorkspaceRequirement } from '@makaio/contracts';
import { assertContainedIn, assertNoSymlinkEscape } from '../workflow-worker/local-directory-materializer.js';
import { runSetupCommand, type SetupCommandResult } from './setup-command.js';

/** First failed setup command, or successful completion of the complete frozen recipe. */
export interface WorkspaceSetupResult extends SetupCommandResult {
  readonly commandIndex?: number;
}

/** Setup inputs supplied by the host, not stored in the portable workspace requirement. */
export interface WorkspaceSetupOptions {
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

/** A local realization whose release remains an explicit caller decision. */
export interface LocalWorkspaceHandle {
  readonly binding: ExecutionAttemptWorkspaceBinding;
  /** Execute the already-authorized recipe; failures retain the handle and files. */
  runSetup(options?: WorkspaceSetupOptions): Promise<WorkspaceSetupResult>;
  /** Call only after preservation policy permits release. External roots are never deleted. */
  release(): Promise<void>;
}

/** Locally resolved root plus its portable preparation requirements. */
export interface LocalWorkspaceOptions {
  readonly requirement: WorkspaceRequirement;
  readonly workspaceRoot: string;
  readonly signal?: AbortSignal;
  /** Installed source strategy; source access remains local to the host. */
  readonly realizeSource?: LocalWorkspaceSourceRealizer;
}

/** Populate an already-contained source directory without acquiring another cleanup owner. */
export type LocalWorkspaceSourceRealizer = (input: {
  readonly source: NonNullable<WorkspaceRequirement['sourceRoots'][number]['source']>;
  readonly destination: string;
  readonly signal?: AbortSignal;
}) => Promise<void>;

/**
 * Resolve source directories while checking existing ancestors before any creation.
 * @param root - Canonical workspace root.
 * @param relativePath - Declared workspace-relative directory.
 * @param create - Whether missing source directories may be created.
 * @returns Canonical source directory contained in the workspace.
 */
async function resolveSourceRoot(root: string, relativePath: string, create: boolean): Promise<string> {
  if (path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').includes('..')) {
    throw new Error('Source root must be workspace-relative');
  }
  let current = root;
  for (const segment of relativePath.split('/').filter((part) => part !== '' && part !== '.')) {
    current = path.join(current, segment);
    assertContainedIn(current, root, 'Source root');
    await assertNoSymlinkEscape(current, root, 'Source root', root);
    if (create)
      await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    if (!(await fs.stat(current)).isDirectory()) throw new Error('Source root must be a directory');
  }
  return assertNoSymlinkEscape(current, root, 'Source root', root);
}

/**
 * Bind an existing directory or create a fresh one, independently of custody.
 * Setup is deliberately separate: a failed command leaves the handle available
 * for diagnosis and caller-controlled release. Acquisition uses the injected
 * strategy; failed acquisition retains partial files without returning a usable binding.
 * @param options - Approved requirement and explicit local root locator.
 * @returns Binding, bounded setup and one-shot release operations.
 */
export async function bindLocalWorkspace(options: LocalWorkspaceOptions): Promise<LocalWorkspaceHandle> {
  options.signal?.throwIfAborted();
  const { requirement } = options;
  const workspaceRoot = path.resolve(options.workspaceRoot);
  if (!path.isAbsolute(options.workspaceRoot) || workspaceRoot === path.parse(workspaceRoot).root) {
    throw new Error('Workspace root must be an absolute, non-filesystem-root directory');
  }
  if (requirement.sourceRoots.length > 1) throw new Error('Multiple source roots are not implemented');
  if (requirement.sourceRoots.some((source) => source.source !== undefined)) {
    // The default headless composition deliberately installs no source strategy.
    // Public host-owned preparation wiring is a separate integration boundary;
    // a source instruction alone does not grant local repository access.
    if (options.realizeSource === undefined) throw new Error('Source acquisition requires an installed strategy');
    // This first acquisition path supports fresh owned roots, not all custody combinations.
    if (requirement.provisioning !== 'create' || requirement.custody !== 'disposable') {
      throw new Error('Source acquisition currently requires a created disposable workspace');
    }
  }
  if (requirement.provisioning === 'create') await fs.mkdir(workspaceRoot);
  if (!(await fs.lstat(workspaceRoot)).isDirectory())
    throw new Error('Workspace root must be a directory, not a symlink');
  const canonicalRoot = await fs.realpath(workspaceRoot);
  const sourceRoots: ExecutionAttemptWorkspaceBinding['sourceRoots'] = [];
  for (const source of requirement.sourceRoots) {
    const sourcePath = await resolveSourceRoot(canonicalRoot, source.path, requirement.provisioning === 'create');
    if (source.source !== undefined) {
      await options.realizeSource!({ source: source.source, destination: sourcePath, signal: options.signal });
      options.signal?.throwIfAborted();
    }
    sourceRoots.push({
      id: source.id,
      path: sourcePath,
    });
  }
  return createHandle(requirement, { workspaceRoot: canonicalRoot, sourceRoots });
}

/**
 * Keep local command ownership and release in one handle, without deciding preservation policy.
 * @param requirement - Frozen custody and setup recipe.
 * @param binding - Validated local paths.
 * @returns Explicit lifecycle handle.
 */
function createHandle(
  requirement: WorkspaceRequirement,
  binding: ExecutionAttemptWorkspaceBinding,
): LocalWorkspaceHandle {
  const workspaceRoot = binding.workspaceRoot;
  const custody = requirement.custody;
  let setupActive = false;
  let safeToRelease = true;
  let released: Promise<void> | undefined;
  return {
    binding,
    async runSetup(options = {}) {
      if (released !== undefined || setupActive || !safeToRelease) throw new Error('Workspace setup is unavailable');
      if (options.signal?.aborted) return { status: 'cancelled', exitCode: null };
      setupActive = true;
      try {
        for (const [commandIndex, recipe] of requirement.setup.entries()) {
          const result = await runSetupCommand({ ...options, recipe, workspaceRoot });
          safeToRelease = result.status !== 'stop-failed';
          if (result.status !== 'completed') return { ...result, commandIndex };
        }
        return { status: 'completed', exitCode: 0 };
      } finally {
        setupActive = false;
      }
    },
    release() {
      if (setupActive || !safeToRelease) return Promise.reject(new Error('Workspace commands have not stopped'));
      released ??= custody === 'external' ? Promise.resolve() : fs.rm(workspaceRoot, { recursive: true, force: true });
      return released;
    },
  };
}
