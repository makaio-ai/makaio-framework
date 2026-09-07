import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkspaceSetupCommand } from '@makaio/contracts';

/** Result of one bounded setup command, after its owned process group has stopped. */
export interface SetupCommandResult {
  readonly status: 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'spawn-failed' | 'stop-failed';
  readonly exitCode: number | null;
  /** Generic diagnostics deliberately exclude command arguments and environment values. */
  readonly message?: string;
}

/** Local inputs to an already-authorized command; this helper grants no permissions. */
export interface SetupCommandOptions {
  readonly recipe: WorkspaceSetupCommand;
  readonly workspaceRoot: string;
  readonly signal?: AbortSignal;
  /** Host-injected environment, including credentials when needed. Never persisted. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Signal the ordinary owned process group, tolerating an already-exited group.
 * @param pid - Leader of the setup process group.
 * @param signal - Signal delivered to the whole group.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * Check liveness separately from PID existence: unreaped zombies cannot execute
 * or write files, but still make kill(group, 0) succeed until their parent reaps them.
 * @param pid - Owned process group leader.
 * @param psTimeoutMs - Remaining bounded time available for the ps query.
 * @returns Whether the group contains any process that has not exited.
 */
async function groupHasLiveProcesses(pid: number, psTimeoutMs: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  let stdout: string;
  try {
    stdout = await readProcessGroups(psTimeoutMs);
  } catch {
    // Unlike a naive kill-only check, a successful group probe does not prove
    // quiescence: it may name a live descendant or an unreaped zombie. If ps
    // is unavailable or unparseable, wait conservatively for ESRCH instead.
    return true;
  }
  let sawGroup = false;
  for (const line of stdout.trim().split('\n')) {
    const [group, state, extra] = line.trim().split(/\s+/);
    if (group === '' || state === undefined || extra !== undefined || !/^\d+$/.test(group) || state === '') return true;
    if (Number(group) !== pid) continue;
    sawGroup = true;
    if (!state.startsWith('Z')) return true;
  }
  return !sawGroup;
}

/**
 * Read process-group and state rows using the host's ps implementation.
 * @param timeoutMs - Remaining bounded time for the host query.
 * @returns Plain ps output for conservative process-state parsing.
 */
function readProcessGroups(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-A', '-o', 'pgid=,stat='], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Stop remaining descendants and confirm no live process remains in the owned group.
 * @param pid - Spawned group leader, absent when process creation failed.
 * @returns Whether release is safe with respect to this command's process tree.
 */
async function stopRemainingGroup(pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return true;
  try {
    signalGroup(pid, 'SIGKILL');
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      if (!(await groupHasLiveProcesses(pid, Math.min(1_000, remaining)))) return true;
      await delay(20);
    }
  } catch {
    // Do not claim safe release when the host cannot stop the process group.
  }
  return false;
}

/**
 * Execute a bounded command directly, without shell parsing or a new command policy.
 * POSIX process groups own ordinary descendants; Windows is rejected before spawn
 * until an equivalent tree-lifecycle implementation is supplied.
 * @param options - Frozen recipe and local execution context.
 * @returns Classified exit result; `stop-failed` explicitly forbids safe release.
 */
export async function runSetupCommand(options: SetupCommandOptions): Promise<SetupCommandResult> {
  if (options.signal?.aborted) return { status: 'cancelled', exitCode: null };
  if (process.platform === 'win32') {
    return { status: 'spawn-failed', exitCode: null, message: 'Setup process groups require a POSIX host' };
  }
  try {
    return await executeSetupCommand(options);
  } catch {
    return { status: 'spawn-failed', exitCode: null, message: 'Could not start the setup command' };
  }
}

/**
 * Own timers, cancellation listeners and process completion for one invocation.
 * @param options - Command and runtime-local inputs.
 * @returns Result only after the process and remaining owned descendants stop.
 */
function executeSetupCommand(options: SetupCommandOptions): Promise<SetupCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(options.recipe.command, options.recipe.args, {
      cwd: options.workspaceRoot,
      env: { ...process.env, ...options.recipe.env, ...options.env },
      shell: false,
      detached: true,
      // Avoid retaining unbounded output or accidentally persisting credential-bearing logs.
      stdio: 'ignore',
    });
    let status: SetupCommandResult['status'] | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: 'cancelled' | 'timed-out'): void => {
      if (status !== undefined) return;
      status = reason;
      if (child.pid === undefined) return;
      try {
        signalGroup(child.pid, 'SIGTERM');
        escalation = setTimeout(() => {
          try {
            if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
          } catch {
            status = 'stop-failed';
          }
        }, 200);
      } catch {
        status = 'stop-failed';
      }
    };
    const abort = (): void => stop('cancelled');
    const timeout = setTimeout(() => stop('timed-out'), options.recipe.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('error', () => {
      status = 'spawn-failed';
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
      void stopRemainingGroup(child.pid).then((stopped) => {
        resolve({ status: stopped ? (status ?? (exitCode === 0 ? 'completed' : 'failed')) : 'stop-failed', exitCode });
      });
    });
  });
}
