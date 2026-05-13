/**
 * Global `client.*` binary-management service.
 *
 * The {@link ClientBinaryManager} is a {@link BaseService} that registers
 * handlers for the six binary-management bus subjects:
 *
 * - `client.list`          — assemble the installation inventory with feed metadata
 * - `client.install`       — enqueue a background install job
 * - `client.update`        — refresh feed + install latest + set active
 * - `client.setActive`     — switch the active pointer among installed versions
 * - `client.uninstall`     — remove a specific installed version
 * - `client.resolveBinary` — resolve the execution context for an active binary
 *
 * Async jobs are executed by a {@link ClientBinaryJobRunner}. Persistence is
 * mediated exclusively via the `client-binary:storage.*` bus subjects.
 * @packageDocumentation
 */

import * as path from 'node:path';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type {
  ClientBinaryListEntry,
  ClientDefinition,
  ClientInstallCompleted,
  ClientInstallProgress,
  ManagedInstallDescriptor,
} from '@makaio/contracts/client';
import { BaseService } from '@makaio/service-base';
import { ClientBinaryFeedCache } from './client-binary-feed-cache.js';
import { createNoopStrategyDeps } from './client-binary-noop-strategy-deps.js';
import { ClientBinaryVersionResolver } from './client-binary-version-resolver.js';
import { ClientBinaryJobRunner } from './client-binary-job-runner.js';
import type { StrategyDependencies } from './binary-strategies/index.js';
import { ClientBinaryStorageSubjects } from './storage/client-binary-storage-namespace.js';
import { resolveAndValidateBasePath } from './client-binary-manager-types.js';
import type {
  ClientBinaryManagerConfig,
  ClientDefinitionLookup,
  InstallJob,
  JobCompletionCallback,
} from './client-binary-manager-types.js';
import { ClientDefinitionRegistry } from './client-definition-registry.js';
import { verifyInstalledVersion } from './client-binary-version-verifier.js';
import { ClientBinaryResolver, toVersionCommandTuple } from './client-binary-resolver.js';
import { StrategyFeedFetcher } from './client-binary-strategy-feed-fetcher.js';
import { assembleBinaryList } from './client-binary-list-assembler.js';
import { assertSupportedBinaryVersion } from './client-binary-version-support.js';

// ---------------------------------------------------------------------------
// Manager implementation
// ---------------------------------------------------------------------------

/** Validated definition + descriptor pair returned by {@link ClientBinaryManager.requireManagedDefinition}. */
interface ManagedDefinitionResult {
  /** Full client definition. */
  definition: ClientDefinition;
  /** The non-optional managed install descriptor. */
  descriptor: ManagedInstallDescriptor;
}

/**
 * In-memory manager for the global `client.*` binary-management contracts.
 *
 * **Responsibilities:**
 * - Hydrate the feed cache and version resolver from storage on boot.
 * - Handle `client.list`, `client.install`, `client.update`,
 *   `client.setActive`, and `client.uninstall` bus subjects.
 * - Delegate async install/update execution to {@link ClientBinaryJobRunner}.
 * - Persist installation state via `client-binary:storage.*` subjects.
 * - Emit `client.version.changed` whenever the active version pointer changes.
 * - Provide typed progress and completed callbacks to the job runner so that
 *   bus emissions remain in the manager layer with correct type inference.
 *
 * **One job per client invariant:** only one install or update job is allowed
 * to run for a given client at a time. Concurrent requests are rejected with
 * an error until the in-flight job completes.
 */
export class ClientBinaryManager extends BaseService {
  private readonly feedCache: ClientBinaryFeedCache;
  private readonly versionResolver: ClientBinaryVersionResolver;
  private readonly jobRunner: ClientBinaryJobRunner;
  private readonly strategyDeps: StrategyDependencies;
  private readonly resolvedBasePath: string;
  private readonly resolver: ClientBinaryResolver;

  /**
   * Set of client IDs with an operation (install, update, or uninstall) in
   * progress.
   *
   * Acquired synchronously before any async work to serialize concurrent
   * requests per client and prevent the TOCTOU window between a guard check
   * and the eventual {@link ClientBinaryJobRunner.startJob} call.
   *
   * Released by the `makeCompletedCallback` `.finally()` on job termination,
   * by the `handleUninstall` `finally` block on uninstall completion, or by
   * {@link onDestroy} on manager teardown.
   */
  private readonly pendingClients = new Set<string>();

  /**
   * Creates a new binary manager.
   * @param bus - Bus instance for handler registration and event emission
   * @param config - Manager configuration; `basePath` and `configBasePath` must be non-empty absolute paths
   * @param definitionLookup - Client definition registry
   * @param strategyDeps - I/O dependency implementations for strategies
   * @throws When `config.basePath` or `config.configBasePath` is empty or relative
   */
  public constructor(
    bus: IMakaioBus = MakaioBus,
    private readonly config: ClientBinaryManagerConfig,
    private readonly definitionLookup: ClientDefinitionLookup = new ClientDefinitionRegistry([]),
    strategyDeps: StrategyDependencies = createNoopStrategyDeps(),
  ) {
    super(bus);
    this.resolvedBasePath = resolveAndValidateBasePath(config.basePath, 'ClientBinaryManager');
    const resolvedConfigBasePath = resolveAndValidateBasePath(
      config.configBasePath,
      'ClientBinaryManager configBasePath',
    );
    this.strategyDeps = strategyDeps;
    this.feedCache = new ClientBinaryFeedCache(bus);
    const feedFetcher = new StrategyFeedFetcher(strategyDeps);
    this.versionResolver = new ClientBinaryVersionResolver(feedFetcher);
    this.jobRunner = new ClientBinaryJobRunner(strategyDeps, config);
    this.resolver = new ClientBinaryResolver({
      bus,
      resolvedBasePath: this.resolvedBasePath,
      resolvedConfigBasePath,
      definitionLookup,
      exec: strategyDeps.exec,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Hydrate state from storage and register bus handlers.
   */
  protected override async onInit(): Promise<void> {
    await this.hydrateFromStorage();

    this.registerHandler(ClientSubjects.list, async (ctx) => {
      const clients = await this.handleList(ctx.payload.forceRefresh ?? false);
      ctx.setResult({ clients });
    });

    this.registerHandler(ClientSubjects.install, async (ctx) => {
      const result = await this.handleInstall(ctx.payload.clientId, ctx.payload.version);
      ctx.setResult(result);
    });

    this.registerHandler(ClientSubjects.update, async (ctx) => {
      const result = await this.handleUpdate(ctx.payload.clientId);
      ctx.setResult(result);
    });

    this.registerHandler(ClientSubjects.setActive, async (ctx) => {
      const result = await this.handleSetActive(ctx.payload.clientId, ctx.payload.version);
      ctx.setResult(result);
    });

    this.registerHandler(ClientSubjects.uninstall, async (ctx) => {
      const result = await this.handleUninstall(ctx.payload.clientId, ctx.payload.version);
      ctx.setResult(result);
    });

    this.registerHandler(ClientSubjects.resolveBinary, async (ctx) => {
      const result = await this.resolver.resolve(ctx.payload.clientId);
      ctx.setResult(result);
    });
  }

  /**
   * Cancel all running jobs and clear in-memory state.
   */
  protected override onDestroy(): void {
    this.jobRunner.cancelAll();
    this.versionResolver.clear();
    this.pendingClients.clear();
  }

  // -------------------------------------------------------------------------
  // Handler implementations
  // -------------------------------------------------------------------------

  /**
   * Assemble the installation inventory for all managed clients.
   *
   * Delegates to {@link assembleBinaryList} for the read-model assembly logic.
   * @param forceRefresh - When `true`, force a live upstream feed refresh
   * @returns Assembled list of client binary entries
   */
  private async handleList(forceRefresh: boolean): Promise<ClientBinaryListEntry[]> {
    return assembleBinaryList(this.bus, this.versionResolver, this.feedCache, this.definitionLookup, forceRefresh);
  }

  /**
   * Enqueue a background install job for a managed client binary.
   *
   * Resolves the target version (explicit or latest-from-feed) and returns
   * a `jobId` immediately. The job runs asynchronously; callers track progress
   * via `client.installJob.progress` and `client.installJob.completed` events.
   * @param clientId - Stable client identifier to install
   * @param requestedVersion - Explicit version to install, or `undefined` for latest
   * @returns Job acknowledgement with resolved version
   */
  private async handleInstall(
    clientId: string,
    requestedVersion: string | undefined,
  ): Promise<{ jobId: string; requestedVersion: string | null; resolvedVersion: string | null }> {
    const { definition, descriptor } = this.requireManagedDefinition(clientId, 'client.install');

    return this.withClientLock(clientId, async () => {
      const { version: resolvedVersion, explicit } = await this.versionResolver.resolveInstallVersion(
        clientId,
        descriptor,
        requestedVersion,
      );
      if (definition.binary !== undefined) {
        assertSupportedBinaryVersion(
          'client.install',
          clientId,
          resolvedVersion,
          definition.binary.supportedVersions,
          requestedVersion === undefined ? 'resolved binary version' : 'requested binary version',
        );
      }

      // When the caller did not supply an explicit version, the resolver may
      // have performed a live upstream feed fetch to determine the latest
      // version. Persist the resulting feed metadata so that subsequent list
      // calls and process restarts reflect the freshly fetched version, not a
      // stale-or-absent cache entry.
      if (!explicit) {
        const refreshedMeta = this.versionResolver.getLatestVersionMeta(clientId);
        await this.feedCache.update(
          clientId,
          refreshedMeta.latestAvailableVersion,
          refreshedMeta.latestVersionSourceStatus,
        );
      }

      const jobId = this.startInstallJob(clientId, resolvedVersion, descriptor, definition, false, 'install');

      return {
        jobId,
        requestedVersion: requestedVersion ?? null,
        resolvedVersion,
      };
    });
  }

  /**
   * Refresh the feed, resolve the latest version, and enqueue an update job
   * that installs and activates the result.
   * @param clientId - Stable client identifier to update
   * @returns Job acknowledgement with resolved version
   */
  private async handleUpdate(clientId: string): Promise<{ jobId: string; resolvedVersion: string | null }> {
    const { definition, descriptor } = this.requireManagedDefinition(clientId, 'client.update');

    return this.withClientLock(clientId, async () => {
      // Force a live feed refresh so the update always installs the true latest.
      // If the refresh fails (network error, parse failure, etc.) we must not fall
      // back to a potentially stale cached version — the caller expects the update
      // to reflect the current upstream state.
      const refreshed = await this.versionResolver.refresh(clientId, descriptor);
      const meta = this.versionResolver.getLatestVersionMeta(clientId);
      await this.feedCache.update(clientId, meta.latestAvailableVersion, refreshed ? 'fresh' : 'error');

      if (!refreshed || meta.latestAvailableVersion === null) {
        throw new Error(`client.update: failed to resolve latest version for client '${clientId}'`);
      }

      const resolvedVersion = meta.latestAvailableVersion;
      if (definition.binary !== undefined) {
        assertSupportedBinaryVersion(
          'client.update',
          clientId,
          resolvedVersion,
          definition.binary.supportedVersions,
          'resolved binary version',
        );
      }
      const jobId = this.startInstallJob(clientId, resolvedVersion, descriptor, definition, true, 'update');

      return { jobId, resolvedVersion };
    });
  }

  /**
   * Switch the active binary pointer to an already-installed version.
   *
   * The requested version must be present in the installed versions list;
   * requests for uninstalled versions are rejected with an error.
   * @param clientId - Stable client identifier
   * @param version - Exact installed version string to activate
   * @returns Updated client and active version
   */
  private async handleSetActive(
    clientId: string,
    version: string,
  ): Promise<{ clientId: string; activeVersion: string }> {
    // handleSetActive/handleUninstall open-code the pendingClients guard with
    // try/finally instead of using withClientLock because they always release
    // on completion. withClientLock intentionally retains the lock on success
    // so that async install/update jobs can hold it until the job runner
    // finishes — a different release semantic.
    if (this.pendingClients.has(clientId)) {
      throw new Error(`Operation already in progress for client "${clientId}"`);
    }
    this.pendingClients.add(clientId);

    try {
      const { versions } = await this.bus.request(ClientBinaryStorageSubjects.listVersions, { clientId });
      const versionRecord = versions.find((v) => v.version === version);

      if (versionRecord === undefined) {
        throw new Error(`client.setActive: version '${version}' is not installed for client '${clientId}'`);
      }

      const definition = this.definitionLookup.getDefinition(clientId);
      if (definition === undefined) {
        throw new Error(`client.setActive: no definition registered for client '${clientId}'`);
      }
      if (definition.binary !== undefined) {
        assertSupportedBinaryVersion(
          'client.setActive',
          clientId,
          version,
          definition.binary.supportedVersions,
          'requested binary version',
        );
      }
      const versionCommand = toVersionCommandTuple(definition.versionCommand);
      if (versionCommand === undefined) {
        throw new Error(`client.setActive: no versionCommand registered for client '${clientId}'`);
      }
      if (!(await this.resolver.isExpectedInstallPath(versionRecord.installPath, clientId, version))) {
        throw new Error(
          `client.setActive: stored installPath "${versionRecord.installPath}" does not match the expected install directory for ${clientId}@${version}`,
        );
      }
      await verifyInstalledVersion(this.strategyDeps.exec, versionRecord.installPath, versionCommand, version);

      await this.patchActiveVersion(clientId, version, 'set-active');

      return { clientId, activeVersion: version };
    } finally {
      this.pendingClients.delete(clientId);
    }
  }

  /**
   * Remove a specific installed version of a managed client binary.
   *
   * The version row and active-version pointer are cleared atomically in a
   * single storage transaction via `removeVersionAndClearActive`. Filesystem
   * cleanup and event emission occur in the manager layer after the transaction
   * commits, keeping I/O out of the storage handler.
   *
   * If the removed version was active, `client.version.changed` is emitted.
   * No automatic replacement is made — callers must explicitly call
   * `client.setActive` to promote another version.
   * @param clientId - Stable client identifier
   * @param version - Exact version string to remove
   * @returns Removal result with the updated active version
   */
  private async handleUninstall(
    clientId: string,
    version: string,
  ): Promise<{ clientId: string; removedVersion: string; activeVersion: string | null }> {
    // Serialize per-client operations. The pendingClients set covers all in-flight
    // operations — install, update, and uninstall — because the lock is acquired
    // synchronously before any async work and released only when the operation
    // fully terminates.
    if (this.pendingClients.has(clientId)) {
      throw new Error(`Operation already in progress for client "${clientId}"`);
    }
    this.pendingClients.add(clientId);

    try {
      // Verify the version is installed before invoking the atomic storage operation.
      const { versions } = await this.bus.request(ClientBinaryStorageSubjects.listVersions, { clientId });
      const versionRecord = versions.find((v) => v.version === version);

      if (versionRecord === undefined) {
        throw new Error(`client.uninstall: version '${version}' is not installed for client '${clientId}'`);
      }

      // Atomically remove the version row and clear the active pointer when it
      // points to the deleted version. This single transaction prevents a
      // concurrent reader from observing a state where the version is absent
      // but the active pointer still references it.
      const { removedVersion, previousActiveVersion, activeVersion } = await this.bus.request(
        ClientBinaryStorageSubjects.removeVersionAndClearActive,
        { clientId, version, updatedAt: Date.now() },
      );

      if (removedVersion === null) {
        throw new Error(`client.uninstall: failed to delete version '${version}' for client '${clientId}'`);
      }

      const installPath: unknown = versionRecord.installPath;
      const resolvedInstallPath =
        typeof installPath === 'string' && installPath.length > 0 ? path.resolve(installPath) : null;
      if (
        typeof installPath !== 'string' ||
        installPath.length === 0 ||
        resolvedInstallPath === null ||
        !path.isAbsolute(installPath) ||
        !(await this.resolver.isExpectedInstallPath(resolvedInstallPath, clientId, version))
      ) {
        console.warn(
          `[ClientBinaryManager] Skipping removeDirectory: stored installPath "${String(installPath)}" does not match the expected install directory for ${clientId}@${version}`,
        );
      } else {
        await this.strategyDeps.removeDirectory(resolvedInstallPath).catch((err: unknown) => {
          console.warn(
            `[ClientBinaryManager] Failed to remove binary directory "${resolvedInstallPath}" for ${clientId}@${version}:`,
            err,
          );
        });
      }

      // Emit version.changed when the atomic transaction cleared the active pointer.
      if (previousActiveVersion !== null && activeVersion === null) {
        try {
          await this.bus.emit(ClientSubjects.version.changed, {
            clientId,
            previousActiveVersion,
            activeVersion: null,
            reason: 'uninstall',
          });
        } catch (err) {
          console.warn('[ClientBinaryManager] Failed to emit client.version.changed:', err);
        }
      }

      return { clientId, removedVersion: version, activeVersion };
    } finally {
      this.pendingClients.delete(clientId);
    }
  }

  // -------------------------------------------------------------------------
  // Active-version state mutation
  // -------------------------------------------------------------------------

  /**
   * Update the active version pointer and optionally emit
   * `client.version.changed`.
   *
   * Centralizes the storage-side active-version mutation used by
   * `handleSetActive` and the job completion callback. Feed-cache fields are
   * preserved by `client-binary:storage.setActiveVersion`.
   * @param clientId - Stable client identifier
   * @param newActiveVersion - Version to set active, or `null` to clear
   * @param reason - Operation that triggered the change
   * @returns The previous active version before the mutation
   */
  private async patchActiveVersion(
    clientId: string,
    newActiveVersion: string | null,
    reason: 'install' | 'update' | 'set-active',
  ): Promise<string | null> {
    const result = await this.bus.request(ClientBinaryStorageSubjects.setActiveVersion, {
      clientId,
      activeVersion: newActiveVersion,
      updatedAt: Date.now(),
    });
    const previousActiveVersion = result.previousActiveVersion;

    if (previousActiveVersion !== newActiveVersion) {
      // Best-effort: state is already persisted — emission failure must not
      // make the operation appear failed when the active version was committed.
      try {
        await this.bus.emit(ClientSubjects.version.changed, {
          clientId,
          previousActiveVersion,
          activeVersion: newActiveVersion,
          reason,
        });
      } catch (err) {
        console.warn('[ClientBinaryManager] Failed to emit client.version.changed:', err);
      }
    }

    return previousActiveVersion;
  }

  // -------------------------------------------------------------------------
  // Boot hydration
  // -------------------------------------------------------------------------

  /**
   * Hydrate feed cache and version resolver from persisted storage.
   *
   * Called once during `onInit()`. Populates the in-memory caches so that
   * `client.list` and `client.install` requests do not need a live feed fetch
   * on the first call after a process restart. Both caches are seeded from
   * a single `loadAllState` bus round-trip.
   */
  private async hydrateFromStorage(): Promise<void> {
    const states = await this.feedCache.hydrate();

    for (const state of states) {
      if (state.latestAvailableVersion !== null && state.latestVersionLastCheckedAt !== null) {
        this.versionResolver.seedFromStorage(
          state.clientId,
          state.latestAvailableVersion,
          state.latestVersionLastCheckedAt,
          state.latestVersionSourceStatus,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Definition lookup, client lock, and job start helpers
  // -------------------------------------------------------------------------

  /**
   * Look up and validate a managed client definition.
   *
   * Throws when no definition is registered for `clientId` or when the
   * definition lacks a `managedInstall` descriptor.
   * @param clientId - Stable client identifier
   * @param subject - Bus subject name used in error messages
   * @returns The full definition and its managed install descriptor
   */
  private requireManagedDefinition(clientId: string, subject: string): ManagedDefinitionResult {
    const definition = this.definitionLookup.getDefinition(clientId);
    if (definition === undefined) {
      throw new Error(`${subject}: no definition registered for client '${clientId}'`);
    }
    const descriptor = definition.managedInstall;
    if (descriptor === undefined) {
      throw new Error(`${subject}: client '${clientId}' does not declare a managed install descriptor`);
    }
    return { definition, descriptor };
  }

  /**
   * Acquire the per-client operation lock, run `fn`, and release the lock on
   * pre-job errors via the catch path.
   *
   * On successful job start the lock transfers to the
   * `makeCompletedCallback`, which releases it on job termination.
   * @param clientId - Stable client identifier to lock
   * @param fn - Async work to run while the lock is held
   * @returns The result of `fn`
   */
  private async withClientLock<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
    if (this.pendingClients.has(clientId)) {
      throw new Error(`Operation already in progress for client "${clientId}"`);
    }
    this.pendingClients.add(clientId);

    try {
      return await fn();
    } catch (err) {
      this.pendingClients.delete(clientId);
      throw err;
    }
  }

  /**
   * Build an {@link InstallJob} and hand it to the job runner.
   * @param clientId - Stable client identifier
   * @param resolvedVersion - Concrete version to install
   * @param descriptor - Managed install descriptor
   * @param definition - Full client definition (for post-install and version command)
   * @param makeActive - Whether to activate the version after install
   * @param reason - Originating operation
   * @returns The generated `jobId`
   */
  private startInstallJob(
    clientId: string,
    resolvedVersion: string,
    descriptor: ManagedInstallDescriptor,
    definition: ClientDefinition,
    makeActive: boolean,
    reason: 'install' | 'update',
  ): string {
    const job: InstallJob = {
      jobId: crypto.randomUUID(),
      clientId,
      version: resolvedVersion,
      strategy: descriptor.type,
      status: 'pending',
      makeActive,
      reason,
    };

    // Progress: best-effort bus emission; failures must not surface to job runner.
    const onProgress = (payload: ClientInstallProgress): void => {
      void this.bus.emit(ClientSubjects.installJob.progress, payload).catch((err: unknown) => {
        console.warn('[ClientBinaryManager] Failed to emit client.installJob.progress:', err);
      });
    };

    // Completed: release the per-client lock *before* emitting so that listeners
    // or immediately-following operations can start a new job for the same client
    // without racing the emit's microtask chain.
    const onCompleted = async (payload: ClientInstallCompleted): Promise<void> => {
      this.pendingClients.delete(payload.clientId);
      await this.bus.emit(ClientSubjects.installJob.completed, payload).catch((err: unknown) => {
        console.warn('[ClientBinaryManager] Failed to emit client.installJob.completed:', err);
      });
    };

    this.jobRunner.startJob(
      job,
      descriptor,
      onProgress,
      this.makeCompletionCallback(),
      onCompleted,
      definition.postInstall,
      toVersionCommandTuple(definition.versionCommand),
    );

    return job.jobId;
  }

  // -------------------------------------------------------------------------
  // Job completion callback
  // -------------------------------------------------------------------------

  /**
   * Create the completion callback passed to the job runner.
   *
   * Persists the installed version to storage and optionally sets it as active,
   * then emits `client.version.changed` with the originating operation reason.
   *
   * **Consistency guarantee:** version persistence and optional activation
   * are committed through one storage transaction, so a failed activation
   * cannot leave a version row pointing at a directory the runner will remove.
   * @returns Bound completion callback for the job runner
   */
  private makeCompletionCallback(): JobCompletionCallback {
    return async ({ clientId, version, installPath, makeActive, reason }) => {
      const now = Date.now();

      const result = await this.bus.request(ClientBinaryStorageSubjects.recordInstalledVersion, {
        versionRecord: {
          id: crypto.randomUUID(),
          clientId,
          version,
          installPath,
          installedAt: now,
          createdAt: now,
        },
        makeActive,
        updatedAt: now,
      });

      if (makeActive && result.previousActiveVersion !== result.activeVersion) {
        // Best-effort: state is already persisted — emission failure must not
        // make the operation appear failed when the active version was committed.
        try {
          await this.bus.emit(ClientSubjects.version.changed, {
            clientId,
            previousActiveVersion: result.previousActiveVersion,
            activeVersion: result.activeVersion,
            reason,
          });
        } catch (err) {
          console.warn('[ClientBinaryManager] Failed to emit client.version.changed:', err);
        }
      }
    };
  }
}
