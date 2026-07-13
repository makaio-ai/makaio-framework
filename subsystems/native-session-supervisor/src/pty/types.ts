/**
 * PTY Backend Abstractions
 *
 * Defines the seam between the PTY runtime and concrete PTY implementations.
 * Swapping backends (e.g. node-pty → a Bun-compatible implementation) only
 * requires a new class that satisfies {@link IPtyBackend} — the runtime is
 * unaware of the underlying technology.
 * @packageDocumentation
 */

import type { IPtyProcess } from '@makaio/contracts/native-session-supervisor';

export type { IPtyProcess } from '@makaio/contracts/native-session-supervisor';

/**
 * Options forwarded to the backend when spawning a new PTY process.
 */
export interface IPtySpawnOptions {
  /** Value to set for the `$TERM` environment variable. */
  name?: string;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Environment variables for the spawned process. */
  env?: Record<string, string>;
  /** Initial column width. */
  cols?: number;
  /** Initial row height. */
  rows?: number;
}

/**
 * Abstraction over a PTY runtime backend.
 *
 * Implement this interface to provide an alternative PTY backend
 * (e.g. a Bun-native implementation) without touching the PTY runtime.
 */
export interface IPtyBackend {
  /**
   * Spawn a new pseudoterminal process.
   * @param file - Path (or name) of the executable to launch.
   * @param args - Argument list passed to the executable.
   * @param options - Spawn options such as cwd, env, and terminal dimensions.
   * @returns A promise that resolves with the running PTY process handle once
   *   the OS process is confirmed to be running and its `pid` is known.
   */
  spawn(file: string, args: string[], options: IPtySpawnOptions): Promise<IPtyProcess>;

  /**
   * Optional teardown hook called when the owning runtime is destroyed.
   * Implementations that hold global resources (thread pools, native handles)
   * should release them here.
   */
  dispose?(): Promise<void>;
}

/**
 * Exit event payload emitted when a PTY process terminates.
 */
export interface PtyExitEvent {
  /** The `supervisorSessionId` of the runtime that exited. */
  supervisorSessionId: string;
  /** OS exit code of the terminated process. */
  exitCode: number;
  /** OS signal number that caused the exit, if any. */
  signal?: number;
}

/**
 * Output event payload emitted when a PTY process produces output.
 */
export interface PtyOutputEvent {
  /** The `supervisorSessionId` of the runtime that produced the output. */
  supervisorSessionId: string;
  /** Monotonic sequence number for ordering output chunks. */
  seq: number;
  /** Raw output data string. */
  data: string;
}
