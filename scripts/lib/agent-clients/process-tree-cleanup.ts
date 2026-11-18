/** @packageDocumentation */
import {
  proveProcessGroupQuiescence,
  signalOwnedProcesses,
  terminateWindowsProcessTree,
  type GroupQuiescenceGap,
} from '@makaio/subprocess';

/** Upper bound for one `taskkill` run on Windows. */
const TASKKILL_TIMEOUT_MS = 5_000;
/** Upper bound for proving a process group quiescent. */
const QUIESCENCE_PROOF_TIMEOUT_MS = 2_000;

/**
 * What a run knows about the processes the provider started, once it returned.
 * `complete`: nothing is known to be left: the deadline's termination was
 * delivered, or the group was proven quiescent (also after an exit before the
 * deadline; on Windows, where no such proof exists, the run's own end). `incomplete`: processes of the provider may still run, and the
 * workspace the caller is about to remove may still be written to; `reason`
 * says why no proof was found: `pipes-held` (a descendant outside the
 * provider's group still held a pipe when the settle time ran out), a
 * quiescence gap of the process group (`poll-timeout`, `ps-unavailable`,
 * `signal-error`), or `tree-not-addressable` (Windows addresses the tree by
 * PID, which is no longer terminated once the provider's exit was observed;
 * see {@link classifyCleanup}). The evidence covers the provider's process group only, never a descendant
 * that left it.
 */
export type RunCleanup =
  | { readonly kind: 'complete' }
  | { readonly kind: 'incomplete'; readonly reason: GroupQuiescenceGap | 'pipes-held' | 'tree-not-addressable' };

export const CLEANUP_COMPLETE: RunCleanup = { kind: 'complete' };

/**
 * How a probe run treats a {@link RunCleanup}.
 * `warning`: the run goes on and reports the finding.
 * `failure`: the scenario fails.
 */
export interface CleanupFinding {
  readonly severity: 'warning' | 'failure';
  readonly message: string;
}

/**
 * Decide, in one place, what an incomplete cleanup means for a probe scenario.
 * Every incomplete cleanup fails the scenario, except `tree-not-addressable`:
 * only Windows reports it, because there an exited provider's tree can no longer
 * be reached and nothing could prove it empty, so failing would make the tool
 * unusable on Windows. It is reported as a warning instead.
 * TODO(FACT-463): Windows Job Objects would make the tree provable and retire the exception.
 * @param cleanup - What the run knows about the provider's processes.
 * @returns The finding, or `undefined` for a complete cleanup.
 */
export function classifyCleanup(cleanup: RunCleanup): CleanupFinding | undefined {
  if (cleanup.kind === 'complete') return undefined;
  return {
    severity: cleanup.reason === 'tree-not-addressable' ? 'warning' : 'failure',
    message: `provider processes may still run (${cleanup.reason})`,
  };
}

/**
 * Terminates the provider process and what it started, or reports why that is
 * not possible: its process group on POSIX, its process tree on Windows.
 *
 * Both are addressed through a number the host may reuse once the provider's
 * exit was observed (its PID on Windows, its group ID on POSIX once the group
 * has no member). Neither is therefore signalled after that observation: this
 * is the shared signalling rule of `process-tree.ts` in `@makaio/subprocess`.
 * A POSIX group is then only observed, with the bounded quiescence proof, and
 * members that outlive the provider are reported as `incomplete`, not killed.
 * The Windows contract is unchanged: the tree is terminated through `taskkill`
 * while the provider's exit is unobserved; after that nothing is done, which is
 * reported as `incomplete`.
 * @param pid - PID of the spawned provider process.
 * @param exitObserved - Whether the provider's own exit was already observed.
 * @param platform - Platform whose termination rules apply. Default: the host's.
 *   A seam for tests that simulate Windows on a POSIX host.
 * @returns What is known about the provider's processes once the termination finished.
 * @throws {Error} When a kill failed, or was denied and the group is not proven quiescent.
 */
export async function killProcessTree(
  pid: number,
  exitObserved: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<RunCleanup> {
  if (platform === 'win32') {
    if (exitObserved) return { kind: 'incomplete', reason: 'tree-not-addressable' };
    await terminateWindowsProcessTree(pid, { timeoutMs: TASKKILL_TIMEOUT_MS });
    return CLEANUP_COMPLETE;
  }
  if (exitObserved) {
    const proof = await proveProcessGroupQuiescence(pid, { timeoutMs: QUIESCENCE_PROOF_TIMEOUT_MS });
    return proof.kind === 'quiescent' ? CLEANUP_COMPLETE : { kind: 'incomplete', reason: proof.reason };
  }
  if (signalOwnedProcesses('process-group', pid, 'SIGKILL') !== 'denied') return CLEANUP_COMPLETE;
  // Darwin denies signals to a group whose members are all zombies, so a denial
  // alone proves nothing; only a quiescence proof makes it safe to go on waiting.
  const proof = await proveProcessGroupQuiescence(pid, { timeoutMs: QUIESCENCE_PROOF_TIMEOUT_MS });
  if (proof.kind === 'unproven') {
    throw new Error(`Could not kill the process group of provider process ${pid} (denied, ${proof.reason})`);
  }
  return CLEANUP_COMPLETE;
}

/**
 * Terminates, or observes, what a child started, through the given termination;
 * a child that never spawned (no PID) has nothing to terminate.
 * @param pid - PID of the child, or `undefined` when it never spawned.
 * @param exitObserved - Whether the child's own exit was already observed.
 * @param terminateTree - The termination to run, e.g. {@link killProcessTree}.
 * @returns What is known about the child's processes once the termination finished.
 */
export function terminateSpawned(
  pid: number | undefined,
  exitObserved: boolean,
  terminateTree: (pid: number, exitObserved: boolean) => Promise<RunCleanup>,
): Promise<RunCleanup> {
  return pid === undefined ? Promise.resolve(CLEANUP_COMPLETE) : terminateTree(pid, exitObserved);
}
