/**
 * Shared types and utilities for the {@link ClientBinaryManager} and
 * {@link ClientBinaryJobRunner}.
 *
 * These types are intentionally separated from the manager implementation so
 * that the job runner can import them without creating a circular dependency.
 * @packageDocumentation
 */

import * as path from 'node:path';
import type {
  ClientDefinition,
  ClientInstallCompleted,
  ClientInstallProgress,
  ManagedInstallStrategy,
  PostInstallDescriptor,
} from '@makaio/contracts/client';
import { isPathWithinBase as isPathWithinResolvedBase } from './client-binary-paths.js';

// ---------------------------------------------------------------------------
// Manager configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the managed binary base directory.
 *
 * The manager derives per-client, per-version install directories from
 * `basePath` using the pattern `{basePath}/{clientId}/{version}/`.
 */
export interface ClientBinaryJobRunnerConfig {
  /**
   * Absolute base directory under which all managed binary versions are
   * installed (e.g. `~/.makaio/binaries/`).
   */
  basePath: string;

  /**
   * Framework-owned handlers for declarative post-install descriptors.
   *
   * Client packages declare `postInstall.kind`; the host supplies the handler
   * implementation here. Missing handlers fail the install job rather than
   * silently skipping a declared lifecycle step.
   */
  postInstallHandlers?: ReadonlyMap<string, PostInstallHandler>;
}

/**
 * Configuration for the managed binary manager.
 */
export interface ClientBinaryManagerConfig extends ClientBinaryJobRunnerConfig {
  /**
   * Base directory for per-client config isolation directories.
   *
   * Managed binaries get `{configBasePath}/{clientId}/config/` as their
   * isolated config dir (e.g. `~/.makaio/clients/claude-code/config/`).
   *
   * Used by `client.resolveBinary` to construct the managed config path when
   * the definition declares `configIsolation`.
   */
  configBasePath: string;
}

/**
 * Context passed to a framework-owned post-install handler.
 */
export interface PostInstallContext {
  /** Stable client identifier being installed. */
  clientId: string;
  /** Concrete version that was installed. */
  version: string;
  /** Absolute directory where the strategy installed the binary. */
  installPath: string;
  /** Declarative descriptor from the client definition. */
  descriptor: PostInstallDescriptor;
}

/**
 * Framework-owned handler for a declarative post-install action.
 *
 * Returning metadata is optional; when present it is forwarded on install
 * progress and completion events.
 */
export type PostInstallHandler = (
  context: PostInstallContext,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

// ---------------------------------------------------------------------------
// Install job
// ---------------------------------------------------------------------------

/**
 * An in-flight or completed install/update job.
 *
 * Jobs are created synchronously by `client.install` and `client.update`
 * handlers and executed asynchronously by the {@link ClientBinaryJobRunner}.
 */
export interface InstallJob {
  /** Opaque stable identifier for this job (UUID v4). */
  jobId: string;
  /** Stable client identifier this job is installing. */
  clientId: string;
  /**
   * Concrete version to install. Set immediately after version resolution;
   * remains the resolved version string throughout execution.
   */
  version: string;
  /**
   * Install strategy discriminant corresponding to the managed install
   * descriptor that was used to create the job.
   */
  strategy: ManagedInstallStrategy;
  /** Current lifecycle state of the job. */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /**
   * When `true`, the job runner sets this version as active on successful
   * completion.
   */
  makeActive: boolean;
  /**
   * The originating bus subject that created this job.
   *
   * Used to set the correct `reason` on `client.version.changed` events:
   * `'install'` for `client.install` requests, `'update'` for `client.update`
   * requests.
   */
  reason: 'install' | 'update';
}

// ---------------------------------------------------------------------------
// Client definition lookup
// ---------------------------------------------------------------------------

/**
 * Read-only interface used by the manager to retrieve client definitions.
 *
 * On the production boot path the manager receives a
 * {@link ClientDefinitionRegistry} fully seeded before `init()` is called.
 * The manager depends only on the read side of the registry contract;
 * mutation is available on the concrete {@link ClientDefinitionRegistry} class
 * for tests and administrative tooling.
 */
export interface ClientDefinitionLookup {
  /**
   * Return the static definition for the given client identifier, or
   * `undefined` when no definition is registered.
   * @param clientId - Stable client identifier (e.g. `'claude-code'`)
   * @returns The registered {@link ClientDefinition}, or `undefined`
   */
  getDefinition(clientId: string): ClientDefinition | undefined;

  /**
   * Return all registered definitions known to this lookup.
   *
   * `client.list` uses this to include managed clients that have no installed
   * versions or state rows yet.
   * @returns Registered client definitions
   */
  listDefinitions(): readonly ClientDefinition[];
}

// ---------------------------------------------------------------------------
// Job runner callbacks
// ---------------------------------------------------------------------------

/**
 * Result passed to the completion callback after a successful install.
 *
 * Bundles the job identity and artifact information into a single object
 * so the callback signature stays stable as new fields are added.
 */
export interface JobCompletionResult {
  /** Job identifier that completed. */
  jobId: string;
  /** Stable client identifier. */
  clientId: string;
  /** Installed version string. */
  version: string;
  /** Absolute path to the installed binary directory. */
  installPath: string;
  /** Whether to activate this version. */
  makeActive: boolean;
  /** Originating operation reason forwarded to `client.version.changed`. */
  reason: 'install' | 'update';
}

/**
 * Callback invoked by the job runner when a job completes successfully and
 * the binary has been written to disk but before activation.
 *
 * The manager uses this to persist the installed version to storage and
 * optionally set it as active.
 * @param result - Completion result with job and artifact details
 */
export type JobCompletionCallback = (result: JobCompletionResult) => Promise<void>;

/**
 * Callback invoked by the job runner at each install pipeline stage transition.
 *
 * The manager provides this callback and emits the typed
 * `client.installJob.progress` bus event.
 * @param payload - Progress event payload to emit
 */
export type JobProgressCallback = (payload: ClientInstallProgress) => void;

/**
 * Callback invoked by the job runner when the install pipeline terminates
 * (success or failure).
 *
 * The manager provides this callback and emits the typed
 * `client.installJob.completed` bus event.
 * @param payload - Completed event payload to emit
 */
export type JobCompletedCallback = (payload: ClientInstallCompleted) => Promise<void>;

// ---------------------------------------------------------------------------
// Path safety utilities
// ---------------------------------------------------------------------------

/**
 * Return `true` when `candidate` resolves within `base`.
 *
 * Used by the manager and job runner to guard against path-traversal
 * in persisted install paths and user-supplied version strings.
 *
 * Both arguments must be absolute paths. Relative inputs are rejected before
 * `path.resolve()` runs so the process working directory cannot turn a
 * relative candidate into an apparently managed path.
 * @param base - Absolute base path
 * @param candidate - Absolute path to validate
 * @returns `true` when the candidate is safely within `base`
 */
export function isPathWithinBase(base: string, candidate: string): boolean {
  if (!path.isAbsolute(base) || !path.isAbsolute(candidate)) {
    return false;
  }
  return isPathWithinResolvedBase(path.resolve(base), path.resolve(candidate));
}

/**
 * Resolve and validate `basePath`, returning the resolved absolute path.
 *
 * Both {@link ClientBinaryManager} and {@link ClientBinaryJobRunner} call this
 * at construction time so the resolved base is computed once and reused.
 * @param basePath - Raw base path from configuration
 * @param caller - Class name for error messages
 * @returns Resolved absolute base path
 * @throws When `basePath` is empty or not absolute
 */
export function resolveAndValidateBasePath(basePath: string, caller: string): string {
  if (!basePath || !path.isAbsolute(basePath)) {
    throw new Error(`${caller} requires a non-empty absolute basePath`);
  }
  return path.resolve(basePath);
}
