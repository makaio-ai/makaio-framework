/**
 * Async install job runner for managed client binaries.
 *
 * The runner is a pure execution unit — it owns no bus handler registration,
 * no storage access, and no version resolution. Its sole responsibility is to
 * drive the strategy pipeline for a given {@link InstallJob} and invoke the
 * typed callbacks provided by the {@link ClientBinaryManager} for progress,
 * completion, and storage persistence.
 *
 * Bus emission is decoupled from the runner: the manager provides typed
 * callbacks for `client.installJob.progress` and `client.installJob.completed`
 * events so that the runner stays free of bus dependencies.
 *
 * The enclosing {@link ClientBinaryManager} creates jobs, calls
 * {@link ClientBinaryJobRunner.startJob}, and receives completion callbacks
 * via {@link JobCompletionCallback} so that persistence and activation remain
 * in the manager layer.
 * @packageDocumentation
 */

import * as path from 'node:path';
import type {
  ClientInstallProgress,
  InstallStage,
  ManagedInstallDescriptor,
  PostInstallDescriptor,
} from '@makaio/contracts/client';
import { createStrategy } from './binary-strategies/index.js';
import type { InstallArtifact, StrategyDependencies } from './binary-strategies/index.js';
import { isPathWithinBase, resolveAndValidateBasePath } from './client-binary-manager-types.js';
import type {
  ClientBinaryManagerConfig,
  PostInstallHandler,
  InstallJob,
  JobCompletedCallback,
  JobCompletionCallback,
  JobProgressCallback,
} from './client-binary-manager-types.js';
import { verifyInstalledVersion } from './client-binary-version-verifier.js';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Executes install jobs asynchronously and delivers progress and completed
 * notifications via caller-provided typed callbacks.
 *
 * **Lifecycle:**
 * 1. The {@link ClientBinaryManager} creates an {@link InstallJob} and calls
 *    {@link startJob}.
 * 2. The runner starts the job in the background (fire-and-forget `void`).
 * 3. As the strategy moves through pipeline stages, the runner invokes the
 *    `onProgress` callback with typed progress payloads.
 * 4. On success the runner invokes {@link JobCompletionCallback} (for
 *    persistence and activation) and then `onCompleted` with
 *    `status: 'success'`.
 * 5. On failure the runner invokes `onCompleted` with `status: 'error'` and
 *    skips the persistence callback.
 * 6. {@link cancelAll} sets a cancellation flag and clears the job map so
 *    that any in-flight async work skips callbacks after shutdown. The
 *    underlying I/O (network, disk) is not interrupted.
 */
export class ClientBinaryJobRunner {
  /** Active jobs keyed by `jobId`. */
  private readonly jobs = new Map<string, InstallJob>();

  /** Set to `true` by {@link cancelAll} to prevent callbacks from firing after destroy. */
  #cancelled = false;

  private readonly resolvedBasePath: string;

  /**
   * @param strategyDeps - I/O dependency implementations forwarded to each strategy
   * @param config - Manager configuration (provides `basePath`)
   */
  public constructor(
    private readonly strategyDeps: StrategyDependencies,
    private readonly config: ClientBinaryManagerConfig,
  ) {
    this.resolvedBasePath = resolveAndValidateBasePath(config.basePath, 'ClientBinaryJobRunner');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a background install job and return immediately.
   *
   * The job is registered in the internal job map and executed asynchronously.
   * Callers must not await the returned value — the job reports its outcome
   * through the provided callbacks.
   *
   * Pipeline order:
   * 1. Strategy execute (download → checksum → extract → install)
   * 2. Post-install hook (if declared)
   * 3. Version verification (if `versionCommand` is provided)
   * 4. `onComplete` persistence callback
   * 5. `onCompleted` bus-event callback
   * @param job - Job descriptor created by the manager
   * @param descriptor - Managed install descriptor for the client
   * @param onProgress - Callback invoked at each pipeline stage transition
   * @param onComplete - Callback invoked by the runner on successful completion (persistence)
   * @param onCompleted - Callback invoked after completion (bus event emission)
   * @param postInstall - Optional post-install descriptor from the client definition
   * @param versionCommand - Optional version command used to verify the installed binary
   * @returns The `jobId` of the started job (same as `job.jobId`)
   */
  public startJob(
    job: InstallJob,
    descriptor: ManagedInstallDescriptor,
    onProgress: JobProgressCallback,
    onComplete: JobCompletionCallback,
    onCompleted: JobCompletedCallback,
    postInstall?: PostInstallDescriptor,
    versionCommand?: readonly [string, ...string[]],
  ): string {
    const running: InstallJob = { ...job, status: 'running' };
    this.jobs.set(job.jobId, running);

    // Intentionally not awaited — the job runs in the background.
    void this.runJob(running, descriptor, onProgress, onComplete, onCompleted, postInstall, versionCommand);

    return job.jobId;
  }

  /**
   * Signal cancellation and clear all tracked jobs.
   *
   * Called by the manager during shutdown. Sets the cancellation flag so that
   * any in-flight async work skips its callbacks after this point. Clears the
   * internal job map to avoid memory leaks across test resets.
   */
  public cancelAll(): void {
    this.#cancelled = true;
    this.jobs.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Invoke the progress callback without propagating exceptions.
   *
   * Progress emission is best-effort: if the manager's progress publisher
   * throws (e.g. a bus error or a subscriber that throws), the error is
   * swallowed so that the install pipeline can continue unaffected.
   * @param onProgress - Progress notification callback provided by the manager
   * @param payload - Progress event payload to emit
   */
  private safeOnProgress(onProgress: JobProgressCallback, payload: ClientInstallProgress): void {
    try {
      onProgress(payload);
    } catch {
      // Progress emission is best-effort and must not fail the install.
    }
  }

  /**
   * Emit progress only while the runner is active.
   *
   * Helper methods use this instead of open-coding `#cancelled` checks so a
   * shutdown that arrives between the caller's outer guard and the helper body
   * cannot leak progress events from a destroyed manager.
   * @param onProgress - Progress notification callback provided by the manager
   * @param payload - Progress event payload to emit
   * @returns `true` when the event was emitted; `false` when cancelled
   */
  private emitProgressIfActive(onProgress: JobProgressCallback, payload: ClientInstallProgress): boolean {
    if (this.#cancelled) {
      return false;
    }
    this.safeOnProgress(onProgress, payload);
    return !this.#cancelled;
  }

  // -------------------------------------------------------------------------
  // Private execution
  // -------------------------------------------------------------------------

  /**
   * Execute a single install job to completion.
   *
   * This method drives the strategy pipeline, invokes the progress callback
   * at each stage, calls the persistence callback on success, and always
   * invokes the completed callback at the end regardless of outcome.
   *
   * All callbacks are guarded by the `#cancelled` flag: if {@link cancelAll}
   * is called while the job is in flight (e.g. during shutdown), no further
   * callbacks will fire after that point.
   * @param job - The running job descriptor
   * @param descriptor - Managed install descriptor for the client
   * @param onProgress - Progress notification callback
   * @param onComplete - Persistence callback invoked on successful completion
   * @param onCompleted - Bus event emission callback invoked after all work
   * @param postInstall - Optional declarative post-install descriptor
   * @param versionCommand - Optional version command used to verify the installed binary
   */
  private async runJob(
    job: InstallJob,
    descriptor: ManagedInstallDescriptor,
    onProgress: JobProgressCallback,
    onComplete: JobCompletionCallback,
    onCompleted: JobCompletedCallback,
    postInstall?: PostInstallDescriptor,
    versionCommand?: readonly [string, ...string[]],
  ): Promise<void> {
    try {
      const targetDir = this.resolveTargetDir(job.clientId, job.version);
      const strategy = createStrategy(descriptor, this.strategyDeps);
      if (strategy === undefined) {
        throw new Error(`Unsupported managed install descriptor type: ${descriptor.type}`);
      }

      const artifact = await strategy.execute(
        job.version,
        targetDir,
        (stage: InstallStage, progress: number | null) => {
          this.emitProgressIfActive(onProgress, {
            jobId: job.jobId,
            clientId: job.clientId,
            version: job.version,
            strategy: job.strategy,
            stage,
            progress,
            installPath: stage === 'installing' ? targetDir : undefined,
            activeAfterCompletion: job.makeActive,
          });
        },
      );

      if (this.#cancelled) return;

      let metadata: Record<string, unknown> | undefined;
      try {
        // Run the post-install hook before verification so that the hook can
        // perform any steps (e.g. chmod) that the version command depends on.
        metadata = await this.runPostInstall(job, artifact.installPath, postInstall, onProgress);

        if (this.#cancelled) return;

        if (versionCommand !== undefined) {
          await this.runVersionVerification(job, artifact.installPath, versionCommand, onProgress);
        }
      } catch (error) {
        if (!this.#cancelled) {
          await this.cleanupStagedArtifact(artifact.installPath);
        }
        throw error;
      }

      if (this.#cancelled) return;

      await this.finalizeSuccess(job, artifact, metadata, onProgress, onComplete, onCompleted);
    } catch (err) {
      if (this.#cancelled) return;

      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : undefined;

      // Guard against unhandled rejection cascades from the event emission itself.
      try {
        await onCompleted({
          jobId: job.jobId,
          clientId: job.clientId,
          version: job.version,
          strategy: job.strategy,
          status: 'error',
          activeVersion: null,
          error: { message, ...(code !== undefined ? { code } : {}) },
        });
      } catch {
        // Swallow: the install already failed; suppress secondary event-emission errors.
      }
    } finally {
      // Always remove job to avoid unbounded memory growth in long-running processes.
      this.jobs.delete(job.jobId);
    }
  }

  /**
   * Drive the success-path finalization: emit the `activating` stage when
   * applicable, persist the artifact via `onComplete`, then emit the
   * `client.installJob.completed` event via `onCompleted`.
   *
   * Extracted from {@link runJob} to keep that method within the line-count
   * lint budget while retaining readable control flow.
   * @param job - Running job descriptor
   * @param artifact - Normalized install artifact returned by the strategy
   * @param metadata - Optional post-install handler metadata
   * @param onProgress - Progress callback (best-effort via {@link safeOnProgress})
   * @param onComplete - Persistence callback invoked before event emission
   * @param onCompleted - Bus event emission callback
   */
  private async finalizeSuccess(
    job: InstallJob,
    artifact: InstallArtifact,
    metadata: Record<string, unknown> | undefined,
    onProgress: JobProgressCallback,
    onComplete: JobCompletionCallback,
    onCompleted: JobCompletedCallback,
  ): Promise<void> {
    if (job.makeActive) {
      if (
        !this.emitProgressIfActive(onProgress, {
          jobId: job.jobId,
          clientId: job.clientId,
          version: artifact.version,
          strategy: job.strategy,
          stage: 'activating',
          progress: null,
          installPath: artifact.installPath,
          activeAfterCompletion: true,
        })
      ) {
        return;
      }
    }

    if (this.#cancelled) return;

    try {
      await onComplete({
        jobId: job.jobId,
        clientId: job.clientId,
        version: artifact.version,
        installPath: artifact.installPath,
        makeActive: job.makeActive,
        reason: job.reason,
      });
    } catch (error) {
      try {
        await this.strategyDeps.removeDirectory(artifact.installPath);
      } catch {
        // Preserve the persistence error that made the install invalid.
      }
      throw error;
    }

    if (this.#cancelled) return;

    // Event emission failure must not rewrite the terminal job outcome: the
    // binary is already installed, so swallow any error from onCompleted here.
    try {
      await onCompleted({
        jobId: job.jobId,
        clientId: job.clientId,
        version: artifact.version,
        strategy: job.strategy,
        status: 'success',
        installPath: artifact.installPath,
        activeVersion: job.makeActive ? artifact.version : null,
        ...(metadata === undefined ? {} : { metadata: { postInstall: metadata } }),
      });
    } catch {
      // Swallow: install succeeded; only the completion event emission failed.
    }
  }

  /**
   * Best-effort cleanup for an artifact that passed strategy execution but failed
   * before it could be persisted as an installed version.
   * @param installPath - Absolute staged install directory to remove
   */
  private async cleanupStagedArtifact(installPath: string): Promise<void> {
    try {
      await this.strategyDeps.removeDirectory(installPath);
    } catch {
      // Preserve the post-install or verification error that made the install invalid.
    }
  }

  /**
   * Run the optional declarative post-install hook through a framework-owned
   * handler registered on the manager config.
   * @param job - Running job descriptor
   * @param installPath - Absolute installed binary directory
   * @param postInstall - Declarative post-install descriptor, if any
   * @param onProgress - Progress callback used to emit `post-install`
   * @returns Optional handler metadata
   */
  private async runPostInstall(
    job: InstallJob,
    installPath: string,
    postInstall: PostInstallDescriptor | undefined,
    onProgress: JobProgressCallback,
  ): Promise<Record<string, unknown> | undefined> {
    if (postInstall === undefined) {
      return undefined;
    }

    const handler = this.resolvePostInstallHandler(postInstall);
    const basePayload = this.buildProgressPayload(job, 'post-install', null, installPath, {
      kind: postInstall.kind,
    });
    if (!this.emitProgressIfActive(onProgress, basePayload)) return undefined;

    const metadata = await handler({
      clientId: job.clientId,
      version: job.version,
      installPath,
      descriptor: postInstall,
    });

    this.emitProgressIfActive(
      onProgress,
      this.buildProgressPayload(job, 'post-install', 100, installPath, {
        kind: postInstall.kind,
        ...(metadata ?? {}),
      }),
    );

    return metadata ?? undefined;
  }

  /**
   * Emit a `verifying` progress event and invoke {@link verifyInstalledVersion}.
   *
   * Emits a `verifying` progress event with `metadata.kind: 'version-command'`
   * before executing the command so that callers can display real-time feedback.
   * The verification runs synchronously after the event is emitted.
   * @param job - Running job descriptor
   * @param installPath - Absolute installed binary directory
   * @param versionCommand - Command and args declared on the client definition
   * @param onProgress - Progress callback for the verifying stage
   * @throws When path validation fails or the binary reports an unexpected version
   */
  private async runVersionVerification(
    job: InstallJob,
    installPath: string,
    versionCommand: readonly [string, ...string[]],
    onProgress: JobProgressCallback,
  ): Promise<void> {
    if (
      !this.emitProgressIfActive(
        onProgress,
        this.buildProgressPayload(job, 'verifying', null, installPath, { kind: 'version-command' }),
      )
    ) {
      return;
    }

    if (this.#cancelled) return;

    await verifyInstalledVersion(this.strategyDeps.exec, installPath, versionCommand, job.version);
  }

  /**
   * Resolve a post-install handler by descriptor kind.
   * @param postInstall - Declarative post-install descriptor
   * @returns Registered handler for the descriptor kind
   * @throws When no handler is registered for the descriptor kind
   */
  private resolvePostInstallHandler(postInstall: PostInstallDescriptor): PostInstallHandler {
    const handler = this.config.postInstallHandlers?.get(postInstall.kind);
    if (handler === undefined) {
      throw new Error(`No post-install handler registered for kind "${postInstall.kind}"`);
    }
    return handler;
  }

  /**
   * Build a progress payload for runner-owned stages.
   * @param job - Running job descriptor
   * @param stage - Install stage to report
   * @param progress - Stage progress value
   * @param installPath - Absolute installed binary directory
   * @param metadata - Optional event metadata
   * @returns Install progress payload
   */
  private buildProgressPayload(
    job: InstallJob,
    stage: InstallStage,
    progress: number | null,
    installPath: string,
    metadata?: Record<string, unknown>,
  ): ClientInstallProgress {
    return {
      jobId: job.jobId,
      clientId: job.clientId,
      version: job.version,
      strategy: job.strategy,
      stage,
      progress,
      installPath,
      activeAfterCompletion: job.makeActive,
      ...(metadata === undefined ? {} : { metadata }),
    };
  }

  /**
   * Resolve the absolute install directory for a specific client version.
   *
   * The convention is `{basePath}/{clientId}/{version}/`. Both `clientId` and
   * `version` are resolved against the base path and validated to prevent path
   * traversal sequences (e.g. `..`) from escaping the install root.
   * @param clientId - Stable client identifier
   * @param version - Resolved version string
   * @returns Absolute target directory path
   * @throws When the resolved path would escape `basePath`
   */
  private resolveTargetDir(clientId: string, version: string): string {
    const target = path.resolve(this.resolvedBasePath, clientId, version);
    if (!isPathWithinBase(this.resolvedBasePath, target)) {
      throw new Error(`Invalid install target path for client "${clientId}" and version "${version}"`);
    }
    return target;
  }
}
