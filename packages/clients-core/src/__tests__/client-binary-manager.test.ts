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
 * - `client.install` without explicit version triggers a live feed fetch (RT-5)
 * - `client.update` installs the latest version and makes it active
 * - `client.setActive` switches only among installed versions
 * - Uninstalling the active version leaves no active version
 * - `client.installJob.progress`, `client.installJob.completed`, and
 *   `client.version.changed` events emit with correct payloads
 * - `client.list` with `forceRefresh:true` refreshes the feed (TG-1)
 * - Manager hydration from storage restores state without a live fetch (TG-2)
 * - `updateAvailable` flag is `true` when active version differs from latest (TG-3)
 * - Concurrent install+update and install+uninstall are rejected (TG-4, TG-5)
 * - `client.update` rejects even with a cached version when the feed fails (RT-12)
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects, createClientDefinition } from '@makaio/contracts/client';
import type { ClientInstallCompleted, ClientInstallProgress, ClientVersionChanged } from '@makaio/contracts/client';
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

const CHECKSUM = 'abc123';

const TEST_CLIENT_DEFINITION = createClientDefinition({
  id: 'test-client',
  name: 'Test Client',
  defaultApprovalPolicy: 'always-ask',
  runtimeCapabilities: { supportsManagedBinary: true },
  managedInstall: {
    type: 'manifest-bucket',
    config: {
      baseUrl: 'https://example.com/test-client',
      versionIndex: { latest: 'latest.txt' },
      manifestPath: 'manifest.json',
      manifestChecksumField: 'sha256',
      binaryPath: 'bin/test-client',
    },
  },
  versionCommand: ['bin/test-client', '--version'],
});

const POST_INSTALL_CLIENT_DEFINITION = createClientDefinition({
  id: 'test-client',
  name: 'Test Client',
  defaultApprovalPolicy: 'always-ask',
  runtimeCapabilities: { supportsManagedBinary: true },
  managedInstall: TEST_CLIENT_DEFINITION.managedInstall,
  versionCommand: ['bin/test-client', '--version'],
  postInstall: {
    kind: 'set-executable',
    payload: { mode: '755' },
  },
});

const UNKNOWN_HANDLER_CLIENT_DEFINITION = createClientDefinition({
  id: 'test-client',
  name: 'Test Client',
  defaultApprovalPolicy: 'always-ask',
  runtimeCapabilities: { supportsManagedBinary: true },
  managedInstall: TEST_CLIENT_DEFINITION.managedInstall,
  versionCommand: ['bin/test-client', '--version'],
  postInstall: {
    kind: 'unknown-handler',
  },
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
// The manifest-bucket strategy calls:
//   fetchText(latestUrl) → version string (for resolveLatestVersion)
//   fetchJson(manifestUrl) → { sha256: CHECKSUM } (manifest for a version)
//   downloadFile(url, dest) → dest path
//   computeChecksum(path) → CHECKSUM
// extractArchive and exec are not called for 'raw' archive format.
// ---------------------------------------------------------------------------

function makeStrategyDeps(
  options: {
    latestVersion?: string;
    /** Delay in ms to simulate an async install that runs in the background */
    executeDelayMs?: number;
    /** When true, downloadFile throws to simulate a failure */
    failDownload?: boolean;
    /** When true, exec throws to simulate a version-verification failure */
    failExec?: boolean;
  } = {},
): StrategyDependencies {
  const { latestVersion = '1.0.0', executeDelayMs = 0, failDownload = false, failExec = false } = options;

  return {
    fetchText: vi.fn().mockResolvedValue(latestVersion),
    fetchJson: vi.fn().mockResolvedValue({ sha256: CHECKSUM }),
    downloadFile: failDownload
      ? vi.fn().mockRejectedValue(new Error('Download failed: connection refused'))
      : vi.fn().mockImplementation(async (_url: string, dest: string) => {
          if (executeDelayMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, executeDelayMs));
          }
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, '#!/bin/sh\n');
          // The manifest strategy stores raw downloads by basename, while the
          // test client's versionCommand models a real package layout with
          // `bin/test-client`. Create that executable so verifier realpath
          // checks exercise the manager flow instead of failing on the fixture.
          await fs.mkdir(path.join(path.dirname(dest), 'bin'), { recursive: true });
          await fs.writeFile(path.join(path.dirname(dest), 'bin', 'test-client'), '#!/bin/sh\n');
          return dest;
        }),
    computeChecksum: vi.fn().mockResolvedValue(CHECKSUM),
    extractArchive: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    // StrategyDependencies.exec returns Promise<string> (raw stdout), not
    // { stdout } — the bare-string return here is correct per the contract.
    // The verifier calls exec with { cwd: installPath } where installPath
    // ends with the version string, so the mock extracts the version from cwd.
    exec: failExec
      ? vi.fn().mockRejectedValue(new Error('exec: permission denied'))
      : vi.fn().mockImplementation(async (_cmd: string, _args: string[], opts?: { cwd?: string }) => {
          if (opts?.cwd !== undefined) {
            return path.basename(opts.cwd) || latestVersion;
          }
          return latestVersion;
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
        latestAvailableVersion: null,
        latestVersionLastCheckedAt: null,
        latestVersionSourceStatus: 'error',
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
      version: '1.2.0',
    });

    // The response arrives before the background job completes
    expect(response.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.requestedVersion).toBe('1.2.0');
    expect(response.resolvedVersion).toBe('1.2.0');

    await completion; // wait for the job to actually finish
  });

  it('client.install rejects unknown clients', async () => {
    await initManager(makeStrategyDeps());
    await expect(bus.request(ClientSubjects.install, { clientId: 'no-such-client' })).rejects.toThrow(
      'no definition registered',
    );
  });

  it('client.install rejects a second concurrent install for the same client', async () => {
    await initManager(makeStrategyDeps({ executeDelayMs: 50 }));

    // Start listening before the install request so we don't miss the event.
    const completion = waitForCompletion(bus);

    // Start first job (long-running)
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' });

    // Second request should be rejected immediately (job is still running)
    await expect(bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.1' })).rejects.toThrow(
      'already in progress',
    );

    await completion; // let the first job finish
  });

  // -------------------------------------------------------------------------
  // Progress events
  // -------------------------------------------------------------------------

  it('emits client.installJob.progress events during the install pipeline', async () => {
    await initManager(makeStrategyDeps());

    const progressEvents: ClientInstallProgress[] = [];
    const cleanupProgress = subscribeCapture(bus, ClientSubjects.installJob.progress, progressEvents);

    await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' }),
    );

    cleanupProgress();

    // Strategy emits: resolving, downloading, verifying, extracting, installing
    expect(progressEvents.length).toBeGreaterThan(0);
    const first = progressEvents[0];
    expect(first.clientId).toBe('test-client');
    expect(first.version).toBe('1.0.0');
    expect(first.strategy).toBe('manifest-bucket');
    expect(first.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('emits the activating progress stage during client.update (makeActive=true)', async () => {
    await initManager(makeStrategyDeps({ latestVersion: '2.0.0' }));

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
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' }),
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
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' }),
    );

    expect(progressEvents.some((event) => event.stage === 'post-install')).toBe(true);

    cleanupProgress();

    expect(postInstallHandler).toHaveBeenCalledOnce();
    expect(postInstallHandler).toHaveBeenCalledWith({
      clientId: 'test-client',
      version: '1.0.0',
      installPath: expectedInstallPath('test-client', '1.0.0'),
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
        version: '1.0.0',
      }),
    );

    cleanup();

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].jobId).toBe(jobId);
    expect(completedEvents[0].clientId).toBe('test-client');
    expect(completedEvents[0].version).toBe('1.0.0');
    expect(completedEvents[0].status).toBe('success');
    expect(completedEvents[0].activeVersion).toBeNull(); // install does not auto-activate
  });

  // -------------------------------------------------------------------------
  // Completed events — error path
  // -------------------------------------------------------------------------

  it('emits client.installJob.completed with status:error when the strategy fails', async () => {
    await initManager(makeStrategyDeps({ failDownload: true }));

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanup = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    const { jobId } = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, {
        clientId: 'test-client',
        version: '1.0.0',
      }),
    );

    cleanup();

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].jobId).toBe(jobId);
    expect(completedEvents[0].status).toBe('error');
    expect(completedEvents[0].error?.message).toContain('Download failed');
    expect(completedEvents[0].activeVersion).toBeNull();
  });

  it('client.install completes with status:error for a path-traversal version string without storing a version', async () => {
    await initManager(makeStrategyDeps());

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanupCompleted = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const { jobId } = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, {
        clientId: 'test-client',
        version: '../../etc',
      }),
    );

    cleanupCompleted();
    cleanupChanged();

    // Job must complete with error reporting the invalid install target path.
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].jobId).toBe(jobId);
    expect(completedEvents[0].status).toBe('error');
    expect(completedEvents[0].error?.message).toContain('Invalid install target path');

    // No client.version.changed event must have been emitted.
    expect(versionChangedEvents).toHaveLength(0);

    // Storage must not contain any version record for the traversal attempt.
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.installedVersions).toHaveLength(0);
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
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' }),
    );

    cleanupProgress();

    // The verifying stage with kind:'version-command' must appear in progress events.
    const verifyingEvent = progressEvents.find(
      (e) => e.stage === 'verifying' && e.metadata?.['kind'] === 'version-command',
    );
    expect(verifyingEvent).toBeDefined();
    // The exec mock must have been called (verifier ran).
    expect(strategyDeps.exec).toHaveBeenCalledOnce();
  });

  it('post-install runs before version verification', async () => {
    const callOrder: string[] = [];
    const postInstallHandler = vi.fn().mockImplementation(async () => {
      callOrder.push('post-install');
      return { mode: '755' };
    });
    const strategyDeps = makeStrategyDeps();
    (strategyDeps.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cmd: string, _args: string[], opts?: { cwd?: string }) => {
        callOrder.push('verifier');
        return opts?.cwd !== undefined ? path.basename(opts.cwd) : '1.0.0';
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
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' });
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
      version: '1.0.0',
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
      version: '1.0.0',
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
        version: '1.0.0',
      }),
    );

    cleanupChanged();
    cleanupCompleted();

    // Job must complete with error.
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].jobId).toBe(jobId);
    expect(completedEvents[0].status).toBe('error');
    expect(completedEvents[0].error?.message).toContain('Version verification failed');

    // No version.changed event must have been emitted.
    expect(versionChangedEvents).toHaveLength(0);

    // Storage must not contain a version record.
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.installedVersions).toHaveLength(0);
  });

  it('update verification failure leaves the prior active version unchanged', async () => {
    // Install and activate 1.0.0 successfully first.
    const workingDeps = makeStrategyDeps({ latestVersion: '1.0.0' });
    await initManager(workingDeps);
    await requestAndWaitForCompletion(bus, () => bus.request(ClientSubjects.update, { clientId: 'test-client' }));

    // Verify 1.0.0 is active before the failing update.
    const listBefore = await bus.request(ClientSubjects.list, {});
    const entryBefore = listBefore.clients.find((c) => c.clientId === 'test-client');
    expect(entryBefore?.activeVersion).toBe('1.0.0');

    // Reinitialize with a new version but a failing exec.
    await manager.destroy();
    const failingDeps = makeStrategyDeps({ latestVersion: '2.0.0', failExec: true });
    manager = new ClientBinaryManager(bus, managerConfig(), makeDefinitionLookup(), failingDeps);
    await manager.init();

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const { jobId } = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.update, { clientId: 'test-client' }),
    );

    cleanupChanged();

    // Active version must still be 1.0.0 — no extra version.changed emitted.
    const listAfter = await bus.request(ClientSubjects.list, {});
    const entryAfter = listAfter.clients.find((c) => c.clientId === 'test-client');
    expect(entryAfter?.activeVersion).toBe('1.0.0');
    expect(entryAfter?.installedVersions.some((v) => v.version === '2.0.0')).toBe(false);

    // No extra version.changed events (the activation from the first update is
    // already committed before we subscribe — only events from the failing update matter).
    expect(versionChangedEvents).toHaveLength(0);
    void jobId; // jobId is used to start the update; outcome tracked via events above
  });

  // -------------------------------------------------------------------------
  // Version verification — set-active path
  // -------------------------------------------------------------------------

  it('set-active verification failure does not mutate active state', async () => {
    // Install and activate 1.0.0 via update successfully.
    const workingDeps = makeStrategyDeps({ latestVersion: '1.0.0' });
    await initManager(workingDeps);
    let completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    // Install 1.1.0 (not activated) — exec returns correct version from cwd.
    completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.1.0' });
    await completion;

    // Reinitialize with failing exec so setActive verification fails.
    await manager.destroy();
    const failingDeps = makeStrategyDeps({ latestVersion: '1.0.0', failExec: true });
    manager = new ClientBinaryManager(bus, managerConfig(), makeDefinitionLookup(), failingDeps);
    await manager.init();

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    // setActive should throw because verification fails.
    await expect(bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: '1.1.0' })).rejects.toThrow(
      'Version verification failed',
    );

    cleanupChanged();

    // No version.changed must have been emitted.
    expect(versionChangedEvents).toHaveLength(0);

    // Active version must still be 1.0.0.
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.activeVersion).toBe('1.0.0');
  });

  it('client.setActive fails without mutating active state when no definition is registered for the client', async () => {
    // Seed a version in storage directly so handleSetActive can find it.
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: expectedInstallPath('test-client', '1.0.0'),
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

    await expect(bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: '1.0.0' })).rejects.toThrow(
      "client.setActive: no definition registered for client 'test-client'",
    );

    const { state } = await bus.request(ClientBinaryStorageSubjects.getState, { clientId: 'test-client' });
    expect(state).toBeNull();

    // exec cannot be called because there is no definition to provide a command.
    expect(strategyDeps.exec).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // client.update — installs latest and makes it active
  // -------------------------------------------------------------------------

  it('client.update installs the latest version and activates it', async () => {
    await initManager(makeStrategyDeps({ latestVersion: '2.0.0' }));

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const completedEvents: ClientInstallCompleted[] = [];
    const cleanupCompleted = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);

    const { jobId, resolvedVersion } = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.update, { clientId: 'test-client' }),
    );

    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolvedVersion).toBe('2.0.0');

    cleanupChanged();
    cleanupCompleted();

    // version.changed emitted after activation
    expect(versionChangedEvents).toHaveLength(1);
    expect(versionChangedEvents[0].clientId).toBe('test-client');
    expect(versionChangedEvents[0].activeVersion).toBe('2.0.0');
    expect(versionChangedEvents[0].reason).toBe('update');

    // completed event has activeVersion set
    expect(completedEvents[0].activeVersion).toBe('2.0.0');

    // Storage reflects the new active version
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.activeVersion).toBe('2.0.0');
    expect(entry?.installedVersions).toHaveLength(1);
    expect(entry?.installedVersions[0]?.isActive).toBe(true);
  });

  it('client.update rejects when the upstream feed refresh fails', async () => {
    const failingDeps = makeStrategyDeps();
    (failingDeps.fetchText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    await initManager(failingDeps);

    await expect(bus.request(ClientSubjects.update, { clientId: 'test-client' })).rejects.toThrow(
      "client.update: failed to resolve latest version for client 'test-client'",
    );
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

    await initManager(makeStrategyDeps({ latestVersion: '2.0.0' }));

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

    // Install two versions — waitForCompletion ensures per-client lock release
    let completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' });
    await completion;
    completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.1.0' });
    await completion;

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const result = await bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: '1.0.0' });

    cleanupChanged();

    expect(result.clientId).toBe('test-client');
    expect(result.activeVersion).toBe('1.0.0');

    expect(versionChangedEvents).toHaveLength(1);
    expect(versionChangedEvents[0].activeVersion).toBe('1.0.0');
    expect(versionChangedEvents[0].reason).toBe('set-active');
  });

  it('client.setActive rejects when the requested version is not installed', async () => {
    await initManager(makeStrategyDeps());
    await expect(bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: '99.0.0' })).rejects.toThrow(
      'not installed',
    );
  });

  it('client.setActive rejects a stored installPath that points at another in-base client directory', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: expectedInstallPath('other-client', '1.0.0'),
      installedAt: now,
      createdAt: now,
    });

    await initManager(makeStrategyDeps());

    await expect(bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: '1.0.0' })).rejects.toThrow(
      'does not match the expected install directory',
    );
  });

  it('client.setActive accepts a stored installPath below the expected client version directory', async () => {
    const nestedInstallPath = path.join(expectedInstallPath('test-client', '1.0.0'), 'package');
    const executablePath = path.join(nestedInstallPath, 'bin', 'test-client');
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(executablePath, '#!/bin/sh\n');
    const realNestedInstallPath = await fs.realpath(nestedInstallPath);
    const realExecutablePath = await fs.realpath(executablePath);

    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: nestedInstallPath,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    (strategyDeps.exec as ReturnType<typeof vi.fn>).mockResolvedValue('1.0.0');
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: '1.0.0' });

    expect(result.activeVersion).toBe('1.0.0');
    expect(strategyDeps.exec).toHaveBeenCalledWith(realExecutablePath, ['--version'], {
      cwd: realNestedInstallPath,
    });
  });

  it('client.setActive rejects a symlinked installPath that resolves outside the expected version directory', async () => {
    const expectedRoot = expectedInstallPath('test-client', '1.0.0');
    const outsideTarget = path.join(testBasePath, 'outside-target');
    const symlinkInstallPath = path.join(expectedRoot, 'linked-package');
    await fs.mkdir(expectedRoot, { recursive: true });
    await fs.mkdir(outsideTarget, { recursive: true });
    await fs.symlink(outsideTarget, symlinkInstallPath, 'dir');

    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: symlinkInstallPath,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    await expect(bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: '1.0.0' })).rejects.toThrow(
      'does not match the expected install directory',
    );
    expect(strategyDeps.exec).not.toHaveBeenCalled();
  });

  it('client.setActive does not emit version.changed when the active version does not change', async () => {
    await initManager(makeStrategyDeps({ latestVersion: '1.0.0' }));

    // Install and activate via update
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    // Set active to the already-active version
    await bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: '1.0.0' });

    cleanupChanged();

    expect(versionChangedEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // client.uninstall — removing the active version clears the active pointer
  // -------------------------------------------------------------------------

  it('client.uninstall active version sets activeVersion to null and emits version.changed', async () => {
    await initManager(makeStrategyDeps({ latestVersion: '1.0.0' }));

    // Install and activate — waitForCompletion is event-driven and ensures
    // the per-client lock is released before the uninstall request below.
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    cleanupChanged();

    expect(result.removedVersion).toBe('1.0.0');
    expect(result.activeVersion).toBeNull();

    expect(versionChangedEvents).toHaveLength(1);
    expect(versionChangedEvents[0].previousActiveVersion).toBe('1.0.0');
    expect(versionChangedEvents[0].activeVersion).toBeNull();
    expect(versionChangedEvents[0].reason).toBe('uninstall');

    // list shows empty
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.activeVersion).toBeNull();
    expect(entry?.installedVersions).toHaveLength(0);
  });

  it('client.uninstall non-active version does not change the active pointer', async () => {
    // Install 1.0.0 (not activated) using default deps
    await initManager(makeStrategyDeps({ latestVersion: '1.0.0' }));
    let completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' });
    await completion;

    // Destroy the first manager, reinitialize with deps that resolve 1.1.0 as latest
    await manager.destroy();
    manager = new ClientBinaryManager(
      bus,
      managerConfig(),
      makeDefinitionLookup(),
      makeStrategyDeps({ latestVersion: '1.1.0' }),
    );
    await manager.init();

    // Install and activate 1.1.0 via update — waitForCompletion ensures the
    // per-client lock is released before the uninstall request below.
    completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    const versionChangedEvents: ClientVersionChanged[] = [];
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    // Uninstall the non-active 1.0.0
    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    cleanupChanged();

    expect(result.removedVersion).toBe('1.0.0');
    expect(result.activeVersion).toBe('1.1.0');
    expect(versionChangedEvents).toHaveLength(0); // no version change for non-active uninstall
  });

  it('client.uninstall rejects when the version is not installed', async () => {
    await initManager(makeStrategyDeps());
    await expect(bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '99.0.0' })).rejects.toThrow(
      'not installed',
    );
  });

  // -------------------------------------------------------------------------
  // client.list — shows correct isActive flags
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // client.uninstall — filesystem cleanup (CF-1)
  // -------------------------------------------------------------------------

  it('client.uninstall calls removeDirectory with the install path after successful DB deletion', async () => {
    const strategyDeps = makeStrategyDeps({ latestVersion: '1.0.0' });
    await initManager(strategyDeps);

    // Install and activate 1.0.0 via update
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    expect(strategyDeps.removeDirectory).toHaveBeenCalledOnce();
    expect(strategyDeps.removeDirectory).toHaveBeenCalledWith(expectedInstallPath('test-client', '1.0.0'));
  });

  it('client.uninstall skips removeDirectory and still succeeds when installPath escapes basePath', async () => {
    // Directly seed storage with a tampered installPath that escapes the expected
    // <basePath>/<clientId> directory to verify the path-traversal guard.
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      // Escapes the managed-binary root and points at an unrelated directory.
      installPath: '/etc/cron.d',
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    // Uninstall must still succeed and clean up the storage row
    expect(result.removedVersion).toBe('1.0.0');
    // The dangerous removeDirectory call must be skipped entirely
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall skips cleanup when installPath is the managed-binary basePath', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: path.join(testBasePath, 'binaries'),
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    expect(result.removedVersion).toBe('1.0.0');
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall skips cleanup when installPath is empty', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: '',
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    expect(result.removedVersion).toBe('1.0.0');
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall removes storage but skips cleanup for another in-base client directory', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: expectedInstallPath('other-client', '1.0.0'),
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    expect(result.removedVersion).toBe('1.0.0');
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall allows cleanup below the expected client version directory', async () => {
    const nestedInstallPath = path.join(expectedInstallPath('test-client', '1.0.0'), 'package');
    await fs.mkdir(nestedInstallPath, { recursive: true });
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: nestedInstallPath,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    expect(result.removedVersion).toBe('1.0.0');
    expect(strategyDeps.removeDirectory).toHaveBeenCalledOnce();
    expect(strategyDeps.removeDirectory).toHaveBeenCalledWith(nestedInstallPath);
  });

  it('client.uninstall skips cleanup below a filesystem-root basePath when the install path is missing', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: '/test-client/1.0.0',
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps, { config: { basePath: '/', configBasePath: testBasePath } });

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    expect(result.removedVersion).toBe('1.0.0');
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall skips cleanup for a symlinked installPath that resolves outside the expected directory', async () => {
    const expectedRoot = expectedInstallPath('test-client', '1.0.0');
    const outsideTarget = path.join(testBasePath, 'outside-target');
    const symlinkInstallPath = path.join(expectedRoot, 'linked-package');
    await fs.mkdir(expectedRoot, { recursive: true });
    await fs.mkdir(outsideTarget, { recursive: true });
    await fs.symlink(outsideTarget, symlinkInstallPath, 'dir');

    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: symlinkInstallPath,
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    expect(result.removedVersion).toBe('1.0.0');
    expect(strategyDeps.removeDirectory).not.toHaveBeenCalled();
  });

  it('client.uninstall passes the normalized absolute install path to removeDirectory', async () => {
    await fs.mkdir(expectedInstallPath('test-client', '1.0.0'), { recursive: true });
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.0.0',
      installPath: path.join(testBasePath, 'binaries', 'test-client', '..', 'test-client', '1.0.0'),
      installedAt: now,
      createdAt: now,
    });

    const strategyDeps = makeStrategyDeps();
    await initManager(strategyDeps);

    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });

    expect(result.removedVersion).toBe('1.0.0');
    expect(strategyDeps.removeDirectory).toHaveBeenCalledOnce();
    expect(strategyDeps.removeDirectory).toHaveBeenCalledWith(expectedInstallPath('test-client', '1.0.0'));
  });

  it('client.uninstall still succeeds when removeDirectory throws', async () => {
    const strategyDeps = makeStrategyDeps({ latestVersion: '1.0.0' });
    (strategyDeps.removeDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ENOENT: no such file or directory'),
    );
    await initManager(strategyDeps);

    // Install 1.0.0
    const completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.update, { clientId: 'test-client' });
    await completion;

    // Uninstall should still resolve even though removeDirectory throws
    const result = await bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' });
    expect(result.removedVersion).toBe('1.0.0');
  });

  it('client.list shows isActive correctly for multiple installed versions', async () => {
    await initManager(makeStrategyDeps());

    // Install two versions — waitForCompletion ensures per-client lock release
    let completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' });
    await completion;
    completion = waitForCompletion(bus);
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.1.0' });
    await completion;

    // Activate 1.1.0
    await bus.request(ClientSubjects.setActive, { clientId: 'test-client', version: '1.1.0' });

    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.activeVersion).toBe('1.1.0');
    expect(entry?.installedVersions).toHaveLength(2);

    const v100 = entry?.installedVersions.find((v) => v.version === '1.0.0');
    const v110 = entry?.installedVersions.find((v) => v.version === '1.1.0');
    expect(v100?.isActive).toBe(false);
    expect(v110?.isActive).toBe(true);
  });

  // -------------------------------------------------------------------------
  // RT-5: client.install without explicit version (cache-miss live-fetch path)
  // -------------------------------------------------------------------------

  it('client.install without an explicit version performs a live feed fetch', async () => {
    // No version supplied → resolver has no cache entry → triggers a live fetch
    // via the strategy's resolveLatestVersion (fetchText mock returns '1.0.0').
    await initManager(makeStrategyDeps({ latestVersion: '1.0.0' }));

    const response = await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client' }),
    );

    expect(response.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.requestedVersion).toBeNull();
    expect(response.resolvedVersion).toBe('1.0.0');

    // Confirm the version was actually installed
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');
    expect(entry?.installedVersions.some((v) => v.version === '1.0.0')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TG-1: client.list with forceRefresh:true
  // -------------------------------------------------------------------------

  it('client.list with forceRefresh:true updates latestAvailableVersion on success', async () => {
    await initManager(makeStrategyDeps({ latestVersion: '3.0.0' }));

    const listResult = await bus.request(ClientSubjects.list, { forceRefresh: true });
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.latestAvailableVersion).toBe('3.0.0');
    expect(entry?.latestVersionSourceStatus).toBe('fresh');
  });

  it('client.list with forceRefresh:true returns cached data with error status when refresh fails', async () => {
    // Seed the version resolver with a prior known-good version via a
    // successful install so that storage holds a latestAvailableVersion.
    const workingDeps = makeStrategyDeps({ latestVersion: '2.0.0' });
    await initManager(workingDeps);

    // Perform a successful forceRefresh to seed storage with latestAvailableVersion.
    await bus.request(ClientSubjects.list, { forceRefresh: true });

    // Destroy the manager and recreate with a failing feed so the resolver
    // re-hydrates from storage and the forceRefresh attempt fails.
    await manager.destroy();
    const failingDeps = makeStrategyDeps();
    (failingDeps.fetchText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Feed unavailable'));
    manager = new ClientBinaryManager(bus, managerConfig(), makeDefinitionLookup(), failingDeps);
    await manager.init();

    // forceRefresh fails but Promise.allSettled ensures list still returns.
    const listResult = await bus.request(ClientSubjects.list, { forceRefresh: true });
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    // The refresh failed — status is error and the cached version is preserved.
    expect(entry?.latestVersionSourceStatus).toBe('error');
    expect(entry?.latestAvailableVersion).toBe('2.0.0');
  });

  it('client.list with forceRefresh:true preserves cached feed metadata when the descriptor is missing', async () => {
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.upsertState, {
      clientId: 'test-client',
      activeVersion: null,
      latestAvailableVersion: '2.0.0',
      latestVersionLastCheckedAt: now,
      latestVersionSourceStatus: 'cached',
      updatedAt: now,
    });

    const emptyLookup: ClientDefinitionLookup = {
      getDefinition: () => undefined,
      listDefinitions: () => [],
    };
    const strategyDeps = makeStrategyDeps({ latestVersion: '99.0.0' });
    manager = new ClientBinaryManager(bus, managerConfig(), emptyLookup, strategyDeps);
    await manager.init();

    const listResult = await bus.request(ClientSubjects.list, { forceRefresh: true });
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.latestAvailableVersion).toBe('2.0.0');
    expect(entry?.latestVersionLastCheckedAt).toBe(now);
    expect(entry?.latestVersionSourceStatus).toBe('error');
    expect(strategyDeps.fetchText).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // TG-2: Manager hydration from storage (post-restart)
  // -------------------------------------------------------------------------

  it('a freshly initialized manager returns seeded state from storage without a live fetch', async () => {
    // Populate storage directly via bus handlers before the manager is created.
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.insertVersion, {
      id: crypto.randomUUID(),
      clientId: 'test-client',
      version: '1.5.0',
      installPath: expectedInstallPath('test-client', '1.5.0'),
      installedAt: now,
      createdAt: now,
    });
    await bus.request(ClientBinaryStorageSubjects.upsertState, {
      clientId: 'test-client',
      activeVersion: '1.5.0',
      latestAvailableVersion: '1.5.0',
      latestVersionLastCheckedAt: now,
      latestVersionSourceStatus: 'cached',
      updatedAt: now,
    });

    // Create a fresh manager with a feed that would return a different version
    // if contacted — verifying that no live fetch occurs during init.
    const strategyDeps = makeStrategyDeps({ latestVersion: '99.0.0' });
    manager = new ClientBinaryManager(bus, managerConfig(), makeDefinitionLookup(), strategyDeps);
    await manager.init();

    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.activeVersion).toBe('1.5.0');
    expect(entry?.installedVersions).toHaveLength(1);
    expect(entry?.installedVersions[0]?.version).toBe('1.5.0');
    // The feed was seeded from storage — no live fetch happened, so the value
    // reflects the persisted cached version, not the mock's '99.0.0'.
    expect(entry?.latestAvailableVersion).toBe('1.5.0');
    expect(strategyDeps.fetchText).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // TG-3: updateAvailable flag
  // -------------------------------------------------------------------------

  it('client.list returns updateAvailable:true when active version differs from latestAvailableVersion', async () => {
    // Install 1.0.0 and activate it via update (which sets it as active).
    await initManager(makeStrategyDeps({ latestVersion: '1.0.0' }));
    await requestAndWaitForCompletion(bus, () => bus.request(ClientSubjects.update, { clientId: 'test-client' }));

    // Reinitialize with a newer latestVersion so that the feed cache reports 2.0.0.
    await manager.destroy();
    const updatedDeps = makeStrategyDeps({ latestVersion: '2.0.0' });
    manager = new ClientBinaryManager(bus, managerConfig(), makeDefinitionLookup(), updatedDeps);
    await manager.init();

    // Force a refresh so the resolver learns about 2.0.0.
    const listResult = await bus.request(ClientSubjects.list, { forceRefresh: true });
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.activeVersion).toBe('1.0.0');
    expect(entry?.latestAvailableVersion).toBe('2.0.0');
    expect(entry?.updateAvailable).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TG-4: client.update concurrent-job rejection
  // -------------------------------------------------------------------------

  it('client.update rejects while an install job is in progress for the same client', async () => {
    await initManager(makeStrategyDeps({ latestVersion: '1.0.0', executeDelayMs: 100 }));

    // Start listening before the install so we can wait for it to complete.
    const completion = waitForCompletion(bus);

    // Start a long-running install job.
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' });

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
    await initManager(makeStrategyDeps({ latestVersion: '1.0.0', executeDelayMs: 100 }));

    // Start listening before the install so we can wait for it to complete.
    const completion = waitForCompletion(bus);

    // Start a long-running install job.
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' });

    // While the install is still running, client.uninstall should be rejected.
    await expect(bus.request(ClientSubjects.uninstall, { clientId: 'test-client', version: '1.0.0' })).rejects.toThrow(
      'already in progress',
    );

    await completion; // let the first job finish
  });

  // -------------------------------------------------------------------------
  // cancelAll cancellation invariant — no callbacks fire after destroy
  // -------------------------------------------------------------------------

  it('cancelAll() prevents completed and version.changed callbacks when destroy races an in-flight job', async () => {
    // Use a long enough delay so the job is guaranteed to still be running when
    // manager.destroy() is called synchronously after the install request.
    await initManager(makeStrategyDeps({ latestVersion: '1.0.0', executeDelayMs: 80 }));

    const completedEvents: ClientInstallCompleted[] = [];
    const versionChangedEvents: ClientVersionChanged[] = [];

    const cleanupCompleted = subscribeCapture(bus, ClientSubjects.installJob.completed, completedEvents);
    const cleanupChanged = subscribeCapture(bus, ClientSubjects.version.changed, versionChangedEvents);

    // Start an install that will remain in-flight for ~80 ms.
    await bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' });

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
  // Feed metadata persistence on implicit latest install (RT-5 storage side)
  // -------------------------------------------------------------------------

  it('client.install without explicit version persists feed metadata to storage', async () => {
    await initManager(makeStrategyDeps({ latestVersion: '1.0.0' }));

    await requestAndWaitForCompletion(bus, () => bus.request(ClientSubjects.install, { clientId: 'test-client' }));

    // The feed cache must have been written to storage during the implicit feed fetch.
    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    expect(entry?.latestAvailableVersion).toBe('1.0.0');
    expect(entry?.latestVersionLastCheckedAt).not.toBeNull();
    expect(entry?.latestVersionSourceStatus).toBe('fresh');
  });

  it('client.install with explicit version does not overwrite latestAvailableVersion in storage', async () => {
    // Seed storage so there is an existing feed entry to protect.
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.upsertState, {
      clientId: 'test-client',
      activeVersion: null,
      latestAvailableVersion: '2.0.0',
      latestVersionLastCheckedAt: now,
      latestVersionSourceStatus: 'cached',
      updatedAt: now,
    });

    await initManager(makeStrategyDeps({ latestVersion: '99.0.0' }));

    // Install a pinned version — no implicit feed fetch should occur.
    await requestAndWaitForCompletion(bus, () =>
      bus.request(ClientSubjects.install, { clientId: 'test-client', version: '1.0.0' }),
    );

    const listResult = await bus.request(ClientSubjects.list, {});
    const entry = listResult.clients.find((c) => c.clientId === 'test-client');

    // Feed metadata seeded from storage must be unchanged — no implicit fetch occurred.
    expect(entry?.latestAvailableVersion).toBe('2.0.0');
  });

  // -------------------------------------------------------------------------
  // RT-12: client.update when feed refresh fails with a cached version
  // -------------------------------------------------------------------------

  it('client.update rejects even when a cached version exists but the feed refresh fails', async () => {
    // Seed storage with a known-good version so the resolver hydrates from it.
    const now = Date.now();
    await bus.request(ClientBinaryStorageSubjects.upsertState, {
      clientId: 'test-client',
      activeVersion: null,
      latestAvailableVersion: '1.0.0',
      latestVersionLastCheckedAt: now,
      latestVersionSourceStatus: 'cached',
      updatedAt: now,
    });

    // Initialize manager with a failing feed — the resolver will seed from storage
    // (version '1.0.0' cached) but the live refresh required by update will fail.
    const failingDeps = makeStrategyDeps();
    (failingDeps.fetchText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    await initManager(failingDeps);

    // client.update always forces a live refresh and must not fall back to the
    // cached version — callers expect the update to reflect the current upstream state.
    await expect(bus.request(ClientSubjects.update, { clientId: 'test-client' })).rejects.toThrow(
      "client.update: failed to resolve latest version for client 'test-client'",
    );
  });
});
