/**
 * Assertions shared by the signal-handling E2E tests of the hosts.
 */
import { expect } from 'vitest';
import { isAlive, waitUntil } from '../../../../e2e/shared/process-probe.js';
import type { HostExit, SignalServeHost } from './signal-serve-process.js';

/** Time a host may take to boot. */
export const BOOT_TIMEOUT_MS = 45_000;
/** Time the slowed teardown of the child extension takes. */
export const SLOW_CLEANUP_MS = 3_000;
/** Pause that lets a second signal land while a slowed teardown is still running. */
export const SIGNAL_GAP_MS = 500;

/**
 * Assert the host ended the way expected and left no child behind.
 * @param host - Host under test.
 * @param childPid - PID of the child its fixture started.
 * @param expectedExit - How the host is expected to end; a clean exit by default.
 */
export async function expectEndWithoutChild(
  host: SignalServeHost,
  childPid: number,
  expectedExit: HostExit = { code: 0, signal: null },
): Promise<void> {
  await expect(host.exited).resolves.toEqual(expectedExit);
  await waitUntil(() => !isAlive(childPid), 2_000, `child ${childPid} to be gone`);
}
