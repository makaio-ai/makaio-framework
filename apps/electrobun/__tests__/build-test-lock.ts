import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const LOCK_DIR = path.join(tmpdir(), 'framework-electrobun-build-test.lock');
const OWNER_FILE = path.join(LOCK_DIR, 'owner.json');
const WAIT_INTERVAL_MS = 100;

interface BuildLockOwner {
  readonly pid: number;
  readonly token: string;
}

/**
 * Acquire the shared Electrobun build-test lock.
 * @param timeoutMs - Maximum time to wait before failing the test.
 * @returns Cleanup function that releases the lock.
 */
export function acquireElectrobunBuildLock(timeoutMs = 180_000): () => void {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const owner = { pid: process.pid, token: randomUUID() } satisfies BuildLockOwner;
      mkdirSync(LOCK_DIR);
      writeFileSync(OWNER_FILE, JSON.stringify(owner));
      return () => removeLockIfOwned(owner);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      removeOrphanedLock();
      sleep(WAIT_INTERVAL_MS);
    }
  }

  throw new Error(`Timed out waiting for Electrobun build test lock at ${LOCK_DIR}`);
}

/**
 * Remove a lock left behind by a terminated owner process.
 */
function removeOrphanedLock(): void {
  try {
    const owner = JSON.parse(readFileSync(OWNER_FILE, 'utf-8')) as BuildLockOwner;
    if (!isProcessAlive(owner.pid)) {
      removeLockIfOwned(owner);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

/**
 * Remove the lock only when the owner file still belongs to the expected owner.
 * @param expectedOwner - Owner metadata captured before attempting removal.
 */
function removeLockIfOwned(expectedOwner: BuildLockOwner): void {
  try {
    const currentOwner = JSON.parse(readFileSync(OWNER_FILE, 'utf-8')) as BuildLockOwner;
    if (currentOwner.pid === expectedOwner.pid && currentOwner.token === expectedOwner.token) {
      rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

/**
 * Check whether a process is still alive.
 * @param pid - Process id recorded by the lock owner.
 * @returns Whether the process exists.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

/**
 * Block the current worker briefly while another worker owns the build output.
 * @param ms - Sleep duration.
 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
