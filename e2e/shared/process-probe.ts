/**
 * Process probes shared by E2E harnesses: whether a PID is alive, a quiet
 * SIGKILL for cleanup, and a polling wait for a condition.
 */
import { setTimeout as delay } from 'node:timers/promises';

/** Interval at which {@link waitUntil} re-checks its condition. */
const POLL_INTERVAL_MS = 25;

/**
 * Whether a process exists.
 * @param pid - Process ID.
 * @returns `true` when signal 0 can be delivered (a process owned by someone else counts).
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * SIGKILL a process, ignoring that it may already be gone.
 * @param pid - Process ID.
 */
export function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone, which is the state the caller wants.
  }
}

/**
 * Poll until a condition holds.
 * @param condition - Condition to check.
 * @param timeoutMs - How long to wait.
 * @param what - Description for the timeout error.
 * @returns Resolves once the condition holds; rejects when the time is up.
 */
export async function waitUntil(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(POLL_INTERVAL_MS);
  }
}
