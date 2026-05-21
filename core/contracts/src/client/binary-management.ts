/**
 * Binary management schemas for the client domain.
 *
 * Covers install strategies, installed version entries, pinned version metadata,
 * the `client.list` / `client.install` / `client.uninstall` / `client.update` /
 * `client.setActive` command–response pairs, and the install-job progress and
 * completion event payloads.
 * @packageDocumentation
 */

import { z } from 'zod';
import { AbsolutePathSchema, EpochMillisecondsSchema, NonEmptyStringSchema } from './primitives.js';
import { VersionLiteralSchema } from '../version/index.js';

/**
 * Install strategies that Makaio supports for managed client binaries.
 *
 * - `npm`                  — npm registry installation with an exact version pin.
 * - `signed-binary-bucket` — signed static bucket download with an exact version pin.
 */
export const ManagedInstallStrategySchema = z.enum(['npm', 'signed-binary-bucket']);

export type ManagedInstallStrategy = z.infer<typeof ManagedInstallStrategySchema>;

/**
 * A single installed version entry for a managed client binary.
 */
export const InstalledVersionEntrySchema = z.object({
  /** Resolved version string (semver or opaque tag). */
  version: NonEmptyStringSchema,
  /** Absolute path to the installed binary directory. */
  installPath: AbsolutePathSchema,
  /** Epoch timestamp in milliseconds when the binary was installed. */
  installedAt: EpochMillisecondsSchema,
  /** Whether this version is the currently active (symlinked) binary. */
  isActive: z.boolean(),
});

export type InstalledVersionEntry = z.infer<typeof InstalledVersionEntrySchema>;

/**
 * Summary row for a single client in a `client.list` response.
 */
export const ClientBinaryListEntrySchema = z
  .object({
    /** Stable client identifier (e.g. `'claude-code'`). */
    clientId: NonEmptyStringSchema,
    /** All locally installed versions for this client. */
    installedVersions: z.array(InstalledVersionEntrySchema),
    /** The currently active version string, or `null` when none is active. */
    activeVersion: NonEmptyStringSchema.nullable(),
    /**
     * Exact version pinned by the client package's managed install descriptor.
     *
     * This is the version the framework will install or promote to when the
     * client is updated. `updateAvailable` is `true` when the active version
     * does not match this pin.
     */
    pinnedVersion: VersionLiteralSchema,
    /**
     * Whether the active managed version differs from the current package pin.
     *
     * `true`  — the active version is not the pinned version; an install or
     *            update is required to reach the pin.
     * `false` — the active version matches the pin; no update is needed.
     */
    updateAvailable: z.boolean(),
  })
  .strict();

export type ClientBinaryListEntry = z.infer<typeof ClientBinaryListEntrySchema>;

/**
 * Request and response schemas for `client.list`.
 *
 * Returns the local installation inventory for all managed clients, including
 * their pinned version and whether the active version matches the current pin.
 */
export const ClientListSchema = {
  request: z.object({
    /**
     * When `true`, re-evaluate the pinned version state for all clients
     * before returning the list (e.g. after a package update).
     */
    forceRefresh: z.boolean().optional(),
  }),
  response: z.object({
    /** One entry per managed client in the registry. */
    clients: z.array(ClientBinaryListEntrySchema),
  }),
};

export type ClientListRequest = z.infer<typeof ClientListSchema.request>;
export type ClientListResponse = z.infer<typeof ClientListSchema.response>;

/**
 * Request and response schemas for `client.install`.
 *
 * Enqueues a background install job for a managed client binary.
 * Callers can track progress via `client.installJob.progress` and
 * `client.installJob.completed` events using the returned `jobId`.
 */
export const ClientInstallSchema = {
  request: z.object({
    /** Stable client identifier to install (e.g. `'claude-code'`). */
    clientId: NonEmptyStringSchema,
    /**
     * Version to install. When omitted the manager installs the exact version
     * pinned by the client package. When present, it must match that pin.
     */
    version: VersionLiteralSchema.optional(),
  }),
  response: z.object({
    /** Opaque job identifier for tracking progress events. */
    jobId: NonEmptyStringSchema,
    /**
     * Version string as requested by the caller, or `null` when the caller
     * did not specify a version.
     */
    requestedVersion: VersionLiteralSchema.nullable(),
    /**
     * Version that the manager resolved and will install, or `null` when
     * resolution has not yet completed at the time of acknowledgement.
     */
    resolvedVersion: VersionLiteralSchema.nullable(),
  }),
};

export type ClientInstallRequest = z.infer<typeof ClientInstallSchema.request>;
export type ClientInstallResponse = z.infer<typeof ClientInstallSchema.response>;

/**
 * Request and response schemas for `client.uninstall`.
 *
 * Removes a specific installed version of a managed client binary.
 * If the removed version was active, the active pointer is cleared to `null`
 * — no automatic replacement is made. Callers must explicitly call
 * `client.setActive` to promote another installed version.
 */
export const ClientUninstallSchema = {
  request: z.object({
    /** Stable client identifier (e.g. `'claude-code'`). */
    clientId: NonEmptyStringSchema,
    /** Exact version string to remove. */
    version: NonEmptyStringSchema,
  }),
  response: z.object({
    /** Stable client identifier that was modified. */
    clientId: NonEmptyStringSchema,
    /** The version string that was removed from disk. */
    removedVersion: NonEmptyStringSchema,
    /**
     * The active version after removal, or `null` when no installed version
     * remains to promote.
     */
    activeVersion: NonEmptyStringSchema.nullable(),
  }),
};

export type ClientUninstallRequest = z.infer<typeof ClientUninstallSchema.request>;
export type ClientUninstallResponse = z.infer<typeof ClientUninstallSchema.response>;

/**
 * Request and response schemas for `client.update`.
 *
 * Enqueues an update job that installs the client package pin and activates it.
 * Callers can track progress via `client.installJob.progress` and
 * `client.installJob.completed` events using the returned `jobId`.
 */
export const ClientUpdateSchema = {
  request: z.object({
    /** Stable client identifier to update (e.g. `'claude-code'`). */
    clientId: NonEmptyStringSchema,
  }),
  response: z.object({
    /** Opaque job identifier for tracking progress events. */
    jobId: NonEmptyStringSchema,
    /**
     * The exact version pinned by the client package, or `null` when resolution
     * has not yet completed at acknowledgement time.
     */
    resolvedVersion: VersionLiteralSchema.nullable(),
  }),
};

export type ClientUpdateRequest = z.infer<typeof ClientUpdateSchema.request>;
export type ClientUpdateResponse = z.infer<typeof ClientUpdateSchema.response>;

/**
 * Request and response schemas for `client.setActive`.
 *
 * Switches the active binary pointer to an already-installed version.
 * The requested version must be present on disk; the handler will reject
 * requests for versions that have not been installed.
 */
export const ClientSetActiveSchema = {
  request: z.object({
    /** Stable client identifier (e.g. `'claude-code'`). */
    clientId: NonEmptyStringSchema,
    /** Exact installed version string to activate. */
    version: NonEmptyStringSchema,
  }),
  response: z.object({
    /** Stable client identifier that was modified. */
    clientId: NonEmptyStringSchema,
    /** The version string that is now active. */
    activeVersion: NonEmptyStringSchema,
  }),
};

export type ClientSetActiveRequest = z.infer<typeof ClientSetActiveSchema.request>;
export type ClientSetActiveResponse = z.infer<typeof ClientSetActiveSchema.response>;

/**
 * Install pipeline stage identifiers, ordered by progression.
 *
 * - `'resolving'`    — determining the concrete version to install.
 * - `'downloading'`  — fetching the binary archive from upstream.
 * - `'verifying'`    — validating checksums, signatures, or installed binary version.
 * - `'extracting'`   — unpacking the downloaded archive.
 * - `'installing'`   — writing the binary to its final install path.
 * - `'post-install'` — running post-install hooks.
 * - `'activating'`   — marking the installed version as active.
 */
export const InstallStageSchema = z.enum([
  'resolving',
  'downloading',
  'verifying',
  'extracting',
  'installing',
  'post-install',
  'activating',
]);

export type InstallStage = z.infer<typeof InstallStageSchema>;

/**
 * Event payload for `client.installJob.progress`.
 *
 * Emitted by the install job runner at each pipeline stage transition and
 * whenever the download progress percentage changes materially.
 */
export const ClientInstallProgressSchema = z.object({
  /** Opaque job identifier matching the `client.install` or `client.update` response. */
  jobId: NonEmptyStringSchema,
  /** Stable client identifier being installed. */
  clientId: NonEmptyStringSchema,
  /**
   * Version being installed. Absent during the `resolving` stage when the
   * concrete version has not yet been determined; non-empty once resolved.
   */
  version: NonEmptyStringSchema.optional(),
  /** Install strategy used by this job. */
  strategy: ManagedInstallStrategySchema,
  /** Current pipeline stage. */
  stage: InstallStageSchema,
  /**
   * Fractional download or stage progress in `[0, 100]`, or `null` when
   * progress cannot be determined (e.g. during `resolving` or `verifying`).
   */
  progress: z.number().min(0).max(100).nullable(),
  /** Absolute install path, available once the `installing` stage begins. */
  installPath: AbsolutePathSchema.optional(),
  /**
   * Whether this version will become the active binary upon successful
   * completion of the job.
   */
  activeAfterCompletion: z.boolean().optional(),
  /** Arbitrary pass-through metadata from the strategy handler. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ClientInstallProgress = z.infer<typeof ClientInstallProgressSchema>;

/**
 * Terminal install error descriptor emitted in `client.installJob.completed`
 * when the job ends in failure.
 */
export const InstallErrorSchema = z.object({
  /** Human-readable error message. */
  message: z.string(),
  /** Machine-readable error code, if available. */
  code: z.string().optional(),
});

export type InstallError = z.infer<typeof InstallErrorSchema>;

/**
 * Event payload for `client.installJob.completed`.
 *
 * Emitted once by the install job runner when the pipeline finishes,
 * regardless of outcome. Listeners should check `status` before acting.
 */
export const ClientInstallCompletedSchema = z.object({
  /** Opaque job identifier matching the `client.install` or `client.update` response. */
  jobId: NonEmptyStringSchema,
  /** Stable client identifier that was installed. */
  clientId: NonEmptyStringSchema,
  /**
   * Resolved version string of the installed binary. Absent when the job
   * failed before version resolution completed; non-empty when present.
   */
  version: NonEmptyStringSchema.optional(),
  /** Install strategy used by this job. */
  strategy: ManagedInstallStrategySchema,
  /**
   * Terminal outcome of the job.
   * - `'success'` — the binary is installed and, if requested, activated.
   * - `'error'`   — the job failed; inspect `error` for details.
   */
  status: z.enum(['success', 'error']),
  /** Absolute install path of the binary, present on success. */
  installPath: AbsolutePathSchema.optional(),
  /**
   * Active version after completion, or `null` when activation was not
   * requested or when the job failed before activation.
   */
  activeVersion: NonEmptyStringSchema.nullable(),
  /** Error details, populated when `status` is `'error'`. */
  error: InstallErrorSchema.optional(),
  /** Arbitrary pass-through metadata from the strategy handler. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ClientInstallCompleted = z.infer<typeof ClientInstallCompletedSchema>;

/**
 * Event payload for `client.version.changed`.
 *
 * Emitted whenever the active-version pointer for a managed client changes,
 * regardless of the operation that caused the change.
 */
export const ClientVersionChangedSchema = z.object({
  /** Stable client identifier whose active version changed. */
  clientId: NonEmptyStringSchema,
  /**
   * The active version before the change, or `null` when no version was
   * previously active.
   */
  previousActiveVersion: NonEmptyStringSchema.nullable(),
  /**
   * The active version after the change, or `null` when the active pointer
   * was cleared (e.g. after uninstalling the only installed version).
   */
  activeVersion: NonEmptyStringSchema.nullable(),
  /**
   * The operation that caused the version change.
   * - `'install'`    — a new install job completed and activated the binary.
   * - `'update'`     — an update job completed and activated the binary.
   * - `'set-active'` — a `client.setActive` request was processed.
   * - `'uninstall'`  — the previously active version was removed.
   */
  reason: z.enum(['install', 'update', 'set-active', 'uninstall']),
});

export type ClientVersionChanged = z.infer<typeof ClientVersionChangedSchema>;
