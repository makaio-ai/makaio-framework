/**
 * Machine-wide test execution lock.
 *
 * Full test runs from multiple checkouts (for example parallel agent sessions
 * in separate worktrees) oversubscribe a single machine and destabilize
 * subprocess- and timing-sensitive tests. This lock serializes heavyweight
 * test batches machine-wide while letting concurrent runs interleave between
 * batches: each run holds the lock only for one batch at a time.
 *
 * The lock is a directory created atomically in the OS temp directory. The
 * holder records its pid; waiters poll, and steal the lock when the holder
 * process is gone or the lock exceeds its maximum age.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Metadata recorded by the current lock holder. */
interface LockOwner {
  /** Process id of the holder. */
  pid: number;
  /** Epoch milliseconds when the lock was acquired. */
  acquiredAt: number;
  /** Human-readable description of the work holding the lock. */
  label: string;
}

/** Injectable boundaries and tuning knobs for {@link withMachineTestLock}. */
export interface MachineTestLockOptions {
  /** Lock directory path (default: `<os tmpdir>/makaio-machine-test-lock`). */
  lockDir?: string;
  /** Poll interval while waiting for the lock, in milliseconds. */
  pollIntervalMs?: number;
  /**
   * Age after which a lock is considered abandoned even if the owner pid is
   * unknown, in milliseconds.
   */
  staleAfterMs?: number;
  /** Probe whether a pid refers to a live process. */
  isPidAlive?: (pid: number) => boolean;
  /** Diagnostic sink for wait/steal messages. */
  log?: (message: string) => void;
}

const DEFAULT_LOCK_DIR = join(tmpdir(), 'makaio-machine-test-lock');
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_STALE_AFTER_MS = 45 * 60 * 1_000;

/**
 * Determine whether the machine-wide test lock should be used.
 *
 * CI runners execute one run per machine, and callers can opt out explicitly
 * with `MAKAIO_TEST_NO_MACHINE_LOCK`.
 * @param env - Process environment to inspect.
 * @returns True when lock coordination is meaningful for this run.
 */
export function isMachineTestLockEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.MAKAIO_TEST_NO_MACHINE_LOCK) return false;
  if (env.CI) return false;
  return true;
}

/**
 * Probe process liveness through `process.kill(pid, 0)`.
 * @param pid - Process id to probe.
 * @returns True when the process exists.
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the current lock owner metadata, if readable.
 * @param lockDir - Lock directory path.
 * @returns Owner metadata, or null when missing or malformed.
 */
async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const raw = await readFile(join(lockDir, 'owner.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const owner = parsed as Partial<LockOwner>;
    if (typeof owner.pid !== 'number' || typeof owner.acquiredAt !== 'number') return null;
    return { pid: owner.pid, acquiredAt: owner.acquiredAt, label: typeof owner.label === 'string' ? owner.label : '' };
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing lock may be stolen.
 * @param lockDir - Lock directory path.
 * @param staleAfterMs - Maximum tolerated lock age.
 * @param isPidAlive - Process liveness probe.
 * @returns True when the lock is abandoned.
 */
async function isLockStale(
  lockDir: string,
  staleAfterMs: number,
  isPidAlive: (pid: number) => boolean,
): Promise<boolean> {
  const owner = await readOwner(lockDir);
  if (owner) {
    if (!isPidAlive(owner.pid)) return true;
    return Date.now() - owner.acquiredAt > staleAfterMs;
  }
  // Unreadable owner metadata: only steal once the directory itself is old
  // enough that a crashed writer is the only plausible explanation.
  try {
    const stats = await stat(lockDir);
    return Date.now() - stats.mtimeMs > staleAfterMs;
  } catch {
    // Directory vanished between the failed acquire and this check.
    return false;
  }
}

/**
 * Run a unit of work while holding the machine-wide test lock.
 *
 * Waits until the lock is free (or abandoned), runs the work, and always
 * releases the lock afterwards. Concurrent runs on the same machine therefore
 * execute their batches interleaved instead of simultaneously.
 * @param label - Human-readable description recorded in the lock.
 * @param run - Work to execute while holding the lock.
 * @param options - Injectable boundaries and tuning knobs.
 * @returns The result of the work.
 */
export async function withMachineTestLock<T>(
  label: string,
  run: () => Promise<T>,
  options: MachineTestLockOptions = {},
): Promise<T> {
  const lockDir = options.lockDir ?? DEFAULT_LOCK_DIR;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const log = options.log ?? ((message: string) => console.info(message));

  let announcedWait = false;
  for (;;) {
    try {
      await mkdir(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await isLockStale(lockDir, staleAfterMs, isPidAlive)) {
        // Two waiters can both judge the same lock stale, and the slower one
        // may remove a lock the faster one just re-acquired. That window only
        // opens after a holder crashed, and its worst case is one overlapping
        // batch — accepted in exchange for keeping acquisition lock-file-only.
        log(`Machine test lock looks abandoned; stealing it for: ${label}`);
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (!announcedWait) {
        const owner = await readOwner(lockDir);
        const holder = owner ? `pid ${owner.pid}${owner.label ? ` (${owner.label})` : ''}` : 'another test run';
        log(`Waiting for machine test lock held by ${holder} before: ${label}`);
        announcedWait = true;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, pollIntervalMs));
      continue;
    }

    // A successful mkdir makes this process the sole owner of the directory, so
    // every path after it — including the owner-metadata write — must release
    // it. Releasing only around `run` would leak a lock directory without
    // readable owner metadata when the write fails (full disk, read-only tmp),
    // and waiters would then be stuck behind the mtime fallback for the full
    // stale age.
    try {
      const owner: LockOwner = { pid: process.pid, acquiredAt: Date.now(), label };
      await writeFile(join(lockDir, 'owner.json'), JSON.stringify(owner));
      if (announcedWait) log(`Acquired machine test lock for: ${label}`);
      return await run();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}
