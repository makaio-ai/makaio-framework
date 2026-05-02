import type { ChildProcess } from 'node:child_process';

/**
 * Waits until a child process either spawns successfully or fails to spawn.
 * @param proc - Child process being started
 * @returns Promise that resolves after the `spawn` event fires, or rejects on `error`
 */
export function waitForSpawn(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      proc.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      proc.off('spawn', onSpawn);
      reject(error);
    };
    proc.once('spawn', onSpawn);
    proc.once('error', onError);
  });
}

/**
 * Best-effort teardown for a subprocess that failed after spawning but before
 * its parent connection or terminal construction completed.
 *
 * Destroys all stdio streams, sends SIGTERM, and waits for the process to exit
 * (with a 100 ms safety timeout so callers are never blocked indefinitely).
 * @param proc - Child process to clean up
 */
export async function cleanupFailedProcess(proc: ChildProcess): Promise<void> {
  proc.stdin?.destroy();
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  proc.kill('SIGTERM');
  // Race exit/close against a 100ms hard cap. The stale timer is harmless —
  // non-repeating timers are GC'd after firing and do not block process exit.
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.once('close', () => resolve());
    setTimeout(resolve, 100);
  });
}
