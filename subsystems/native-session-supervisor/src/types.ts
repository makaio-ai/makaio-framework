/**
 * Core domain types for the native session supervisor package.
 *
 * These types define the in-memory representation of a supervised runtime
 * entry. The persistent row shape lives in `storage/schema.ts` and the
 * mapping between the two lives in `storage/map-runtime.ts`.
 * @packageDocumentation
 */

import type { SupervisorSessionStatus } from '@makaio/contracts/native-session-supervisor';

/**
 * Full in-memory representation of a supervised native process runtime.
 *
 * `supervisorSessionId` is the canonical primary key. All registry lookups
 * start here; `sessionId` and `adapterSessionId` are secondary correlation
 * fields only.
 */
export interface SupervisorRuntime {
  /**
   * Stable supervisor-assigned session ID.
   * Primary key — never changes after creation.
   */
  supervisorSessionId: string;

  /**
   * Stable client package identifier (e.g. `'claude-code'`).
   */
  clientId: string;

  /**
   * OS process ID of the spawned process, or `null` when the process has exited.
   */
  pid: number | null;

  /**
   * Current lifecycle status of the supervised runtime.
   */
  status: SupervisorSessionStatus;

  /**
   * Working directory the process was launched with.
   */
  cwd: string;

  /**
   * Executable command that was run.
   */
  command: string;

  /**
   * Argument list passed to the command.
   */
  args: string[];

  /**
   * Additional environment variables merged into the spawned process environment.
   * Absent when no extra env was provided at launch.
   */
  env?: Record<string, string>;

  /**
   * Makaio framework session ID, if the runtime was linked to a session.
   */
  sessionId?: string;

  /**
   * Adapter-assigned session ID, if the runtime was correlated with an adapter session.
   */
  adapterSessionId?: string;

  /**
   * Unix epoch timestamp (milliseconds) when the process was started.
   */
  startedAt: number;

  /**
   * Unix epoch timestamp (milliseconds) when the process stopped, if applicable.
   */
  stoppedAt?: number;

  /**
   * Arbitrary pass-through metadata for consumers of supervisor events.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Fields required to create a new {@link SupervisorRuntime} entry.
 *
 * The caller must supply `supervisorSessionId` — the supervisor is launched
 * with a pre-generated ID, so the registry never auto-assigns one. Only
 * `status` is omitted because the registry always initialises it to
 * `'running'`, and `startedAt` is made explicitly required here so callers
 * record the precise launch timestamp.
 */
export type SupervisorRuntimeInit = Omit<SupervisorRuntime, 'status' | 'startedAt'> & {
  /**
   * Unix epoch timestamp (milliseconds) when the process was started.
   * Must be provided on creation.
   */
  startedAt: number;
};

/**
 * Partial update payload for an existing {@link SupervisorRuntime}.
 *
 * Only mutable fields can be updated; `supervisorSessionId`, `clientId`,
 * `command`, `args`, and `startedAt` are immutable after creation.
 */
export type SupervisorRuntimeUpdate = {
  readonly supervisorSessionId: string;
} & Partial<Pick<SupervisorRuntime, 'pid' | 'status' | 'sessionId' | 'adapterSessionId' | 'stoppedAt' | 'metadata'>>;
