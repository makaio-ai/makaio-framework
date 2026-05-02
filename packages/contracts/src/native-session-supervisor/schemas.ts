/**
 * Native Session Supervisor domain schemas.
 *
 * Defines the global `native-session-supervisor.*` contracts for launching,
 * attaching to, stopping, and querying the status of supervised native
 * process runtimes.
 *
 * This module owns no business logic — it only declares typed Zod schemas
 * and inferred TypeScript types for bus communication.
 * @packageDocumentation
 */

import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a supervised runtime process.
 *
 * - `'running'`  — the process is currently active.
 * - `'stopped'`  — the process was explicitly stopped via a `stop` request.
 * - `'exited'`   — the process exited on its own (zero or non-zero exit code).
 * - `'unknown'`  — the supervisor has no current status information.
 */
export const SupervisorSessionStatusSchema = z.enum(['running', 'stopped', 'exited', 'unknown']);

export type SupervisorSessionStatus = z.infer<typeof SupervisorSessionStatusSchema>;

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

/**
 * Request and response schemas for `native-session-supervisor.launch`.
 *
 * Launches a new supervised native process and returns a stable supervisor
 * session ID together with the OS process ID of the spawned process.
 *
 * Subject: `native-session-supervisor.launch`
 * Type: Request (RPC)
 */
export const NativeSupervisorLaunchSchema = {
  request: z.object({
    /** Stable client package identifier (e.g. `'claude-code'`). */
    clientId: z.string(),

    /** Working directory for the spawned process. */
    cwd: z.string(),

    /** Executable command to run. */
    command: z.string(),

    /** Argument list passed to the command. */
    args: z.array(z.string()),

    /**
     * Additional environment variables to merge into the spawned process
     * environment. Keys and values must be strings.
     */
    env: z.record(z.string(), z.string()).optional(),

    /**
     * Framework session ID to associate with this supervised runtime.
     * When provided, the supervisor links the runtime to an existing session.
     */
    sessionId: z.string().optional(),

    /**
     * Adapter-assigned session ID to correlate with this supervised runtime.
     * Allows the supervisor to resolve identity across the adapter boundary.
     */
    adapterSessionId: z.string().optional(),

    /** Arbitrary pass-through metadata for consumers of supervisor events. */
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  response: z.object({
    /**
     * Stable supervisor-assigned session ID for this runtime.
     * Used as the primary key for all subsequent supervisor operations.
     */
    supervisorSessionId: z.string(),

    /** OS process ID of the spawned process. */
    pid: z.number().int().positive(),
  }),
};

export type NativeSupervisorLaunchRequest = z.infer<typeof NativeSupervisorLaunchSchema.request>;
export type NativeSupervisorLaunchResponse = z.infer<typeof NativeSupervisorLaunchSchema.response>;

// ---------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------

/**
 * Request and response schemas for `native-session-supervisor.attach`.
 *
 * Requests attachment to an already-supervised runtime, identified by one of
 * the three available locators.
 *
 * Subject: `native-session-supervisor.attach`
 * Type: Request (RPC)
 */
export const NativeSupervisorAttachSchema = {
  request: z.union([
    z
      .object({
        /** Locate by supervisor-assigned session ID. */
        supervisorSessionId: z.string(),
      })
      .strict(),
    z
      .object({
        /** Locate by framework session ID. */
        sessionId: z.string(),
      })
      .strict(),
    z
      .object({
        /** Locate by adapter-assigned session ID. */
        adapterSessionId: z.string(),
      })
      .strict(),
  ]),
  response: z.object({
    /** Whether the attach operation succeeded. */
    success: z.boolean(),

    /** Supervisor session ID of the located runtime, if resolved. */
    supervisorSessionId: z.string().optional(),

    /** OS process ID of the located runtime, if available. */
    pid: z.number().int().positive().optional(),

    /**
     * Terminal attachment capabilities for the located runtime.
     * Present when the supervisor supports interactive terminal re-attachment.
     */
    terminalAttachment: z
      .object({
        /** Whether the runtime supports interactive terminal attachment. */
        canAttach: z.boolean(),
      })
      .optional(),
  }),
};

export type NativeSupervisorAttachRequest = z.infer<typeof NativeSupervisorAttachSchema.request>;
export type NativeSupervisorAttachResponse = z.infer<typeof NativeSupervisorAttachSchema.response>;

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

/**
 * Request and response schemas for `native-session-supervisor.stop`.
 *
 * Stops a supervised runtime process identified by its supervisor session ID.
 *
 * Subject: `native-session-supervisor.stop`
 * Type: Request (RPC)
 */
export const NativeSupervisorStopSchema = {
  request: z.object({
    /**
     * Supervisor session ID of the runtime to stop.
     * Must be a valid ID returned by a prior `launch` response.
     */
    supervisorSessionId: z.string(),

    /**
     * OS signal to send to the process (e.g. `'SIGTERM'`, `'SIGKILL'`).
     * Defaults to `'SIGTERM'` when omitted.
     */
    signal: z.string().optional(),
  }),
  response: z.object({
    /** Whether the stop signal was successfully delivered. */
    success: z.boolean(),
  }),
};

export type NativeSupervisorStopRequest = z.infer<typeof NativeSupervisorStopSchema.request>;
export type NativeSupervisorStopResponse = z.infer<typeof NativeSupervisorStopSchema.response>;

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * A snapshot of a single supervised runtime returned by the status query.
 */
export const SupervisorRuntimeSnapshotSchema = z.object({
  /** Supervisor-assigned session ID. */
  supervisorSessionId: z.string(),

  /** Stable client package identifier. */
  clientId: z.string(),

  /** OS process ID, or `null` when the process has exited. */
  pid: z.number().int().positive().nullable(),

  /** Current lifecycle status of the supervised runtime. */
  status: SupervisorSessionStatusSchema,

  /** Working directory the process was launched with. */
  cwd: z.string(),

  /** Framework session ID, if the runtime was linked to a session. */
  sessionId: z.string().optional(),

  /** Adapter-assigned session ID, if available. */
  adapterSessionId: z.string().optional(),

  /** Unix epoch timestamp (milliseconds) when the process was started. */
  startedAt: z.number().int().nonnegative(),

  /** Unix epoch timestamp (milliseconds) when the process stopped, if applicable. */
  stoppedAt: z.number().int().nonnegative().optional(),
});

export type SupervisorRuntimeSnapshot = z.infer<typeof SupervisorRuntimeSnapshotSchema>;

/**
 * Request and response schemas for `native-session-supervisor.status`.
 *
 * Queries status for one or all supervised runtimes.
 *
 * The request accepts exactly zero or one locator field:
 * - No locator — returns all known runtimes.
 * - One locator — returns the single runtime matching that field.
 *
 * Providing more than one locator is rejected by the schema so that callers
 * cannot rely on an undocumented priority ordering between fields.
 *
 * Subject: `native-session-supervisor.status`
 * Type: Request (RPC)
 */
export const NativeSupervisorStatusSchema = {
  request: z.union([
    /** No locator — list all supervised runtimes. */
    z.object({}).strict(),

    /** Filter by supervisor-assigned session ID. */
    z
      .object({
        supervisorSessionId: z.string(),
      })
      .strict(),

    /** Filter by framework session ID. */
    z
      .object({
        sessionId: z.string(),
      })
      .strict(),

    /** Filter by adapter-assigned session ID. */
    z
      .object({
        adapterSessionId: z.string(),
      })
      .strict(),
  ]),
  response: z.object({
    /** Snapshots for each runtime matching the request filters. */
    runtimes: z.array(SupervisorRuntimeSnapshotSchema),
  }),
};

export type NativeSupervisorStatusRequest = z.infer<typeof NativeSupervisorStatusSchema.request>;
export type NativeSupervisorStatusResponse = z.infer<typeof NativeSupervisorStatusSchema.response>;

// ---------------------------------------------------------------------------
// Schema record
// ---------------------------------------------------------------------------

/**
 * Native Session Supervisor namespace schemas.
 *
 * Maps dot-notation subject keys to their request/response schemas.
 * Each key is prefixed with `native-session-supervisor.` on the bus.
 */
export const NativeSessionSupervisorSchemas = {
  launch: NativeSupervisorLaunchSchema,
  attach: NativeSupervisorAttachSchema,
  stop: NativeSupervisorStopSchema,
  status: NativeSupervisorStatusSchema,
} satisfies SchemaRecord;
