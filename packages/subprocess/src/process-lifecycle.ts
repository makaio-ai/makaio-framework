/**
 * Process lifecycle manager for supervised subprocess instances.
 *
 * Wraps subprocess spawn, health monitoring, graceful shutdown, and
 * optional restart policy into a single stateful handle.
 * @packageDocumentation
 */

import type { ChildProcess } from 'node:child_process';
import type { IJsonlTransport, SubprocessSpawnOptions } from './types.js';
import { createJsonlTransport } from './jsonl-transport.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Valid states for the process lifecycle state machine. */
export type ProcessState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';

/**
 * Configuration for process lifecycle management.
 * @param spawn - Subprocess spawn options.
 * @param healthTimeoutMs - Time to wait for ready signal before marking as failed. Default: 30000.
 * @param shutdownTimeoutMs - Graceful shutdown window before SIGKILL. Default: 5000.
 * @param restartPolicy - When to restart. Default: 'none'.
 * @param onReady - Called when process signals readiness (first message received).
 * @param onExit - Called when process exits.
 * @param onStateChange - Called on every state transition.
 */
export interface ProcessLifecycleOptions {
  readonly spawn: SubprocessSpawnOptions;
  readonly healthTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly restartPolicy?: 'none' | 'on-crash' | 'always';
  readonly onReady?: () => void;
  readonly onExit?: (code: number | null) => void;
  readonly onStateChange?: (state: ProcessState) => void;
}

/**
 * Handle for a managed subprocess lifecycle.
 */
export interface ProcessLifecycleHandle {
  /** The underlying JSONL transport (available after start()). */
  readonly transport: IJsonlTransport | undefined;
  /**
   * Start the subprocess and wait for readiness.
   * Resolves when the first message is received from stdout.
   * Rejects if healthTimeoutMs elapses before any message is received.
   */
  start(): Promise<void>;
  /**
   * Gracefully stop the subprocess.
   * Sends SIGTERM, waits shutdownTimeoutMs, then sends SIGKILL if still running.
   */
  stop(): Promise<void>;
  /** Current lifecycle state. */
  readonly state: ProcessState;
}

// ---------------------------------------------------------------------------
// Valid state transitions
// ---------------------------------------------------------------------------

/** Allowed state transitions keyed by current state. */
const VALID_TRANSITIONS: Readonly<Record<ProcessState, readonly ProcessState[]>> = {
  idle: ['starting'],
  starting: ['running', 'crashed', 'stopping'],
  running: ['stopping', 'crashed'],
  stopping: ['stopped'],
  stopped: ['starting'],
  crashed: ['starting', 'stopped'],
};

/**
 * Guard that throws if the requested transition is not allowed.
 * @param from - Current state.
 * @param to - Desired next state.
 */
function assertTransition(from: ProcessState, to: ProcessState): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
}

/**
 * Return a promise that resolves to `true` when the process emits 'exit'.
 * If the process has already exited, resolves immediately.
 * @param proc - The child process to wait on.
 * @returns Promise that resolves to `true` when the process exits.
 */
function waitForProcessExit(proc: ChildProcess): Promise<true> {
  return new Promise<true>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(true);
      return;
    }
    proc.once('exit', () => resolve(true));
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a managed process lifecycle handle.
 *
 * The handle begins in the `idle` state. Call {@link ProcessLifecycleHandle.start}
 * to spawn the subprocess.
 * @param options - Lifecycle configuration.
 * @returns Handle for controlling the subprocess lifecycle.
 */
// eslint-disable-next-line max-lines-per-function
export function createProcessLifecycle(options: ProcessLifecycleOptions): ProcessLifecycleHandle {
  const {
    spawn,
    healthTimeoutMs = 30_000,
    shutdownTimeoutMs = 5_000,
    restartPolicy = 'none',
    onReady,
    onExit,
    onStateChange,
  } = options;

  let state: ProcessState = 'idle';
  let transport: IJsonlTransport | undefined;

  /**
   * Transition to a new state and fire the onStateChange callback.
   * @param next - The state to transition into.
   */
  function transition(next: ProcessState): void {
    assertTransition(state, next);
    state = next;
    onStateChange?.(state);
  }

  /**
   * Handle subprocess exit after the process has reached the 'running' state.
   * Manages crash detection and restart policy.
   * @param code - The process exit code, or null if killed by a signal.
   */
  function handleRunningExit(code: number | null): void {
    const exitedTransport = transport;
    transport = undefined;
    exitedTransport?.close();

    if (state === 'stopping') {
      // Expected exit during graceful shutdown — transition to stopped.
      transition('stopped');
      onExit?.(code);
      return;
    }

    if (state === 'running') {
      if (code !== 0) {
        // Non-zero exit while running is a crash.
        transition('crashed');
        onExit?.(code);

        if (restartPolicy === 'on-crash' || restartPolicy === 'always') {
          void start().catch((err) => {
            console.error(
              `[ProcessLifecycle:${spawn.processName ?? spawn.command}] Restart failed:`,
              err instanceof Error ? err.message : err,
            );
          });
        }
        return;
      }

      // Clean exit (code === 0) — drive through stopping → stopped.
      transition('stopping');
      transition('stopped');
      onExit?.(code);

      if (restartPolicy === 'always') {
        void start().catch((err) => {
          console.error(
            `[ProcessLifecycle:${spawn.processName ?? spawn.command}] Restart failed:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    }
  }

  /**
   * Spawn the subprocess and wait for the first JSONL message or health timeout.
   */
  async function start(): Promise<void> {
    transition('starting');

    const currentTransport = createJsonlTransport(spawn);
    transport = currentTransport;
    const proc = currentTransport.process;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      /**
       * Settle the start promise exactly once, clearing timers and subscriptions.
       * @param action - Callback to invoke after cleanup (resolve or reject the outer promise).
       */
      function settle(action: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubMessage();
        proc.off('exit', handleEarlyExit);
        action();
      }

      const timer = setTimeout(() => {
        settle(() => {
          currentTransport.close();
          transport = undefined;
          try {
            transition('crashed');
          } catch {
            // Already crashed (e.g. exit event arrived first).
          }
          reject(new Error(`Process health timeout after ${healthTimeoutMs}ms: ${spawn.processName ?? spawn.command}`));
        });
      }, healthTimeoutMs);

      const unsubMessage = currentTransport.onMessage(() => {
        settle(() => {
          try {
            transition('running');
          } catch (err) {
            reject(err);
            return;
          }
          onReady?.();

          // Wire the ongoing exit handler now that readiness is confirmed.
          proc.once('exit', handleRunningExit);
          resolve();
        });
      });

      /**
       * Handle process exit before the ready message is received.
       * @param code - Process exit code, or null when terminated by signal.
       */
      function handleEarlyExit(code: number | null): void {
        settle(() => {
          transport = undefined;
          try {
            transition('crashed');
          } catch {
            // Already transitioned (timer won the race).
          }
          onExit?.(code);
          reject(new Error(`Process exited with code ${String(code)} before signaling readiness`));
        });
      }
      proc.once('exit', handleEarlyExit);
    });
  }

  /**
   * Gracefully stop the subprocess.
   * Sends SIGTERM first, waits shutdownTimeoutMs, then SIGKILL.
   */
  async function stop(): Promise<void> {
    if (state === 'stopped' || state === 'idle') return;

    if (state === 'crashed') {
      transport?.close();
      transport = undefined;
      transition('stopped');
      return;
    }

    if (state !== 'stopping') {
      transition('stopping');
    }

    if (!transport) {
      // Transport was cleaned up (e.g. crashed during start) — finish the transition.
      if (state === 'stopping') {
        transition('stopped');
      }
      return;
    }

    const currentTransport = transport;
    const proc = currentTransport.process;

    if (proc.exitCode !== null) {
      currentTransport.close();
      if (transport === currentTransport) {
        transport = undefined;
      }
      if (state === 'stopping') {
        transition('stopped');
      }
      return;
    }

    proc.kill('SIGTERM');

    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      waitForProcessExit(proc).then(() => {
        clearTimeout(shutdownTimer);
        return true as const;
      }),
      new Promise<false>((resolve) => {
        shutdownTimer = setTimeout(() => resolve(false), shutdownTimeoutMs);
      }),
    ]);

    if (!exited) {
      proc.kill('SIGKILL');
      await waitForProcessExit(proc);
    }

    // handleRunningExit fires on the process 'exit' event and transitions to
    // 'stopped'. If it hasn't fired yet (race condition), we force the transition.
    if (state === 'stopping') {
      transition('stopped');
    }
    currentTransport.close();
    if (transport === currentTransport) {
      transport = undefined;
    }
  }

  return {
    get transport() {
      return transport;
    },
    get state() {
      return state;
    },
    start,
    stop,
  };
}
