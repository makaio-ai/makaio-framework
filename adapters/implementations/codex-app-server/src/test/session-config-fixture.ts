import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import { CodexClientSessionService, CodexClientSubjects } from '@makaio/client-codex/runtime';
import { ClientSubjects } from '@makaio/contracts/client';

/** Reference-counted real Codex client config fixture for conformance workers. */
export interface CodexConformanceSessionConfigFixture {
  /** Release this config's fixture reference after its connector runtimes close. */
  release(): Promise<void>;
}

interface FixtureState {
  readonly root: string;
  readonly service: CodexClientSessionService;
  readonly unsubscribeCreate: () => void;
  readonly unsubscribeDestroy: () => void;
  references: number;
}

let state: FixtureState | undefined;
let transition = Promise.resolve();

/**
 * Throw every fixture cleanup failure without letting a later stage hide an earlier one.
 * @param failures - Cleanup failures in lifecycle order
 * @param message - Stable aggregate diagnostic
 */
function throwFixtureCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, message, { cause: failures[0] });
  }
}

/**
 * Serialize acquisition and final release across configs in one worker.
 * @param operation - Fixture state transition to run exclusively
 * @returns Result of the serialized transition
 */
async function withLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = transition;
  let unlock: () => void = () => undefined;
  transition = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
  }
}

/**
 * Resolve the host platform accepted by Codex session-config delegation.
 * @returns Supported Codex session-config platform
 */
function resolvePlatform(): 'darwin' | 'linux' | 'win32' {
  const platform = os.platform();
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform;
  throw new Error(`Codex conformance session config does not support platform '${platform}'.`);
}

/**
 * Roll back every resource acquired before fixture startup completed.
 * @param root - Temporary fixture root to remove
 * @param service - Partially or fully initialized Codex session service
 * @param unsubscribeCreate - Optional create-handler cleanup acquired before failure
 * @param cause - Primary startup failure to preserve
 * @returns Never; rethrows the primary failure or a cleanup aggregate
 */
async function rollbackFixtureStartup(
  root: string,
  service: CodexClientSessionService,
  unsubscribeCreate: (() => void) | undefined,
  cause: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  if (unsubscribeCreate !== undefined) {
    try {
      unsubscribeCreate();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await service.destroy();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([cause, ...cleanupErrors], 'Codex conformance fixture startup rollback failed.', {
      cause,
    });
  }
  throw cause;
}

/**
 * Start the real Codex client handler behind temp-backed global lease subjects.
 * @returns Initialized, unsubscribable fixture state
 */
async function createState(): Promise<FixtureState> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-codex-conformance-config-'));
  const service = new CodexClientSessionService(MakaioBus);
  let unsubscribeCreate: (() => void) | undefined;
  try {
    await service.init();

    unsubscribeCreate = MakaioBus.on(
      ClientSubjects.sessionConfig.create,
      async (ctx) => {
        const sessionDir = path.join(root, ctx.payload.clientId, 'sessions', ctx.payload.leaseId);
        await fs.mkdir(sessionDir, { recursive: true });
        try {
          const setup = await MakaioBus.request(CodexClientSubjects.sessionConfig.setup, {
            sessionDir,
            baseConfigDir: ctx.payload.baseConfigDir ?? sessionDir,
            projectDir: ctx.payload.projectDir,
            platform: resolvePlatform(),
            configInheritance: ctx.payload.configInheritance ?? 'auth-only',
          });
          ctx.setResult({
            sessionDir,
            env: setup.env ?? {},
            authMaterialized: setup.authMaterialized,
          });
        } catch (error) {
          try {
            await fs.rm(sessionDir, { recursive: true, force: true });
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Codex conformance lease setup and directory rollback both failed.',
              { cause: error },
            );
          }
          throw error;
        }
      },
      { filter: { clientId: 'codex' } },
    );
    const unsubscribeDestroy = MakaioBus.on(
      ClientSubjects.sessionConfig.destroy,
      async (ctx) => {
        const sessionDir = path.join(root, ctx.payload.clientId, 'sessions', ctx.payload.leaseId);
        const failures: unknown[] = [];
        try {
          const result = await MakaioBus.request(CodexClientSubjects.sessionConfig.destroy, {
            sessionDir,
            platform: resolvePlatform(),
          });
          ctx.setResult(result);
        } catch (error) {
          failures.push(error);
        }
        try {
          await fs.rm(sessionDir, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
        throwFixtureCleanupFailures(failures, 'Codex conformance lease teardown encountered multiple failures.');
      },
      { filter: { clientId: 'codex' } },
    );
    return { root, service, unsubscribeCreate, unsubscribeDestroy, references: 0 };
  } catch (error) {
    return rollbackFixtureStartup(root, service, unsubscribeCreate, error);
  }
}

/**
 * Acquire the real worker-local Codex session-config fixture.
 * @returns Idempotently releasable fixture reference
 */
export async function acquireCodexConformanceSessionConfigFixture(): Promise<CodexConformanceSessionConfigFixture> {
  return withLock(async () => {
    state ??= await createState();
    const acquired = state;
    acquired.references += 1;
    let released = false;

    return {
      release: () =>
        withLock(async () => {
          if (released) return;
          released = true;
          acquired.references -= 1;
          if (acquired.references > 0 || state !== acquired) return;

          state = undefined;
          const failures: unknown[] = [];
          const unsubscribeResults = await Promise.allSettled([
            Promise.resolve().then(acquired.unsubscribeCreate),
            Promise.resolve().then(acquired.unsubscribeDestroy),
          ]);
          failures.push(
            ...unsubscribeResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
          );
          try {
            await acquired.service.destroy();
          } catch (error) {
            failures.push(error);
          }
          try {
            await fs.rm(acquired.root, { recursive: true, force: true });
          } catch (error) {
            failures.push(error);
          }
          throwFixtureCleanupFailures(failures, 'Codex conformance fixture cleanup encountered multiple failures.');
        }),
    };
  });
}

/**
 * Close connector runtimes first and preserve a simultaneous fixture-release failure.
 * @param closeRuntimes - Central runtime cleanup that releases connector auth leases
 * @param fixture - Session-config fixture reference to release after runtimes close
 */
export async function closeCodexConformanceResources(
  closeRuntimes: () => Promise<void>,
  fixture: CodexConformanceSessionConfigFixture,
): Promise<void> {
  let closeError: unknown;
  try {
    await closeRuntimes();
  } catch (error) {
    closeError = error;
  }
  let releaseError: unknown;
  try {
    await fixture.release();
  } catch (error) {
    releaseError = error;
  }
  if (closeError !== undefined && releaseError !== undefined) {
    throw new AggregateError([closeError, releaseError], 'Codex conformance runtime and fixture cleanup failed.', {
      cause: closeError,
    });
  }
  if (closeError !== undefined) throw closeError;
  if (releaseError !== undefined) throw releaseError;
}
