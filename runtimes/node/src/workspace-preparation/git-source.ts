import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { devNull } from 'node:os';
import { INVALID_LAUNCH_TIMEOUT_MESSAGE, isValidLaunchTimeoutMs, launch, launchForOutput } from '@makaio/subprocess';
import { z } from 'zod';
import { isCooperativeCancellation } from '../cooperative-cancellation.js';
import type { LocalWorkspaceSourceRealizer } from './workspace-preparation.js';

const gitConfiguration = ['-c', `core.attributesFile=${devNull}`];

const gitInput = z
  .object({
    repositoryId: z.string().min(1),
    revision: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, 'Git source revision must be a full commit object ID'),
  })
  .strict();

/** Host-local access and execution budget, never part of the portable source instruction. */
export interface LocalGitSourceOptions {
  /** Resolve the logical repository identifier to an existing local repository. */
  readonly resolveRepository: (repositoryId: string, signal?: AbortSignal) => Promise<string>;
  /** Per-command budget for bounded local source acquisition. */
  readonly timeoutMs: number;
}

/**
 * Keep host access failures value-free before they reach durable preparation outcomes.
 * @param options - Host-local repository access.
 * @param repositoryId - Portable repository identity, not a filesystem locator.
 * @param signal - Current preparation cancellation.
 * @returns Canonical local repository path.
 */
async function resolveGitRepository(
  options: LocalGitSourceOptions,
  repositoryId: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const repository = await options.resolveRepository(repositoryId, signal);
    if (!path.isAbsolute(repository)) throw new Error('Repository access did not return an absolute path');
    return await fs.realpath(repository);
  } catch (error) {
    if (isCooperativeCancellation(error, signal)) throw error;
    throw new Error('Git source access failed');
  }
}

/**
 * Check the fetched object itself, without peeling tags into different identities.
 * The fixed plumbing query runs as a bounded launch with a small capture limit.
 * @param destination - Acquired repository containing the selected object.
 * @param revision - Exact immutable object identifier.
 * @param env - Git environment overrides shared with acquisition commands.
 * @param timeoutMs - Validated per-command budget.
 * @param signal - Current preparation cancellation.
 */
async function requireCommitObject(
  destination: string,
  revision: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const inspected = await launchForOutput({
    command: 'git',
    args: [...gitConfiguration, 'cat-file', '-t', revision],
    cwd: destination,
    env,
    envMode: 'merge',
    timeoutMs,
    signal,
    outputLimitBytes: 1024,
  });
  if (!inspected.ok) throw new Error('Git source object inspection failed');
  const objectType = inspected.stdout.trim();
  if (objectType !== 'commit') throw new Error('Git source revision must identify a commit object');
}

/**
 * Install local Git acquisition without credential, provider or branch-publication policy.
 * Installation requires a POSIX host for the acquisition command runner.
 * The caller owns containment and custody of the empty destination directory.
 * @param options - Injected repository access and command budget.
 * @returns Source strategy consuming the existing kind/input instruction seam.
 */
export function createLocalGitSourceRealizer(options: LocalGitSourceOptions): LocalWorkspaceSourceRealizer {
  if (!isValidLaunchTimeoutMs(options.timeoutMs)) {
    throw new Error(INVALID_LAUNCH_TIMEOUT_MESSAGE);
  }
  if (process.platform === 'win32') throw new Error('Local Git source preparation requires a POSIX host');
  return async ({ source, destination, signal }) => {
    signal?.throwIfAborted();
    if (source.kind !== 'git') throw new Error('Unsupported local Git source kind');
    const input = gitInput.parse(source.input);
    const repositoryPath = await resolveGitRepository(options, input.repositoryId, signal);
    signal?.throwIfAborted();
    // Git variables inherited from a parent repository must not redirect writes
    // outside this source root. Undefined overrides survive the launcher's env merge.
    const env = {
      ...Object.fromEntries(
        Object.keys(process.env)
          .filter((key) => /^git_/i.test(key))
          .map((key) => [key, undefined]),
      ),
      // Workstation hooks and checkout transformations are not source preparation policy.
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
      GIT_ATTR_NOSYSTEM: '1',
    };
    // Preserve the selected history available from the supplied source, including
    // its shallow boundary, without further truncation or importing mutable refs.
    // No remote, FETCH_HEAD or locator-bearing clone reflog is created.
    const commands = [
      ['init', `--object-format=${input.revision.length === 64 ? 'sha256' : 'sha1'}`],
      ['fetch', '--no-tags', '--no-write-fetch-head', '--update-shallow', '--', repositoryPath, input.revision],
      ['checkout', '--detach', input.revision, '--'],
    ];
    for (const args of commands) {
      if (args[0] === 'checkout') {
        await requireCommitObject(destination, input.revision, env, options.timeoutMs, signal);
      }
      const result = await launch({
        command: 'git',
        args: [...gitConfiguration, ...args],
        cwd: destination,
        env,
        envMode: 'merge',
        timeoutMs: options.timeoutMs,
        signal,
        output: { kind: 'ignore' },
      }).result;
      if (result.status === 'cancelled') signal?.throwIfAborted();
      if (result.status !== 'completed') throw new Error(`Git source ${args[0]} ${result.status}`);
    }
  };
}
