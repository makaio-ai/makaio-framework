/**
 * Codex session config lease handler.
 *
 * Materializes file/keyring native auth into an isolated CODEX_HOME and
 * reconciles refreshes on teardown with a generation-checked write-back.
 * `empty` inheritance never reads or clones canonical native credentials.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  SessionConfigSetupRequest,
  SessionConfigSetupResponse,
  SessionConfigTeardownRequest,
  SessionConfigTeardownResponse,
} from '@makaio/contracts/client';
import { handleCodexConfigPrime } from './config-prime-handler.js';
import {
  CodexNativeAuthStore,
  digestCodexCredential,
  identifyCodexAuthHome,
  identifyCodexAuthHomeLexically,
  inspectCodexLeaseTarget,
  type CodexAuthHomeIdentity,
  type CodexAuthLeaseMetadata,
  type CodexAuthLeaseMetadataRead,
  type CodexAuthStoreMode,
  type CodexLeaseTargetInspection,
} from './native-auth-store.js';

/** Teardown inputs collected before native-auth write-back begins. */
interface CodexLeaseTeardownInspection {
  /** Strict metadata state read from the verified lease directory. */
  readonly metadataRead: CodexAuthLeaseMetadataRead;
  /** Sanitized failure observed while inspecting the target or metadata. */
  readonly operationError: unknown;
  /** Current target identity and safety state. */
  readonly targetInspection: CodexLeaseTargetInspection;
}

/**
 * Codex-owned setup and teardown component for isolated config leases.
 */
export class CodexSessionConfigHandler {
  /** Runtime copy of metadata used when a lease directory disappeared early. */
  private readonly activeMetadata = new Map<string, CodexAuthLeaseMetadata>();

  /**
   * @param authStore - Native file/keyring storage implementation.
   * @param nativeConfigDir - Native CODEX_HOME used when no profile source exists.
   */
  public constructor(
    private readonly authStore: CodexNativeAuthStore = new CodexNativeAuthStore(),
    private readonly nativeConfigDir: string = path.join(os.homedir(), '.codex'),
  ) {}

  /**
   * Seed an isolated CODEX_HOME according to the requested inheritance policy.
   * @param payload - Validated setup delegation payload.
   * @returns Process environment and truthful native-auth materialization status.
   */
  public async setup(payload: SessionConfigSetupRequest): Promise<SessionConfigSetupResponse> {
    const { sessionDir, configInheritance, projectDir } = payload;
    await fs.mkdir(sessionDir, { recursive: true });

    const targetInspection = await inspectCodexLeaseTarget(sessionDir);
    if (targetInspection.status !== 'safe') {
      throw new Error('Codex native-auth lease target must be a stable directory');
    }
    const targetIdentity = targetInspection.identity;
    const sourceConfigDir = this.resolveSourceConfigDir(payload);
    const sourceIdentity = configInheritance === 'empty' ? undefined : await identifyCodexAuthHome(sourceConfigDir);
    if (sourceIdentity !== undefined && identitiesEqual(sourceIdentity, targetIdentity)) {
      throw new Error('Codex native-auth source and lease target must be different directories');
    }
    const emptyMetadata = createEmptyMetadata(targetIdentity);
    await this.recordMetadata(sessionDir, emptyMetadata);

    try {
      let authMaterialized = false;
      let mode: CodexAuthStoreMode | undefined;
      if (sourceIdentity !== undefined) {
        const result = await this.authStore.withSourceLock(sourceIdentity, async () => {
          await this.materializeGeneralConfig(sourceIdentity.canonicalPath, sessionDir, configInheritance);
          return this.materializeNativeAuthLocked(sourceIdentity, targetIdentity, sessionDir);
        });
        authMaterialized = result.materialized;
        mode = result.mode;
      } else {
        await this.materializeGeneralConfig(sourceConfigDir, sessionDir, configInheritance);
        await this.authStore.deleteFile(targetIdentity);
      }

      if (configInheritance === 'auth-only' && mode !== undefined) {
        await fs.writeFile(path.join(sessionDir, 'config.toml'), `cli_auth_credentials_store = "${mode}"\n`, {
          mode: 0o600,
        });
      }

      await handleCodexConfigPrime({
        clientId: 'codex',
        configDir: sessionDir,
        phase: 'session-create',
        ...(projectDir !== undefined ? { projectDir } : {}),
      });

      return { env: { CODEX_HOME: sessionDir }, authMaterialized };
    } catch (error) {
      await this.rollbackFailedSetup(sessionDir).catch((cleanupError: unknown) => {
        throw new AggregateError([error, cleanupError], 'Codex session config setup and cleanup both failed');
      });
      throw error;
    }
  }

  /**
   * Compare-and-swap refreshed native auth back to its canonical store, then
   * remove the session-specific keyring entry.
   * @param payload - Validated teardown delegation payload.
   * @returns Successful client-owned teardown result.
   */
  public async teardown(payload: SessionConfigTeardownRequest): Promise<SessionConfigTeardownResponse> {
    const leaseKey = path.resolve(payload.sessionDir);
    const activeMetadata = this.activeMetadata.get(leaseKey);
    const inspection = await this.inspectLeaseForTeardown(payload.sessionDir);
    const inspectedIdentity =
      inspection.targetInspection.status === 'safe'
        ? inspection.targetInspection.identity
        : inspection.targetInspection.fallbackIdentity;
    const cleanupIdentity = activeMetadata?.targetIdentity ?? inspectedIdentity;
    let operationError = inspection.operationError;

    if (operationError === undefined) {
      try {
        await this.reconcileInspectedLease(payload.sessionDir, inspection, activeMetadata);
      } catch (error) {
        operationError = error;
      }
    }

    try {
      for (const cleanupError of await this.collectTargetCleanupErrors(payload.sessionDir, cleanupIdentity)) {
        operationError = mergeOperationErrors(
          operationError,
          cleanupError,
          'Codex native-auth write-back and target cleanup both failed',
        );
      }
    } finally {
      this.activeMetadata.delete(leaseKey);
    }

    if (operationError !== undefined) throw operationError;
    return { success: true };
  }

  /**
   * Inspect the lease target and its metadata without starting write-back.
   * @param sessionDir - Original isolated CODEX_HOME path.
   * @returns Target state, metadata state, and any sanitized inspection failure.
   */
  private async inspectLeaseForTeardown(sessionDir: string): Promise<CodexLeaseTeardownInspection> {
    let operationError: unknown;
    let targetInspection: CodexLeaseTargetInspection;
    try {
      targetInspection = await inspectCodexLeaseTarget(sessionDir);
    } catch (error) {
      operationError = error;
      targetInspection = { status: 'missing', fallbackIdentity: identifyCodexAuthHomeLexically(sessionDir) };
    }

    let metadataRead: CodexAuthLeaseMetadataRead = { status: 'missing' };
    if (targetInspection.status === 'safe') {
      try {
        metadataRead = await this.authStore.readLeaseMetadata(sessionDir);
      } catch (error) {
        operationError = mergeOperationErrors(
          operationError,
          error,
          'Codex native-auth lease inspection encountered multiple failures',
        );
      }
    } else if (targetInspection.status === 'unsafe') {
      operationError = mergeOperationErrors(
        operationError,
        new Error('Codex native-auth lease target is unsafe; write-back was skipped'),
        'Codex native-auth lease inspection encountered multiple failures',
      );
    }
    return { metadataRead, operationError, targetInspection };
  }

  /**
   * Validate one inspected lease generation and reconcile a refreshed target.
   * @param sessionDir - Original isolated CODEX_HOME path.
   * @param inspection - Verified target and metadata inspection result.
   * @param activeMetadata - In-memory setup generation, when this process created the lease.
   */
  private async reconcileInspectedLease(
    sessionDir: string,
    inspection: CodexLeaseTeardownInspection,
    activeMetadata: CodexAuthLeaseMetadata | undefined,
  ): Promise<void> {
    if (inspection.metadataRead.status === 'invalid') {
      throw new Error('Codex native-auth lease metadata is invalid; write-back was skipped');
    }
    if (inspection.metadataRead.status === 'found') {
      const inspectedIdentity =
        inspection.targetInspection.status === 'safe'
          ? inspection.targetInspection.identity
          : inspection.targetInspection.fallbackIdentity;
      const expectedTargetIdentity = activeMetadata?.targetIdentity ?? inspectedIdentity;
      const diskMetadata = inspection.metadataRead.metadata;
      if (!identitiesEqual(diskMetadata.targetIdentity, expectedTargetIdentity)) {
        throw new Error('Codex native-auth lease target identity is invalid; write-back was skipped');
      }
      if (activeMetadata !== undefined && !metadataEqual(diskMetadata, activeMetadata)) {
        throw new Error('Codex native-auth lease generation metadata changed; write-back was skipped');
      }
      const currentTarget = await inspectCodexLeaseTarget(sessionDir);
      if (currentTarget.status !== 'safe' || !identitiesEqual(currentTarget.identity, expectedTargetIdentity)) {
        throw new Error('Codex native-auth lease target changed during teardown; write-back was skipped');
      }
      await this.reconcileRefresh(diskMetadata);
    } else if (activeMetadata?.backend.effective !== undefined && activeMetadata.backend.effective !== 'none') {
      throw new Error('Codex native-auth lease metadata is missing; write-back was skipped');
    }
  }

  /**
   * Resolve profile source or the native CODEX_HOME fallback.
   * @param payload - Setup payload carrying source and target paths.
   * @returns Canonical source candidate selected for this lease.
   */
  private resolveSourceConfigDir(payload: SessionConfigSetupRequest): string {
    return path.resolve(payload.sessionDir) === path.resolve(payload.baseConfigDir)
      ? this.nativeConfigDir
      : payload.baseConfigDir;
  }

  /**
   * Materialize general config independently from native authentication.
   * @param sourceConfigDir - Resolved source CODEX_HOME.
   * @param sessionDir - Isolated target CODEX_HOME.
   * @param inheritance - Requested config inheritance policy.
   */
  private async materializeGeneralConfig(
    sourceConfigDir: string,
    sessionDir: string,
    inheritance: SessionConfigSetupRequest['configInheritance'],
  ): Promise<void> {
    const target = path.join(sessionDir, 'config.toml');
    await fs.rm(target, { force: true });
    if (inheritance !== 'full') return;
    try {
      await fs.copyFile(path.join(sourceConfigDir, 'config.toml'), target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /**
   * Resolve and clone native auth while the caller owns the canonical source lock.
   * @param canonicalIdentity - Canonical auth source pinned during setup.
   * @param targetIdentity - Isolated target store identity.
   * @param sessionDir - Isolated target CODEX_HOME.
   * @returns Materialization status and configured storage mode.
   */
  private async materializeNativeAuthLocked(
    canonicalIdentity: CodexAuthHomeIdentity,
    targetIdentity: CodexAuthHomeIdentity,
    sessionDir: string,
  ): Promise<{ readonly materialized: boolean; readonly mode: CodexAuthStoreMode }> {
    const mode = await this.authStore.resolveMode(canonicalIdentity);
    const sourceRead = await this.authStore.readEffective(canonicalIdentity, mode);
    const sourceCredential = sourceRead.credential;

    if (sourceCredential === null) {
      await this.authStore.deleteFile(targetIdentity);
      if (mode === 'keyring' || (mode === 'auto' && !sourceRead.keyringUnavailable)) {
        await this.authStore.deleteKeyring(targetIdentity);
      }
      await this.recordMetadata(sessionDir, {
        version: 1,
        backend: { configured: mode, effective: 'none' },
        canonicalIdentity,
        targetIdentity,
        sourceGenerationDigest: null,
        initialTargetDigest: null,
      });
      return { materialized: false, mode };
    }

    const digest = digestCodexCredential(sourceCredential.value);
    const metadata: CodexAuthLeaseMetadata = {
      version: 1,
      backend: { configured: mode, effective: sourceCredential.backend },
      canonicalIdentity,
      targetIdentity,
      sourceGenerationDigest: digest,
      initialTargetDigest: digest,
    };
    await this.recordMetadata(sessionDir, metadata);

    if (sourceCredential.backend === 'file' && mode === 'auto' && !sourceRead.keyringUnavailable) {
      await this.authStore.deleteKeyring(targetIdentity);
    }
    await this.authStore.writeBackend(targetIdentity, sourceCredential.backend, sourceCredential.value);
    const targetValue = await this.authStore.readBackend(targetIdentity, sourceCredential.backend);
    if (targetValue === null || digestCodexCredential(targetValue) !== digest) {
      throw new Error('Codex native-auth target generation verification failed');
    }
    return { materialized: true, mode };
  }

  /**
   * Atomically record metadata on disk and retain it for missing-directory teardown.
   * @param sessionDir - Isolated target CODEX_HOME.
   * @param metadata - Secret-free lease generation metadata.
   */
  private async recordMetadata(sessionDir: string, metadata: CodexAuthLeaseMetadata): Promise<void> {
    await this.authStore.writeLeaseMetadata(sessionDir, metadata);
    this.activeMetadata.set(path.resolve(sessionDir), metadata);
  }

  /**
   * Remove only resources materialized before a setup failure.
   * @param sessionDir - Isolated target CODEX_HOME.
   */
  private async rollbackFailedSetup(sessionDir: string): Promise<void> {
    const leaseKey = path.resolve(sessionDir);
    const metadata = this.activeMetadata.get(leaseKey);
    if (metadata === undefined) return;
    try {
      const cleanupErrors = await this.collectTargetCleanupErrors(sessionDir, metadata.targetIdentity);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Codex native-auth setup rollback failed');
      }
    } finally {
      this.activeMetadata.delete(leaseKey);
    }
  }

  /**
   * Attempt keyring cleanup unconditionally and file cleanup only for the
   * still-verified lease directory.
   * @param sessionDir - Original isolated CODEX_HOME path.
   * @param trustedIdentity - Target identity captured before materialization.
   * @returns Every sanitized inspection or cleanup failure.
   */
  private async collectTargetCleanupErrors(
    sessionDir: string,
    trustedIdentity: CodexAuthHomeIdentity,
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    let inspection: CodexLeaseTargetInspection | undefined;
    try {
      inspection = await inspectCodexLeaseTarget(sessionDir);
    } catch (error) {
      errors.push(error);
    }

    const cleanupOperations: Array<() => Promise<void>> = [() => this.authStore.deleteKeyring(trustedIdentity)];
    if (inspection?.status === 'safe' && identitiesEqual(inspection.identity, trustedIdentity)) {
      cleanupOperations.push(() => this.authStore.deleteFile(trustedIdentity));
    } else if (
      inspection?.status === 'unsafe' ||
      (inspection?.status === 'safe' && !identitiesEqual(inspection.identity, trustedIdentity))
    ) {
      errors.push(new Error('Codex native-auth lease target became unsafe; file cleanup was skipped'));
    }

    const cleanupResults = await Promise.allSettled(cleanupOperations.map(async (operation) => operation()));
    errors.push(...cleanupResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])));
    return errors;
  }

  /**
   * Reconcile one changed target under the canonical source's cross-process lock.
   * @param metadata - Validated on-disk lease generation.
   */
  private async reconcileRefresh(metadata: CodexAuthLeaseMetadata): Promise<void> {
    const canonicalIdentity = metadata.canonicalIdentity;
    const mode = metadata.backend.configured;
    const sourceGenerationDigest = metadata.sourceGenerationDigest;
    const initialTargetDigest = metadata.initialTargetDigest;
    if (
      mode === 'none' ||
      metadata.backend.effective === 'none' ||
      canonicalIdentity === null ||
      sourceGenerationDigest === null ||
      initialTargetDigest === null
    ) {
      return;
    }

    const targetRead = await this.authStore.readRefreshCandidate(metadata.targetIdentity, mode, initialTargetDigest);
    const targetCredential = targetRead.credential;
    if (targetCredential === null) return;
    if (digestCodexCredential(targetCredential.value) === initialTargetDigest) {
      return;
    }

    await this.authStore.withSourceLock(canonicalIdentity, async () => {
      const currentMode = await this.authStore.resolveMode(canonicalIdentity);
      if (currentMode !== mode) return;
      const canonicalRead = await this.authStore.readEffective(canonicalIdentity, currentMode);
      const canonicalCredential = canonicalRead.credential;
      const generationStillMatches =
        canonicalCredential !== null &&
        canonicalCredential.backend === metadata.backend.effective &&
        digestCodexCredential(canonicalCredential.value) === sourceGenerationDigest;
      if (generationStillMatches) {
        await this.authStore.saveConfigured(canonicalIdentity, mode, targetCredential.value);
      }
    });
  }
}

/**
 * Compare canonical identities without trusting metadata aliases.
 * @param left - First canonical identity.
 * @param right - Second canonical identity.
 * @returns Whether path and derived keyring account both match.
 */
function identitiesEqual(left: CodexAuthHomeIdentity, right: CodexAuthHomeIdentity): boolean {
  return left.canonicalPath === right.canonicalPath && left.keyringAccount === right.keyringAccount;
}

/**
 * Compare the complete trusted lease generation with its on-disk marker.
 * @param left - First strict metadata generation.
 * @param right - Second strict metadata generation.
 * @returns Whether every source, target, backend, and digest field matches.
 */
function metadataEqual(left: CodexAuthLeaseMetadata, right: CodexAuthLeaseMetadata): boolean {
  return (
    left.version === right.version &&
    left.backend.configured === right.backend.configured &&
    left.backend.effective === right.backend.effective &&
    ((left.canonicalIdentity === null && right.canonicalIdentity === null) ||
      (left.canonicalIdentity !== null &&
        right.canonicalIdentity !== null &&
        identitiesEqual(left.canonicalIdentity, right.canonicalIdentity))) &&
    identitiesEqual(left.targetIdentity, right.targetIdentity) &&
    left.sourceGenerationDigest === right.sourceGenerationDigest &&
    left.initialTargetDigest === right.initialTargetDigest
  );
}

/**
 * Create the explicit no-auth marker written before setup begins.
 * @param targetIdentity - Isolated target CODEX_HOME identity.
 * @returns Initial secret-free lease metadata.
 */
function createEmptyMetadata(targetIdentity: CodexAuthHomeIdentity): CodexAuthLeaseMetadata {
  return {
    version: 1,
    backend: { configured: 'none', effective: 'none' },
    canonicalIdentity: null,
    targetIdentity,
    sourceGenerationDigest: null,
    initialTargetDigest: null,
  };
}

/**
 * Preserve every failure observed across write-back and mandatory cleanup.
 * @param existing - Earlier failure, when present.
 * @param next - Newly observed failure.
 * @param message - Safe aggregate description.
 * @returns The single failure or an aggregate retaining both.
 */
function mergeOperationErrors(existing: unknown, next: unknown, message: string): unknown {
  return existing === undefined ? next : new AggregateError([existing, next], message);
}
