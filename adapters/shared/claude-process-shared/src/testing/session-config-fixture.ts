import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import {
  clearClaudeCodeNativeCredentialsForSession,
  handleClaudeCodeSessionConfigSetup,
} from '@makaio/client-claude-code/runtime';

/** Acquired reference to the worker-local real Claude session-config fixture. */
export interface ClaudeConformanceSessionConfigFixture {
  /** Release this config's fixture reference after all connector leases close. */
  release(): Promise<void>;
}

/**
 * Close all connector runtimes before releasing their shared config fixture.
 * @param closeConnectors - Idempotent connector-runtime registry cleanup
 * @param fixture - Acquired Claude session-config fixture reference
 * @throws The primary close failure, release failure, or both as AggregateError
 */
export async function closeClaudeConformanceConnectorRuntimes(
  closeConnectors: () => Promise<void>,
  fixture: ClaudeConformanceSessionConfigFixture,
): Promise<void> {
  let closeError: unknown;
  try {
    await closeConnectors();
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
    throw new AggregateError(
      [closeError, releaseError],
      'Claude conformance connector close and session config release both failed.',
      { cause: closeError },
    );
  }
  if (closeError !== undefined) {
    throw closeError;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
}

/** Shared bus handlers and temp root for one test worker. */
interface SessionConfigFixtureState {
  readonly root: string;
  readonly unsubscribeCreate: () => void;
  readonly unsubscribeDestroy: () => void;
  references: number;
}

let fixtureState: SessionConfigFixtureState | undefined;
let fixtureTransition = Promise.resolve();

/**
 * Throw one cleanup failure directly or retain every failure in lifecycle order.
 * @param failures - Cleanup failures in lifecycle order
 * @param message - Aggregate failure message
 */
function throwFixtureCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, message, { cause: failures[0] });
  }
}

/**
 * Serialize fixture acquisition and final cleanup without leaking a rejected lock.
 * @param operation - Fixture transition to execute exclusively
 * @returns Result of the serialized fixture transition
 */
async function withFixtureLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = fixtureTransition;
  let unlock: () => void = () => undefined;
  fixtureTransition = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
  }
}

/** Resolve the current platform to the client session-config contract. */
function resolvePlatform(): 'darwin' | 'linux' | 'win32' {
  const platform = os.platform();
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  throw new Error(`Claude conformance session config does not support platform '${platform}'.`);
}

/** Create the real temp-backed Claude client session-config handlers. */
async function createFixtureState(): Promise<SessionConfigFixtureState> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-claude-conformance-config-'));
  let unsubscribeCreate: (() => void) | undefined;
  try {
    unsubscribeCreate = MakaioBus.on(
      ClientSubjects.sessionConfig.create,
      async (ctx) => {
        const sessionDir = path.join(root, ctx.payload.clientId, 'sessions', ctx.payload.leaseId);
        try {
          await fs.mkdir(sessionDir, { recursive: true });
          const setup = await handleClaudeCodeSessionConfigSetup(
            {
              sessionDir,
              baseConfigDir: ctx.payload.baseConfigDir ?? sessionDir,
              projectDir: ctx.payload.projectDir,
              platform: resolvePlatform(),
              configInheritance: ctx.payload.configInheritance ?? 'auth-only',
            },
            {
              // Transcripts must outlive individual leases so native
              // resume/fork works across connector generations, but they must
              // not land in the operator's real config home — the fixture
              // root gives them a suite-scoped durable store instead.
              projectsStoreDir: path.join(root, 'projects-store'),
            },
          );
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
              'Claude conformance lease setup and directory rollback both failed.',
              { cause: error },
            );
          }
          throw error;
        }
      },
      { filter: { clientId: 'claude-code' } },
    );
    const unsubscribeDestroy = MakaioBus.on(
      ClientSubjects.sessionConfig.destroy,
      async (ctx) => {
        const sessionDir = path.join(root, ctx.payload.clientId, 'sessions', ctx.payload.leaseId);
        const failures: unknown[] = [];
        try {
          await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: resolvePlatform() });
        } catch (error) {
          failures.push(error);
        }
        try {
          await fs.rm(sessionDir, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
        throwFixtureCleanupFailures(failures, 'Claude conformance lease teardown encountered multiple failures.');
        ctx.setResult({ success: true });
      },
      { filter: { clientId: 'claude-code' } },
    );
    return { root, unsubscribeCreate, unsubscribeDestroy, references: 0 };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      unsubscribeCreate?.();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Claude conformance fixture startup rollback failed.', { cause: error });
    }
    throw error;
  }
}

/**
 * Acquire worker-local real Claude client session-config handling.
 *
 * All three Claude conformance adapters share this fixture. The last release
 * removes the handlers and temp root; callers must close their connector
 * runtime registry before releasing it.
 * @returns Idempotent fixture reference
 */
export async function acquireClaudeConformanceSessionConfigFixture(): Promise<ClaudeConformanceSessionConfigFixture> {
  return withFixtureLock(async () => {
    fixtureState ??= await createFixtureState();
    const acquiredState = fixtureState;
    acquiredState.references += 1;
    let released = false;

    return {
      release: () =>
        withFixtureLock(async () => {
          if (released) {
            return;
          }
          released = true;
          acquiredState.references -= 1;
          if (acquiredState.references > 0 || fixtureState !== acquiredState) {
            return;
          }

          fixtureState = undefined;
          const failures: unknown[] = [];
          const unsubscribeResults = await Promise.allSettled([
            Promise.resolve().then(acquiredState.unsubscribeCreate),
            Promise.resolve().then(acquiredState.unsubscribeDestroy),
          ]);
          failures.push(
            ...unsubscribeResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
          );
          try {
            await fs.rm(acquiredState.root, { recursive: true, force: true });
          } catch (error) {
            failures.push(error);
          }
          throwFixtureCleanupFailures(failures, 'Claude conformance fixture cleanup encountered multiple failures.');
        }),
    };
  });
}
