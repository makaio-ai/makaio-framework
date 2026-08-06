import type { ChildProcess } from 'node:child_process';

/** Bounds and cancellation for {@link waitForSpawn}. */
export interface WaitForSpawnOptions {
  /**
   * Milliseconds to wait for the `spawn` event before rejecting.
   *
   * A child that neither spawns nor errors emits nothing at all, so without a
   * bound this wait has no end — and every caller queued behind it inherits
   * that. The budget belongs to the caller, which is the layer that knows how
   * long starting this particular agent is allowed to take.
   */
  readonly timeoutMs: number;

  /**
   * Signal that abandons the wait before its budget expires.
   *
   * Abandoning the wait does not stop the child; a caller that aborts owns the
   * process it spawned and is responsible for killing it.
   */
  readonly signal?: AbortSignal;
}

/**
 * Waits until a child process either spawns successfully or fails to spawn.
 *
 * Resolution, failure, budget expiry and abort are mutually exclusive, and all
 * four detach every listener and timer this function installed — so a settled
 * wait never keeps the event loop alive and never fires twice.
 * @param proc - Child process being started
 * @param options - Bound and optional cancellation for the wait
 * @returns Promise that resolves after the `spawn` event fires
 * @throws The child's spawn error, or an `Error` when the budget expires or the wait is aborted
 */
export function waitForSpawn(proc: ChildProcess, options: WaitForSpawnOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const detach = (): void => {
      proc.off('spawn', onSpawn);
      proc.off('error', onError);
      options.signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onSpawn = (): void => {
      detach();
      resolve();
    };
    const onError = (error: Error): void => {
      detach();
      reject(error);
    };
    const onAbort = (): void => {
      detach();
      reject(new Error('Spawn wait was aborted before the process started.'));
    };

    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }

    proc.once('spawn', onSpawn);
    proc.once('error', onError);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      detach();
      reject(new Error(`Process did not start within ${options.timeoutMs}ms.`));
    }, options.timeoutMs);
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
