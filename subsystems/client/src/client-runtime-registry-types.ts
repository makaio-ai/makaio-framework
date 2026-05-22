/**
 * Shared types for the client runtime registry.
 *
 * Defines the in-memory record shape and upsert result
 * consumed by {@link ClientRuntimeRegistry} and its storage layer.
 * @packageDocumentation
 */

/**
 * All valid lifecycle status values for a client runtime record.
 *
 * - `'observed'` — weaker evidence only (pid without supervisorSessionId); the
 *   runtime has been detected but not yet confirmed as fully started.
 * - `'started'` — strong evidence present (supervisorSessionId, or an adapter
 *   confirmed the process); the runtime is confirmed started.
 */
export const CLIENT_RUNTIME_STATUSES = ['observed', 'started'] as const;

/** Lifecycle status of a client runtime record. */
export type ClientRuntimeStatus = (typeof CLIENT_RUNTIME_STATUSES)[number];

/**
 * In-memory record for a single client runtime instance.
 *
 * All fields except `clientRuntimeId`, `clientId`, `status`, `observedAt`,
 * `createdAt`, and `updatedAt` are optional because evidence accumulates
 * incrementally across multiple observations.
 */
export interface ClientRuntimeRecord {
  /** Stable runtime identifier assigned by the registry (UUID v4). */
  readonly clientRuntimeId: string;
  /** Stable client identifier (e.g. `'claude-code'`). */
  readonly clientId: string;
  /** Current lifecycle status of the runtime. */
  status: ClientRuntimeStatus;
  /** Supervisor-assigned session ID, if observed. */
  supervisorSessionId?: string;
  /** OS process ID of the client binary, if observed. */
  pid?: number;
  /** OS process ID of the parent process, if observed. */
  parentPid?: number;
  /** Raw session identifier from the client runtime, if observed. */
  adapterSessionId?: string;
  /** Framework session ID, if already resolved. */
  sessionId?: string;
  /** Working directory of the client process, if observed. */
  cwd?: string;
  /** Full argv of the client process, if observed. */
  argv?: string[];
  /** Arbitrary pass-through metadata from the most recent observation. */
  metadata?: Record<string, unknown>;
  /** Unix epoch timestamp in milliseconds of the latest captured observation while the record was observed. */
  observedAt: number;
  /** Unix epoch timestamp in milliseconds when this record was created. */
  readonly createdAt: number;
  /** Unix epoch timestamp in milliseconds of the last mutation. */
  updatedAt: number;
}

/**
 * Result returned by {@link ClientRuntimeRegistry.upsertRuntime}.
 */
export interface RuntimeUpsertResult {
  /** Stable runtime record ID assigned or retrieved by the registry. */
  readonly clientRuntimeId: string;
  /** `true` when this observation created a new runtime record. */
  readonly created: boolean;
  /**
   * `true` when this observation promoted an existing record from `'observed'`
   * to `'started'` status.
   */
  readonly promoted: boolean;
  /** The upserted runtime record (post-enrichment). */
  readonly record: ClientRuntimeRecord;
}
