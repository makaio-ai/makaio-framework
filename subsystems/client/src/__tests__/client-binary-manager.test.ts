/**
 * Tests for {@link ClientBinaryManager}.
 *
 * Uses a real bus instance with real Drizzle storage handlers registered
 * against an in-memory SQLite database. Strategy I/O dependencies are mocked
 * so no real network or filesystem operations occur. The full request → job →
 * event → storage pipeline is exercised.
 *
 * Coverage:
 * - Async install job creation (returns jobId before job completes)
 * - `client.install` without explicit version uses the descriptor pin
 * - `client.install` rejects explicit versions that differ from the descriptor pin
 * - `client.update` installs the descriptor pin and makes it active
 * - `client.update` does not contact an upstream feed
 * - `client.setActive` switches only among installed versions
 * - Uninstalling the active version leaves no active version
 * - `client.installJob.progress`, `client.installJob.completed`, and
 *   `client.version.changed` events emit with correct payloads
 * - `client.list` returns `pinnedVersion` and `updateAvailable` from the descriptor
 * - `updateAvailable` is `true` when active version differs from the pin
 * - Concurrent install+update and install+uninstall are rejected
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects, createClientDefinition } from '@makaio/contracts/client';
import type {
  ClientConfigPrimeRequest,
  ClientInstallCompleted,
  ClientInstallProgress,
  ClientVersionChanged,
} from '@makaio/contracts/client';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { createPluginTestDb, type PluginTestDbContext } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { registerDrizzleClientBinaryStorage } from '../storage/client-binary-drizzle-handler.js';
import { ClientBinaryManager } from '../client-binary-manager.js';
import { isPathWithinBase, type ClientDefinitionLookup } from '../client-binary-manager-types.js';
import type { StrategyDependencies } from '../binary-strategies/index.js';
import { ClientBinaryStorageSubjects } from '../storage/client-binary-storage-namespace.js';
import { CLIENT_BINARY_DDL } from './test-ddl.js';

// ---------------------------------------------------------------------------
// Test client definition
// ---------------------------------------------------------------------------

/**
 * Pinned version used in the default npm descriptor. The npm strategy uses
 * `exec` for the actual install so the mock exec below covers it.
 */
const DEFAULT_PIN = '1.0.0';

const TEST_CLIENT_DEFINITION = createClientDefinition({
  id: 'test-client',
  name: 'Test Client',
  version: '0.1.0',
  defaultApprovalPolicy: 'always-ask',
  runtimeCapabilities: { supportsManagedBinary: true },
  managedInstall: {
    type: 'npm',
    package: '@example/test-client',
    version: DEFAULT_PIN,
  },
  versionCommand: { executable: 'bin/test-client', args: ['--version'] },
});

const POST_INSTALL_CLIENT_DEFINITION = createClientDefinition({
  id: 'test-client',
  name: 'Test Client',
  version: '0.1.0',
  defaultApprovalPolicy: 'always-ask',
  runtimeCapabilities: { supportsManagedBinary: true },
  managedInstall: TEST_CLIENT_DEFINITION.managedInstall,
  versionCommand: { executable: 'bin/test-client', args: ['--version'] },
  postInstall: {
    kind: 'set-executable',
    payload: { mode: '755' },
  },
});

const UNKNOWN_HANDLER_CLIENT_DEFINITION = createClientDefinition({
  id: 'test-client',
  name: 'Test Client',
  version: '0.1.0',
  defaultApprovalPolicy: 'always-ask',
  runtimeCapabilities: { supportsManagedBinary: true },
  managedInstall: TEST_CLIENT_DEFINITION.managedInstall,
  versionCommand: { executable: 'bin/test-client', args: ['--version'] },
  postInstall: {
    kind: 'unknown-handler',
  },
});

const CONSTRAINED_CLIENT_DEFINITION = createClientDefinition({
  id: 'test-client',
  name: 'Test Client',
  version: '0.1.0',
  defaultApprovalPolicy: 'always-ask',
  binary: { name: 'test-client', supportedVersions: '>=2.0.0 <3.0.0' },
  runtimeCapabilities: { supportsManagedBinary: true },
  managedInstall: {
    type: 'npm',
    package: '@example/test-client',
    version: '2.1.0',
  },
  versionCommand: TEST_CLIENT_DEFINITION.versionCommand,
});

function makeDefinitionLookup(definition = TEST_CLIENT_DEFINITION): ClientDefinitionLookup {
  return {
    getDefinition: (clientId) => (clientId === definition.id ? definition : undefined),
    listDefinitions: () => [definition],
  };
}

// ---------------------------------------------------------------------------
// Strategy dependency mocks
//
// The npm strategy calls exec('npm', [...]) to install the package.
// The version verifier calls exec(binaryPath, args, { cwd: installPath }).
// ---------------------------------------------------------------------------

function makeStrategyDeps(
  options: {
    /** Delay in ms to simulate an async install that runs in the background */
    executeDelayMs?: number;
    /**
     * When true, the version verifier exec call throws to simulate a failure.
     * The npm install exec call is unaffected.
     */
    failExec?: boolean;
  } = {},
): StrategyDependencies {
  const { executeDelayMs = 0, failExec = false } = options;

  return {
    // Not used by npm strategy, but kept for interface completeness
    fetchText: vi.fn().mockResolvedValue(''),
    fetchJson: vi.fn().mockResolvedValue({}),
    downloadFile: vi.fn().mockResolvedValue(''),
    computeChecksum: vi.fn().mockResolvedValue(''),
    extractArchive: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    // exec is used for both `npm install` and the version verifier.
    //
    // npm install call:
    //   exec('npm', ['install', ...], undefined)
    //   → Must create the binary on disk so the verifier can resolve its realpath.
    //     The install path is the --prefix argument (4th npm arg), and the version
    //     being installed is the last segment of the `package@version` spec (2nd arg).
    //
    // version verifier call:
    //   exec(binaryPath, ['--version'], { cwd: installPath })
    //   → Must return the version string; we extract it from `path.basename(installPath)`.
    exec: vi.fn().mockImplementation(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      if (executeDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, executeDelayMs));
      }

      if (opts?.cwd !== undefined) {
        // Version verifier call: return version from installPath basename.
        if (failExec) {
          throw new Error('exec: permission denied');
        }
        return path.basename(opts.cwd);
      }

      // npm install call: create the binary on disk so the verifier can find it.
      // args: ['install', 'pkg@version', '--prefix', targetDir, '--no-save', '--ignore-scripts']
      if (cmd === 'npm') {
        const prefixIndex = args.indexOf('--prefix');
        if (prefixIndex !== -1 && prefixIndex + 1 < args.length) {
          const targetDir = args[prefixIndex + 1];
          if (typeof targetDir === 'string') {
            const binaryPath = path.join(targetDir, 'bin', 'test-client');
            await fs.mkdir(path.dirname(binaryPath), { recursive: true });
            await fs.writeFile(binaryPath, '#!/bin/sh\n');
          }
        }
      }

      return '';
    }),
    removeDirectory: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Completion helpers
//
// Install and update requests return after scheduling background work. Tests
// that assert job side effects must wait for client.installJob.completed rather
// than flushing event-loop turns.
// ---------------------------------------------------------------------------

const DEFAULT_WAIT_TIMEOUT_MS = 2_000;

/**
 * Returns a promise that resolves when the next `client.installJob.completed`
 * event is emitted on the bus. The manager releases the per-client lock
 * before emitting this event, so the next lock-dependent operation can
 * proceed immediately after this resolves.
 *
 * Must be registered BEFORE the `bus.request` that starts the job.
 * @param bus - Bus instance to subscribe on
 * @param timeoutMs - Maximum time to wait before failing the test.
 * @param match - Predicate that selects the completion event for this wait.
 */
function waitForCompletion(
  bus: IMakaioBus,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  match: (payload: ClientInstallCompleted) => boolean = () => true,
): Promise<void> & { unsubscribe: () => void } {
  let unsub: () => void = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = (): void => {
    unsub();
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const completion = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${ClientSubjects.installJob.completed}`));
    }, timeoutMs);
    unsub = bus.on(ClientSubjects.installJob.completed, (ctx) => {
      if (!match(ctx.payload)) {
        return;
      }
      unsubscribe();
      resolve();
    });
  }) as Promise<void> & { unsubscribe: () => void };
  completion.unsubscribe = unsubscribe;
  return completion;
}

/**
 * Runs a request that starts an install job and waits for its completion event.
 * @param bus - Bus instance to subscribe on.
 * @param request - Function that starts the install job.
 * @returns The request result after the job has completed.
 */
async function requestAndWaitForCompletion<T extends { jobId: string }>(
  bus: IMakaioBus,
  request: () => Promise<T>,
): Promise<T> {
  let expectedJobId: string | null = null;
  const earlyEvents: ClientInstallCompleted[] = [];
  const completion = waitForCompletion(bus, DEFAULT_WAIT_TIMEOUT_MS, (payload) => {
    if (expectedJobId === null) {
      earlyEvents.push(payload);
      return false;
    }
    return payload.jobId === expectedJobId;
  });
  let result: T;
  try {
    result = await request();
    expectedJobId = result.jobId;
  } catch (error) {
    completion.unsubscribe();
    throw error;
  }
  if (earlyEvents.some((event) => event.jobId === expectedJobId)) {
    completion.unsubscribe();
    return result;
  }
  await completion;
  return result;
}

function subscribeCapture(
  bus: IMakaioBus,
  subject: typeof ClientSubjects.installJob.progress,
  target: ClientInstallProgress[],
): () => void;
function subscribeCapture(
  bus: IMakaioBus,
  subject: typeof ClientSubjects.installJob.completed,
  target: ClientInstallCompleted[],
): () => void;
function subscribeCapture(
  bus: IMakaioBus,
  subject: typeof ClientSubjects.version.changed,
  target: ClientVersionChanged[],
): () => void;
/**
 * Subscribe to a client event subject and append every payload to `target`.
 * @param bus - Bus instance to subscribe on
 * @param subject - Client event subject to capture
 * @param target - Mutable event list populated by the subscription
 * @returns Cleanup function returned by `bus.on`
 */
function subscribeCapture(
  bus: IMakaioBus,
  subject:
    | typeof ClientSubjects.installJob.progress
    | typeof ClientSubjects.installJob.completed
    | typeof ClientSubjects.version.changed,
  target: ClientInstallProgress[] | ClientInstallCompleted[] | ClientVersionChanged[],
): () => void {
  if (subject === ClientSubjects.installJob.progress) {
    const events = target as ClientInstallProgress[];
    return bus.on(subject, (ctx) => {
      events.push(ctx.payload);
    });
  }
  if (subject === ClientSubjects.installJob.completed) {
    const events = target as ClientInstallCompleted[];
    return bus.on(subject, (ctx) => {
      events.push(ctx.payload);
    });
  }
  const events = target as ClientVersionChanged[];
  return bus.on(ClientSubjects.version.changed, (ctx) => {
    events.push(ctx.payload);
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ClientBinaryManager', () => {
  let bus: IMakaioBus;
  let manager: ClientBinaryManager;
  let storageCleanup: () => void;
  let dbCtx: PluginTestDbContext;
  let testBasePath: string;

  beforeAll(async () => {
    dbCtx = await createPluginTestDb({
      name: 'client-binary-manager',
      schemas: CLIENT_BINARY_DDL,
      tables: ['client_binary_versions', 'client_binary_state'],
      // Placeholder — handlers are re-registered per-test
      registerHandlers: () => () => {},
    });
  });

  afterAll(async () => {
    await dbCtx.close();
  });

  beforeEach(async () => {
    await dbCtx.clearData();
    testBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-client-binaries-'));
    bus = createBusInstance();
    storageCleanup = registerDrizzleClientBinaryStorage(bus, dbCtx.db, makeStubExtensionContext(bus));
  });

  afterEach(async () => {
    await manager?.destroy();
    storageCleanup();
    await fs.rm(testBasePath, { recursive: true, force: true });
  });

  function expectedInstallPath(clientId: string, version: string): string {
    return path.join(testBasePath, 'binaries', clientId, version);
  }

  /**
   * Returns the standard manager config rooted at the per-test temp directory.
   * Use this whenever no intentionally non-standard paths are needed.
   */
  function managerConfig(): { basePath: string; configBasePath: string } {
    return {
      basePath: path.join(testBasePath, 'binaries'),
      configBasePath: path.join(testBasePath, 'config'),
    };
  }

  async function initManager(
    strategyDeps: StrategyDependencies,
    options: {
      definition?: typeof TEST_CLIENT_DEFINITION;
      config?: ConstructorParameters<typeof ClientBinaryManager>[1];
    } = {},
  ): Promise<void> {
    manager = new ClientBinaryManager(
      bus,
      options.config ?? managerConfig(),
      makeDefinitionLookup(options.definition),
      strategyDeps,
    );
    await manager.init();
  }

  // -------------------------------------------------------------------------
  // Constructor validation
  // -------------------------------------------------------------------------

  it('throws when basePath is relative', () => {
    expect(
      () =>
        new ClientBinaryManager(
          bus,
          { basePath: 'relative/path', configBasePath: testBasePath },
          makeDefinitionLookup(),
          makeStrategyDeps(),
        ),
    ).toThrow('ClientBinaryManager requires a non-empty absolute basePath');
  });

  it('throws when basePath is empty', () => {
    expect(
      () =>
        new ClientBinaryManager(
          bus,
          { basePath: '', configBasePath: testBasePath },
          makeDefinitionLookup(),
          makeStrategyDeps(),
        ),
    ).toThrow('ClientBinaryManager requires a non-empty absolute basePath');
  });

  it('isPathWithinBase rejects relative inputs before cwd-based resolution', () => {
    const base = path.join(testBasePath, 'base');
    const relativeBase = path.relative(process.cwd(), base);
    const relativeCandidate = path.relative(process.cwd(), path.join(base, 'candidate'));

    expect(isPathWithinBase(relativeBase, path.join(base, 'candidate'))).toBe(false);
    expect(isPathWithinBase(base, relativeCandidate)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // client.list — empty state
  // -------------------------------------------------------------------------

  it('client.list includes registered managed clients before any version is installed', async () => {
    await initManager(makeStrategyDeps());
    const result = await bus.request(ClientSubjects.list, {});
    expect(result.clients).toEqual([
      {
        clientId: 'test-client',
        installedVersions: [],
        activeVersion: null,
        pinnedVersion: DEFAULT_PIN,
        updateAvailable: false,
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // Async install job creation
  // -------------------------------------------------------------------------

  it('client.install returns jobId immediately before the job completes', async () => {
    await initManager(makeStrategyDeps({ executeDelayMs: 20 }));

    // Start listening before the install request so we don't miss the event.
    const completion = waitForCompletion(bus);

    const response = await bus.request(ClientSubjects.install, {
      clientId: 'test-client',
      version: DEFAULT_PIN,
    });

    // The response arrives before the background job completes
    expect(response.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.requestedVersion).toBe(DEFAULT_PIN);
    expect(response.resolvedVersion).toBe(DEFAULT_PIN);

    await completion; // wait for the job to actually finish
  });

  it('client.install rejects unknown clients', async () => {
    await initManager(makeStrategyDeps());
    await expect(bus.request(ClientSubjects.install, { clientId: 'no-such-client' })).rejects.toThrow(
      'no definition registered',
    );
  });

  it('client.install rejects versions outside the supported binary range', async () => {
    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps, { definition: CONSTRAINED_CLIENT_DEFINITION });

    // CONSTRAINED_CLIENT_DEFINITION pins 2.1.0 which is within >=2.0.0 <3.0.0.
    // Request a version that is explicitly outside the range to trigger the guard.
    await expect(bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.9.0' })).rejects.toThrow(
      "client.install: requested version 1.9.0 for client 'test-client' does not match pinned version 2.1.0",
    );
    expect(strategyDeps.exec).not.toHaveBeenCalled();
  });

  it('client.install rejects a second concurrent install for the same client', async () => {
    await initManager(makeStrategyDeps({ executeDelayMs: 50 }));

    // Start listening before the install request so we don't miss the event.
    const completion = waitForCompletion(bus);

    // Start first job (long-running)
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN });

    // Second request should be rejected immediately (job is still running)
    await expect(
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN }),
    ).rejects.toThrow('already in progress');

    await completion; // let the first job finish
  });

  // -------------------------------------------------------------------------
  // Pin-only install semantics
  // -------------------------------------------------------------------------

  it('client.install without explicit version uses the descriptor pin', async () => {
    await initManager(makeStrategyDeps());

    const response = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client' }),
    );

    expect(response.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.requestedVersion).toBeNull();
    expect(response.resolvedVersion).toBe(DEFAULT_PIN);

    // Confirm the pinned version was actually installed
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.installedVersions.some((v) => v.version === DEFAULT_PIN)).toBe(true);
  });

  it('client.install rejects explicit versions that differ from the descriptor pin', async () => {
    await initManager(makeStrategyDeps());

    await expect(bus.request(ClientSubjects.install, { clientId: 'test-client', version: '0.9.0' })).rejects.toThrow(
      `client.install: requested version 0.9.0 for client 'test-client' does not match pinned version ${DEFAULT_PIN}`,
    );
  });

  // -------------------------------------------------------------------------
  // Progress events
  // -------------------------------------------------------------------------

  it('emits client.installJob.progress events during the install pipeline', async () => {
    await initManager(makeStrategyDeps());

    const progressEvents: ClientInstallProgress[] = [];
    const cleanupProgress = subscribeCapture(bus, ClientSubjects.installJob.progress, progressEvents);

    await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN }),
    );

    cleanupProgress();

    // npm strategy emits: installing
    expect(progressEvents.length).toBeGreaterThan(0);
    const first = progressEvents[0];
    expect(first.clientId).toBe('test-client');
    expect(first.version).toBe(DEFAULT_PIN);
    expect(first.strategy).toBe('npm');
    expect(first.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('emits the activating progress stage during client.update (makeActive=true)', async () => {
    await initManager(makeStrategyDeps());

    const progressEvents: ClientInstallProgress[] = [];
    const cleanupProgress = subscribeCapture(bus, ClientSubjects.installJob.progress, progressEvents);

    await requestAndWaitForCompletion(bus, () => bus.request(ClientSubjects.update, { clientId: 'test-client' }));

    cleanupProgress();

    expect(progressEvents.some((event) => event.stage === 'activating')).toBe(true);
    const activatingEvent = progressEvents.find((event) => event.stage === 'activating');
    expect(activatingEvent?.activeAfterCompletion).toBe(true);
    expect(activatingEvent?.clientId).toBe('test-client');
  });

  it('does not emit the activating progress stage during client.install (makeActive=false)', async () => {
    await initManager(makeStrategyDeps());

    const progressEvents: ClientInstallProgress[] = [];
    const cleanupProgress = subscribeCapture(bus, ClientSubjects.installJob.progress, progressEvents);

    await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN }),
    );

    cleanupProgress();

    expect(progressEvents.every((event) => event.stage !== 'activating')).toBe(true);
  });

  it('runs a registered post-install handler and emits the post-install stage', async () => {
    const postInstallHandler = vi.fn().mockResolvedValue({ mode: '755' });
    await initManager(makeStrategyDeps(), {
      definition: POST_INSTALL_CLIENT_DEFINITION,
      config: {
        ...managerConfig(),
        postInstallHandlers: new Map([['set-executable', postInstallHandler]]),
      },
    });

    const progressEvents: ClientInstallProgress[] = [];
    const cleanupProgress = subscribeCapture(bus, ClientSubjects.installJob.progress, progressEvents);

    await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN }),
    );

    expect(progressEvents.some((event) => event.stage === 'post-install')).toBe(true);

    cleanupProgress();

    expect(postInstallHandler).toHaveBeenCalledOnce();
    expect(postInstallHandler).toHaveBeenCalledWith({
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: expectedInstallPath('test-client', DEFAULT_PIN),
      descriptor: POST_INSTALL_CLIENT_DEFINITION.postInstall,
    });
  });

  // -------------------------------------------------------------------------
  // Completed events — success path
  // -------------------------------------------------------------------------

  it('emits client.installJob.completed with status:success after a successful install', async () => {
    await initManager(makeStrategyDeps());

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanup = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    const { jobId } = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, {
        clientId: 'test-client',
        version: DEFAULT_PIN,
      }),
    );

    cleanup();

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].jobId).toBe(jobId);
    expect(completedEvents[0].clientId).toBe('test-client');
    expect(completedEvents[0].version).toBe(DEFAULT_PIN);
    expect(completedEvents[0].status).toBe('success');
    expect(completedEvents[0].activeVersion).toBeNull(); // install does not auto-activate
  });

  // -------------------------------------------------------------------------
  // Completed events — error path
  // -------------------------------------------------------------------------

  it('emits client.installJob.completed with status:error when the strategy fails', async () => {
    await initManager(makeStrategyDeps({ failExec: true }));

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanup = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    const { jobId } = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, {
        clientId: 'test-client',
        version: DEFAULT_PIN,
      }),
    );

    cleanup();

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].jobId).toBe(jobId);
    expect(completedEvents[0].status).toBe('error');
    expect(completedEvents[0].activeVersion).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Version verification — install success path
  // -------------------------------------------------------------------------

  it('install success: verifier runs before storage insert (verifying stage emitted)', async () => {
    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const progressEvents: ClientInstallProgress[] = [];
    const cleanupProgress = subscribeCapture(bus, ClientSubjects.installJob.progress, progressEvents);

    await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN }),
    );

    cleanupProgress();

    // The verifying stage with kind:'version-command' must appear in progress events.
    const verifyingEvent = progressEvents.find(
      (e) => e.stage === 'verifying' && e.metadata?.['kind'] === 'version-command',
    );
    expect(verifyingEvent).toBeDefined();
    // The exec mock must have been called (verifier ran).
    expect(strategyDeps.exec).toHaveBeenCalled();
  });

  it('post-install runs before version verification', async () => {
    const callOrder: string[] = [];
    const postInstallHandler = vi.fn().mockImplementation(async () => {
      callOrder.push('post-install');
      return { mode: '755' };
    });
    const strategyDeps = makeStrategyDeps();
    (strategyDeps.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (opts?.cwd !== undefined) {
          callOrder.push('verifier');
          return path.basename(opts.cwd);
        }
        // npm install call: create binary on disk so the verifier can find it.
        if (cmd === 'npm') {
          const prefixIndex = args.indexOf('--prefix');
          if (prefixIndex !== -1 && prefixIndex + 1 < args.length) {
            const targetDir = args[prefixIndex + 1];
            if (typeof targetDir === 'string') {
              const binaryPath = path.join(targetDir, 'bin', 'test-client');
              await fs.mkdir(path.dirname(binaryPath), { recursive: true });
              await fs.writeFile(binaryPath, '#!/bin/sh\n');
            }
          }
        }
        return '';
      },
    );

    await initManager(strategyDeps, {
      definition: POST_INSTALL_CLIENT_DEFINITION,
      config: {
        ...managerConfig(),
        postInstallHandlers: new Map([['set-executable', postInstallHandler]]),
      },
    });

    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN });
    await completion;

    // post-install must precede verifier so that chmod-like ops complete first.
    const postIndex = callOrder.indexOf('post-install');
    const verifyIndex = callOrder.indexOf('verifier');
    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(postIndex).toBeLessThan(verifyIndex);
  });

  it('emits status:error and no client.version.changed when a declared post-install kind has no registered handler', async () => {
    await initManager(makeStrategyDeps(), {
      definition: UNKNOWN_HANDLER_CLIENT_DEFINITION,
      // No handler registered for 'unknown-handler' — postInstallHandlers is empty.
      config: {
        ...managerConfig(),
        postInstallHandlers: new Map(),
      },
    });

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanupCompleted = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    const completion = waitForCompletion(bus);
    const { jobId } = await bus.request(ClientSubjects.install, {
      clientId: 'test-client',
      version: DEFAULT_PIN,
    });
    await completion;

    cleanupChanged();
    cleanupCompleted();

    // Job must complete with error because no handler is registered for 'unknown-handler'.
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].jobId).toBe(jobId);
    expect(completedEvents[0].status).toBe('error');
    expect(completedEvents[0].error?.message).toContain(
      'No post-install handler registered for kind "unknown-handler"',
    );

    // No version.changed event must have been emitted (install failed before recording).
    expect(versionChangedEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // RT-8: post-install handler throws
  // -------------------------------------------------------------------------

  it('emits status:error and no client.version.changed when a post-install handler throws', async () => {
    const postInstallHandler = vi.fn().mockRejectedValue(new Error('handler exploded'));
    await initManager(makeStrategyDeps(), {
      definition: POST_INSTALL_CLIENT_DEFINITION,
      config: {
        ...managerConfig(),
        postInstallHandlers: new Map([['set-executable', postInstallHandler]]),
      },
    });

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanupCompleted = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    const completion = waitForCompletion(bus);
    const { jobId } = await bus.request(ClientSubjects.install, {
      clientId: 'test-client',
      version: DEFAULT_PIN,
    });
    await completion;

    cleanupChanged();
    cleanupCompleted();

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].jobId).toBe(jobId);
    expect(completedEvents[0].status).toBe('error');
    expect(completedEvents[0].error?.message).toContain('handler exploded');

    expect(versionChangedEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Version verification — failure path during install/update
  // -------------------------------------------------------------------------

  it('verification failure emits status:error, stores no version, and emits no client.version.changed', async () => {
    const strategyDeps = makeStrategyDeps({ failExec: true });
    await initManager(strategyDeps);

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanupCompleted = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    const { jobId } = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, {
        clientId: 'test-client',
        version: DEFAULT_PIN,
      }),
    );

    cleanupChanged();
    cleanupCompleted();

    // Job must complete with error.
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].jobId).toBe(jobId);
    expect(completedEvents[0].status).toBe('error');

    // No version.changed event must have been emitted.
    expect(versionChangedEvents).toHaveLength(0);

    // Storage must not contain a version record.
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.installedVersions).toHaveLength(0);
  });

  it('update verification failure leaves the prior active version unchanged', async () => {
    // Install and activate the pin (1.0.0) successfully first.
    const workingDeps = makeStrategyDeps();
    await initManager(workingDeps);
    await requestAndWaitForCompletion(bus, () => bus.request(ClientSubjects.update, { clientId: 'test-client' }));

    // Verify 1.0.0 is active before the failing update.
    const listBefore = await bus.request(ClientSubjects.list, {});
    const entryBefore = listBefore.clients.find((c) => c.clientId === 'test-client');
    expect(entryBefore?.activeVersion).toBe(DEFAULT_PIN);

    // Reinitialize with a failing exec so version verification fails.
    await manager.destroy();
    const failingDeps = makeStrategyDeps({ failExec: true });
    manager = new ClientBinaryManager(bus, managerConfig(), makeDefinitionLookup(), failingDeps);
    await manager.init();

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const { jobId } = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.update, { clientId: 'test-client' }),
    );

    cleanupChanged();

    // Active version must still be the original pin — no extra version.changed emitted.
    const listAfter = await bus.request(ClientSubjects.list, {});
    const entryAfter = listAfter.clients.find((c) => c.clientId === 'test-client');
    expect(entryAfter?.activeVersion).toBe(DEFAULT_PIN);

    // No extra version.changed events (only the first update's activation occurred).
    expect(versionChangedEvents).toHaveLength(0);
    void jobId;
  });

  // -------------------------------------------------------------------------
  // Version verification — set-active path
  // -------------------------------------------------------------------------

  it('set-active verification failure does not mutate active state', async () => {
    // Install and activate 1.0.0 via update successfully.
    const workingDeps = makeStrategyDeps();
    await initManager(workingDeps);
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    // We need a second installable version. Temporarily allow any version through
    // by installing into storage directly and creating the binary on disk.
    const altVersion = '0.9.0';
    const altInstallPath = expectedInstallPath('test-client', altVersion);
    const executablePath = path.join(altInstallPath, 'bin', 'test-client');
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(executablePath, '#!/bin/sh\n');
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: altVersion,
      installPath: altInstallPath,
      installedAt: now,
      createdAt: now,
    });

    // Reinitialize with failing exec so setActive verification fails.
    await manager.destroy();
    const failingDeps = makeStrategyDeps({ failExec: true });
    manager = new ClientBinaryManager(bus, managerConfig(), makeDefinitionLookup(), failingDeps);
    await manager.init();

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    // setActive should throw because verification fails.
    await expect(
      bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: altVersion }),
    ).rejects.toThrow('Version verification failed');

    cleanupChanged();

    // No version.changed must have been emitted.
    expect(versionChangedEvents).toHaveLength(0);

    // Active version must still be DEFAULT_PIN.
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.activeVersion).toBe(DEFAULT_PIN);
  });

  it('client.setActive fails without mutating active state when no definition is registered for the client', async () => {
    // Seed a version in storage directly so handleSetActive can find it.
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: expectedInstallPath('test-client', DEFAULT_PIN),
      installedAt: now,
      createdAt: now,
    });

    // Initialize the manager with an empty definition lookup. Activation must
    // fail because setActive cannot verify an installed version without the
    // definition's managed version command.
    const emptyLookup: ClientDefinitionLookup = {
      getDefinition: () => undefined,
      listDefinitions: () => [],
    };
    const strategyDeps = makeStrategyDeps();
    manager = new ClientBinaryManager(bus, managerConfig(), emptyLookup, strategyDeps);
    await manager.init();

    await expect(
      bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: DEFAULT_PIN }),
    ).rejects.toThrow("client.setActive: no definition registered for client 'test-client'");

    const { state } = await bus.request(ClientBinaryStorageSubjects.getState, { clientId: 'test-client' });
    expect(state).toBeNull();

    // exec cannot be called because there is no definition to provide a command.
    expect(strategyDeps.exec).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // client.update — installs descriptor pin and makes it active
  // -------------------------------------------------------------------------

  it('client.update installs the descriptor pin and activates it', async () => {
    await initManager(makeStrategyDeps());

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanupCompleted = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    const { jobId, resolvedVersion } = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.update, { clientId: 'test-client' }),
    );

    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolvedVersion).toBe(DEFAULT_PIN);

    cleanupChanged();
    cleanupCompleted();

    // version.changed emitted after activation
    expect(versionChangedEvents).toHaveLength(1);
    expect(versionChangedEvents[0].clientId).toBe('test-client');
    expect(versionChangedEvents[0].activeVersion).toBe(DEFAULT_PIN);
    expect(versionChangedEvents[0].reason).toBe('update');

    // completed event has activeVersion set
    expect(completedEvents[0].activeVersion).toBe(DEFAULT_PIN);

    // Storage reflects the new active version
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.activeVersion).toBe(DEFAULT_PIN);
    expect(entry?.installedVersions).toHaveLength(1);
    expect(entry?.installedVersions[0]?.isActive).toBe(true);
  });

  it('client.update does not contact an upstream feed', async () => {
    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    await requestAndWaitForCompletion(bus, () => bus.request(ClientSubjects.update, { clientId: 'test-client' }));

    // fetchText is the feed-fetch dependency — it must not be called
    expect(strategyDeps.fetchText).not.toHaveBeenCalled();
  });

  it('client.update rejects the descriptor pin when it falls outside the supported binary range', async () => {
    // CONSTRAINED_CLIENT_DEFINITION pins 2.1.0 which is within >=2.0.0 <3.0.0 —
    // override with a version that is outside the range to test the guard.
    const outOfRangeDefinition = createClientDefinition({
      id: 'test-client',
      name: 'Test Client',
      version: '0.1.0',
      defaultApprovalPolicy: 'always-ask',
      binary: { name: 'test-client', supportedVersions: '>=2.0.0 <3.0.0' },
      runtimeCapabilities: { supportsManagedBinary: true },
      managedInstall: {
        type: 'npm',
        package: '@example/test-client',
        version: '3.1.0',
      },
      versionCommand: TEST_CLIENT_DEFINITION.versionCommand,
    });
    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps, { definition: outOfRangeDefinition });

    await expect(bus.request(ClientSubjects.update, { clientId: 'test-client' })).rejects.toThrow(
      "client.update: resolved binary version 3.1.0 for client 'test-client' does not satisfy >=2.0.0 <3.0.0",
    );
    expect(strategyDeps.exec).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Activation failure cleanup (storage consistency)
  // -------------------------------------------------------------------------

  it('does not persist a version row when atomic install recording fails', async () => {
    // Register a high-priority handler that rejects the transactional storage
    // operation. The manager now records the installed version and active
    // pointer together, so failure leaves no orphaned version row to clean up.
    const cleanupInterceptor = bus.on(
      ClientBinaryStorageSubjects.recordInstalledVersion,
      () => {
        throw new Error('setActiveVersion: simulated storage failure');
      },
      { priority: 100 },
    );

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanupCompleted = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    await initManager(makeStrategyDeps());

    // client.update uses makeActive=true, so the completion callback records
    // and activates the installed version in one storage transaction.
    await requestAndWaitForCompletion(bus, () => bus.request(ClientSubjects.update, { clientId: 'test-client' }));

    cleanupInterceptor();
    cleanupCompleted();

    // Job must complete with an error because activation failed.
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].status).toBe('error');

    // The version row must have been cleaned up: no orphaned row should remain.
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.installedVersions).toHaveLength(0);
    expect(entry?.activeVersion).toBeNull();
  });

  // -------------------------------------------------------------------------
  // client.setActive — switches among installed versions
  // -------------------------------------------------------------------------

  it('client.setActive switches the active pointer to an installed version', async () => {
    await initManager(makeStrategyDeps());

    // Install the pinned version — waitForCompletion ensures per-client lock release
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN });
    await completion;

    // Seed a second version record directly into storage for setActive testing
    const altVersion = '0.9.0';
    const altInstallPath = expectedInstallPath('test-client', altVersion);
    const executablePath = path.join(altInstallPath, 'bin', 'test-client');
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(executablePath, '#!/bin/sh\n');
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: altVersion,
      installPath: altInstallPath,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    // Override exec to return the correct version for setActive verification
    (strategyDeps.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cmd: string, _args: string[], opts?: { cwd?: string }) => {
        if (opts?.cwd !== undefined) {
          return path.basename(opts.cwd);
        }
        return '';
      },
    );
    await manager.destroy();
    manager = new ClientBinaryManager(bus, managerConfig(), makeDefinitionLookup(), strategyDeps);
    await manager.init();

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const result = await bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: DEFAULT_PIN });

    cleanupChanged();

    expect(result.clientId).toBe('test-client');
    expect(result.activeVersion).toBe(DEFAULT_PIN);

    expect(versionChangedEvents).toHaveLength(1);
    expect(versionChangedEvents[0].activeVersion).toBe(DEFAULT_PIN);
    expect(versionChangedEvents[0].reason).toBe('set-active');
  });

  it('client.setActive rejects when the requested version is not installed', async () => {
    await initManager(makeStrategyDeps());
    await expect(bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: '99.0.0' })).rejects.toThrow(
      'not installed',
    );
  });

  it('client.setActive rejects installed versions outside the supported binary range', async () => {
    const version = '1.9.0';
    const installPath = expectedInstallPath('test-client', version);
    const executablePath = path.join(installPath, 'bin', 'test-client');
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(executablePath, '#!/bin/sh\n');
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version,
      installPath,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps, { definition: CONSTRAINED_CLIENT_DEFINITION });

    await expect(bus.request(ClientSubjects.setActive, { clientId: 'test-client', version })).rejects.toThrow(
      "client.setActive: requested binary version 1.9.0 for client 'test-client' does not satisfy >=2.0.0 <3.0.0",
    );
    expect(strategyDeps.exec).not.toHaveBeenCalled();
  });

  it('client.setActive rejects a stored installPath that points at another in-base client directory', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: expectedInstallPath('other-client', DEFAULT_PIN),
      installedAt: now,
      createdAt: now,
    });

    await initManager(makeStrategyDeps());

    await expect(
      bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: DEFAULT_PIN }),
    ).rejects.toThrow('does not match the expected install directory');
  });

  it('client.setActive accepts a stored installPath below the expected client version directory', async () => {
    const nestedInstallPath = path.join(expectedInstallPath('test-client', DEFAULT_PIN), 'package');
    const executablePath = path.join(nestedInstallPath, 'bin', 'test-client');
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(executablePath, '#!/bin/sh\n');
    const realNestedInstallPath = await fs.realpath(nestedInstallPath);
    const realExecutablePath = await fs.realpath(executablePath);

    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: nestedInstallPath,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    (strategyDeps.exec as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_PIN);
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: DEFAULT_PIN });

    expect(result.activeVersion).toBe(DEFAULT_PIN);
    expect(strategyDeps.exec).toHaveBeenCalledWith(realExecutablePath, ['--version'], {
      cwd: realNestedInstallPath,
    });
  });

  it('client.setActive rejects a symlinked installPath that resolves outside the expected version directory', async () => {
    const expectedRoot = expectedInstallPath('test-client', DEFAULT_PIN);
    const outsideTarget = path.join(testBasePath, 'outside-target');
    const symlinkInstallPath = path.join(expectedRoot, 'linked-package');
    await fs.mkdir(expectedRoot, { recursive: true });
    await fs.mkdir(outsideTarget, { recursive: true });
    await fs.symlink(outsideTarget, symlinkInstallPath, 'dir');

    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: symlinkInstallPath,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    await expect(
      bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: DEFAULT_PIN }),
    ).rejects.toThrow('does not match the expected install directory');
    expect(strategyDeps.exec).not.toHaveBeenCalled();
  });

  it('client.setActive does not emit version.changed when the active version does not change', async () => {
    await initManager(makeStrategyDeps());

    // Install and activate via update
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    // Set active to the already-active version
    await bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: DEFAULT_PIN });

    cleanupChanged();

    expect(versionChangedEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // client.uninstall — removing the active version clears the active pointer
  // -------------------------------------------------------------------------

  it('client.uninstall active version sets activeVersion to null and emits version.changed', async () => {
    await initManager(makeStrategyDeps());

    // Install and activate — waitForCompletion is event-driven and ensures
    // the per-client lock is released before the uninstall request below.
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });

    cleanupChanged();

    expect(result.removedVersion).toBe(DEFAULT_PIN);
    expect(result.activeVersion).toBeNull();

    expect(versionChangedEvents).toHaveLength(1);
    expect(versionChangedEvents[0].previousActiveVersion).toBe(DEFAULT_PIN);
    expect(versionChangedEvents[0].activeVersion).toBeNull();
    expect(versionChangedEvents[0].reason).toBe('uninstall');

    // list shows empty
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.activeVersion).toBeNull();
    expect(entry?.installedVersions).toHaveLength(0);
  });

  it('client.uninstall non-active version does not change the active pointer', async () => {
    // Seed a secondary (non-active) version record directly in storage.
    const altVersion = '0.9.0';
    const altInstallPath = expectedInstallPath('test-client', altVersion);
    await fs.mkdir(altInstallPath, { recursive: true });
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: altVersion,
      installPath: altInstallPath,
      installedAt: now,
      createdAt: now,
    });

    await initManager(makeStrategyDeps());

    // Install and activate the pinned version via update
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    // Uninstall the non-active altVersion
    const result = await bus.request(ClientSubjects.uninstall, {
      clientId: 'test-client',
      version: altVersion,
    });

    cleanupChanged();

    expect(result.removedVersion).toBe(altVersion);
    expect(result.activeVersion).toBe(DEFAULT_PIN);
    expect(versionChangedEvents).toHaveLength(0); // no version change for non-active uninstall
  });

  it('client.uninstall rejects when the version is not installed', async () => {
    await initManager(makeStrategyDeps());
    await expect(bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '99.0.0' })).rejects.toThrow(
      'not installed',
    );
  });

  // -------------------------------------------------------------------------
  // client.uninstall — filesystem cleanup (CF-1)
  // -------------------------------------------------------------------------

  it('client.uninstall calls removeDirectory with the install path after successful DB deletion', async () => {
    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    // Install and activate via update
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });

    expect(strategyDeps.removeDirectory).toHaveBeenCalledOnce();
    expect(strategyDeps.removeDirectory).toHaveBeenCalledWith(expectedInstallPath('test-client', DEFAULT_PIN));
  });

  it('client.uninstall skips removeDirectory and still succeeds when installPath escapes basePath', async () => {
    // Directly seed storage with a tampered installPath that escapes the expected
    // <basePath>/<clientId> directory to verify the path-traversal guard.
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      // Escapes the managed-binary root and points at an unrelated directory.
      installPath: '/etc/cron.d',
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });

    // Uninstall must still succeed and clean up the storage row
    expect(result.removedVersion).toBe(DEFAULT_PIN);
    // The dangerous removeDirectory call must be skipped entirely
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall skips cleanup when installPath is the managed-binary basePath', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: path.join(testBasePath, 'binaries'),
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });

    expect(result.removedVersion).toBe(DEFAULT_PIN);
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall skips cleanup when installPath is empty', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: '',
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });

    expect(result.removedVersion).toBe(DEFAULT_PIN);
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall removes storage but skips cleanup for another in-base client directory', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: expectedInstallPath('other-client', DEFAULT_PIN),
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });

    expect(result.removedVersion).toBe(DEFAULT_PIN);
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall allows cleanup below the expected client version directory', async () => {
    const nestedInstallPath = path.join(expectedInstallPath('test-client', DEFAULT_PIN), 'package');
    await fs.mkdir(nestedInstallPath, { recursive: true });
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: nestedInstallPath,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });

    expect(result.removedVersion).toBe(DEFAULT_PIN);
    expect(strategyDeps.removeDirectory).toHaveBeenCalledOnce();
    expect(strategyDeps.removeDirectory).toHaveBeenCalledWith(nestedInstallPath);
  });

  it('client.uninstall skips cleanup below a filesystem-root basePath when the install path is missing', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: `/test-client/${DEFAULT_PIN}`,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps, { config: { basePath: '/', configBasePath: testBasePath } });

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });

    expect(result.removedVersion).toBe(DEFAULT_PIN);
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall skips cleanup for a symlinked installPath that resolves outside the expected directory', async () => {
    const expectedRoot = expectedInstallPath('test-client', DEFAULT_PIN);
    const outsideTarget = path.join(testBasePath, 'outside-target');
    const symlinkInstallPath = path.join(expectedRoot, 'linked-package');
    await fs.mkdir(expectedRoot, { recursive: true });
    await fs.mkdir(outsideTarget, { recursive: true });
    await fs.symlink(outsideTarget, symlinkInstallPath, 'dir');

    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: symlinkInstallPath,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });

    expect(result.removedVersion).toBe(DEFAULT_PIN);
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall passes the normalized absolute install path to removeDirectory', async () => {
    await fs.mkdir(expectedInstallPath('test-client', DEFAULT_PIN), { recursive: true });
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: path.join(testBasePath, 'binaries', 'test-client', '..', 'test-client', DEFAULT_PIN),
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });

    expect(result.removedVersion).toBe(DEFAULT_PIN);
    expect(strategyDeps.removeDirectory).toHaveBeenCalledOnce();
    expect(strategyDeps.removeDirectory).toHaveBeenCalledWith(expectedInstallPath('test-client', DEFAULT_PIN));
  });

  it('client.uninstall still succeeds when removeDirectory throws', async () => {
    const strategyDeps = makeStrategyDeps();
    (strategyDeps.removeDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ENOENT: no such file or directory'),
    );
    await initManager(strategyDeps);

    // Install and activate via update
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    // Uninstall should still resolve even though removeDirectory throws
    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN });
    expect(result.removedVersion).toBe(DEFAULT_PIN);
  });

  it('client.list shows isActive correctly for multiple installed versions', async () => {
    await initManager(makeStrategyDeps());

    // Install via update (activates pin)
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    // Seed a second version in storage
    const altVersion = '0.9.0';
    const altInstallPath = expectedInstallPath('test-client', altVersion);
    await fs.mkdir(altInstallPath, { recursive: true });
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: altVersion,
      installPath: altInstallPath,
      installedAt: now,
      createdAt: now,
    });

    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.activeVersion).toBe(DEFAULT_PIN);
    expect(entry?.installedVersions).toHaveLength(2);

    const vPin = entry?.installedVersions.find((v) => v.version === DEFAULT_PIN);
    const vAlt = entry?.installedVersions.find((v) => v.version === altVersion);
    expect(vPin?.isActive).toBe(true);
    expect(vAlt?.isActive).toBe(false);
  });

  // -------------------------------------------------------------------------
  // client.list — pinnedVersion and updateAvailable
  // -------------------------------------------------------------------------

  it('client.list returns pinnedVersion from the descriptor', async () => {
    await initManager(makeStrategyDeps());

    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.pinnedVersion).toBe(DEFAULT_PIN);
  });

  it('client.list returns updateAvailable:false when no version is active', async () => {
    await initManager(makeStrategyDeps());

    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.updateAvailable).toBe(false);
  });

  it('client.list returns updateAvailable:false when active version matches the pin', async () => {
    await initManager(makeStrategyDeps());

    // Install and activate the pinned version via update
    await requestAndWaitForCompletion(bus, () => bus.request(ClientSubjects.update, { clientId: 'test-client' }));

    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.activeVersion).toBe(DEFAULT_PIN);
    expect(entry?.pinnedVersion).toBe(DEFAULT_PIN);
    expect(entry?.updateAvailable).toBe(false);
  });

  it('client.list returns updateAvailable:true when active version differs from the pin', async () => {
    // Seed an older version as active in storage directly
    const olderVersion = '0.9.0';
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: olderVersion,
      installPath: expectedInstallPath('test-client', olderVersion),
      installedAt: now,
      createdAt: now,
    });
    await bus.request(ClientBinaryStorageSubjects.upsertState, {
      clientId: 'test-client',
      activeVersion: olderVersion,
      updatedAt: now,
    });

    await initManager(makeStrategyDeps());

    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    // Active is 0.9.0 but pin is 1.0.0 — update is available
    expect(entry?.activeVersion).toBe(olderVersion);
    expect(entry?.pinnedVersion).toBe(DEFAULT_PIN);
    expect(entry?.updateAvailable).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TG-4: client.update concurrent-job rejection
  // -------------------------------------------------------------------------

  it('client.update rejects while an install job is in progress for the same client', async () => {
    await initManager(makeStrategyDeps({ executeDelayMs: 100 }));

    // Start listening before the install so we can wait for it to complete.
    const completion = waitForCompletion(bus);

    // Start a long-running install job.
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN });

    // While the install is still running, client.update should be rejected.
    await expect(bus.request(ClientSubjects.update, { clientId: 'test-client' })).rejects.toThrow(
      'already in progress',
    );

    await completion; // let the first job finish
  });

  // -------------------------------------------------------------------------
  // TG-5: client.uninstall while install job running
  // -------------------------------------------------------------------------

  it('client.uninstall rejects while an install job is in progress for the same client', async () => {
    await initManager(makeStrategyDeps({ executeDelayMs: 100 }));

    // Start listening before the install so we can wait for it to complete.
    const completion = waitForCompletion(bus);

    // Start a long-running install job.
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN });

    // While the install is still running, client.uninstall should be rejected.
    await expect(
      bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: DEFAULT_PIN }),
    ).rejects.toThrow('already in progress');

    await completion; // let the first job finish
  });

  // -------------------------------------------------------------------------
  // cancelAll cancellation invariant — no callbacks fire after destroy
  // -------------------------------------------------------------------------

  it('cancelAll() prevents completed and version.changed callbacks when destroy races an in-flight job', async () => {
    // Use a long enough delay so the job is guaranteed to still be running when
    // manager.destroy() is called synchronously after the install request.
    await initManager(makeStrategyDeps({ executeDelayMs: 80 }));

    const completedEvents: ClientInstallCompleted[] = [];
    const versionChangedEvents: ClientVersionChanged[] = [];

    const cleanupCompleted = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    // Start an install that will remain in-flight for ~80 ms.
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN });

    // Destroy immediately while the download delay is still running. This sets
    // the #cancelled flag and clears the internal job map so that every callback
    // site in ClientBinaryJobRunner will short-circuit on the guard.
    await manager.destroy();

    // 160ms is 2× the 80ms strategy delay — sufficient headroom for any leaked
    // callbacks to fire. A controllable-gate approach would eliminate the timer
    // but adds instrumentation overhead for this single cleanup-verification test.
    await new Promise<void>((resolve) => setTimeout(resolve, 160));

    cleanupCompleted();
    cleanupChanged();

    // Neither the completion event nor a version.changed event must have fired
    // after cancellation.
    expect(completedEvents).toHaveLength(0);
    expect(versionChangedEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // TG-2 analogue: freshly initialized manager reads from storage
  // -------------------------------------------------------------------------

  it('a freshly initialized manager returns state seeded in storage without contacting a feed', async () => {
    // Populate storage directly via bus handlers before the manager is created.
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: DEFAULT_PIN,
      installPath: expectedInstallPath('test-client', DEFAULT_PIN),
      installedAt: now,
      createdAt: now,
    });
    await bus.request(ClientBinaryStorageSubjects.upsertState, {
      clientId: 'test-client',
      activeVersion: DEFAULT_PIN,
      updatedAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    manager = new ClientBinaryManager(bus, managerConfig(), makeDefinitionLookup(), strategyDeps);
    await manager.init();

    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.activeVersion).toBe(DEFAULT_PIN);
    expect(entry?.installedVersions).toHaveLength(1);
    expect(entry?.installedVersions[0]?.version).toBe(DEFAULT_PIN);
    expect(entry?.pinnedVersion).toBe(DEFAULT_PIN);
    // No feed fetches occur during init or list
    expect(strategyDeps.fetchText).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Config prime lifecycle — managed-install phase
  // -------------------------------------------------------------------------

  it('calls client-specific config.prime with managed-install phase after a successful install', async () => {
    await initManager(makeStrategyDeps());

    // Register a per-client handler that observes the prime requests.
    const observed: ClientConfigPrimeRequest[] = [];
    const primeNs = createBusNamespace('client:test-client', {
      'config.prime': {
        request: z.object({
          clientId: z.string(),
          configDir: z.string(),
          phase: z.string(),
          binaryVersion: z.string().optional(),
          adapterName: z.string().optional(),
          projectDir: z.string().optional(),
        }),
        response: z.object({ primed: z.boolean() }),
      },
    });
    const unsubPrime = bus.on(primeNs.subjects.config.prime, (ctx) => {
      observed.push(ctx.payload as ClientConfigPrimeRequest);
      ctx.setResult({ primed: true });
    });

    await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN }),
    );

    unsubPrime();

    expect(observed).toHaveLength(1);
    expect(observed[0]?.clientId).toBe('test-client');
    expect(observed[0]?.phase).toBe('managed-install');
    expect(observed[0]?.binaryVersion).toBe(DEFAULT_PIN);
    expect(observed[0]?.configDir).toBe(path.join(testBasePath, 'config', 'test-client', 'config'));
  });

  it('proceeds with install when no config.prime handler is registered (no-op delegation)', async () => {
    await initManager(makeStrategyDeps());

    // No client:test-client.config.prime handler registered — the install must
    // still complete successfully.
    const completedEvents: ClientInstallCompleted[] = [];
    const cleanup = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN }),
    );

    cleanup();

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.status).toBe('success');
  });

  it('does not publish an installed version when config.prime fails', async () => {
    await initManager(makeStrategyDeps());

    const primeNs = createBusNamespace('client:test-client', {
      'config.prime': {
        request: z.object({
          clientId: z.string(),
          configDir: z.string(),
          phase: z.string(),
          binaryVersion: z.string().optional(),
        }),
        response: z.object({ primed: z.boolean() }),
      },
    });
    const unsubPrime = bus.on(primeNs.subjects.config.prime, () => {
      throw new Error('prime failed');
    });

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanupCompleted = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: DEFAULT_PIN }),
    );

    unsubPrime();
    cleanupCompleted();

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.status).toBe('error');
    expect(completedEvents[0]?.error?.message).toContain('prime failed');

    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.activeVersion).toBeNull();
    expect(entry?.installedVersions).toEqual([]);
  });
});
