/**
 * Tests for {@link ClientBinaryJobRunner}.
 *
 * The runner is tested in isolation: strategy I/O dependencies are mocked so
 * no real network or file-system operations occur. The typed callbacks
 * (onProgress, onComplete, onCompleted) are provided directly so the manager
 * layer is not involved.
 *
 * Coverage:
 * - A throwing `onProgress` callback does not fail the install — the job
 *   completes successfully and `onCompleted` fires with `status: 'success'`.
 * - Staged artifacts are removed when pre-persistence validation fails.
 * - The `activating` progress stage is emitted when `makeActive` is `true`.
 * - The `activating` stage is NOT emitted when `makeActive` is `false`.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientInstallCompleted, ClientInstallProgress } from '@makaio/contracts/client';
import { ClientBinaryJobRunner } from '../client-binary-job-runner.js';
import type {
  JobCompletedCallback,
  JobCompletionCallback,
  JobProgressCallback,
  PostInstallHandler,
} from '../client-binary-manager-types.js';
import type { StrategyDependencies } from '../binary-strategies/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_PATH = '/opt/test/binaries';
const CHECKSUM = 'abc123';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build mock strategy dependencies that simulate a successful install.
 * @param options - Optional overrides for behaviour
 * @returns Mocked strategy dependencies
 */
function makeStrategyDeps(
  options: {
    /** Delay in milliseconds to simulate an async install. */
    executeDelayMs?: number;
  } = {},
): StrategyDependencies {
  const { executeDelayMs = 0 } = options;

  return {
    fetchText: vi.fn().mockResolvedValue('1.0.0'),
    fetchJson: vi.fn().mockResolvedValue({ sha256: CHECKSUM }),
    downloadFile: vi.fn().mockImplementation(async (_url: string, dest: string) => {
      if (executeDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, executeDelayMs));
      }
      return dest;
    }),
    computeChecksum: vi.fn().mockResolvedValue(CHECKSUM),
    extractArchive: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    removeDirectory: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue(''),
  };
}

/**
 * Build a minimal manifest-bucket install descriptor for use in tests.
 * @returns A typed manifest-bucket managed install descriptor
 */
function makeManifestBucketDescriptor() {
  return {
    type: 'manifest-bucket' as const,
    config: {
      baseUrl: 'https://example.com/test-client',
      versionIndex: { latest: 'latest.txt' },
      manifestPath: 'manifest.json',
      manifestChecksumField: 'sha256',
      binaryPath: 'bin/test-client',
    },
  };
}

/**
 * Return type for {@link createPostInstallFailureHarness}.
 */
interface PostInstallFailureHarness {
  /** Runner wired with the provided postInstallHandlers (or none). */
  runner: ClientBinaryJobRunner;
  /** Mocked I/O dependencies forwarded to the runner's strategy. */
  strategyDeps: ReturnType<typeof makeStrategyDeps>;
  /** Spy for install-progress events. */
  onProgress: JobProgressCallback;
  /** Spy for the persistence callback — always resolves successfully. */
  onComplete: JobCompletionCallback;
  /** Spy for the completion event that also accumulates payloads. */
  onCompleted: JobCompletedCallback;
  /** Resolves when the terminal completion callback fires. */
  completed: Promise<void>;
  /** Accumulated completion payloads in arrival order. */
  completedPayloads: Array<{ status: string; error?: { message: string } }>;
}

/**
 * Build the shared setup used by both post-install failure tests.
 *
 * Each test provides its own {@link postInstallHandlers} map (or none) so the
 * distinct failure path — missing handler vs. throwing handler — can be
 * exercised independently without repeating callback and runner construction.
 * @param postInstallHandlers - Optional handlers map forwarded to the runner config
 * @returns Fully wired harness objects ready for `startJob`
 */
function createPostInstallFailureHarness(
  postInstallHandlers?: ReadonlyMap<string, PostInstallHandler>,
): PostInstallFailureHarness {
  const completedPayloads: Array<{ status: string; error?: { message: string } }> = [];

  const onProgress: JobProgressCallback = vi.fn();
  const onComplete: JobCompletionCallback = vi.fn().mockResolvedValue(undefined);
  const { onCompleted, completed } = createCompletionSpy(completedPayloads);

  const strategyDeps = makeStrategyDeps();
  const runner = new ClientBinaryJobRunner(strategyDeps, {
    basePath: BASE_PATH,
    configBasePath: BASE_PATH,
    ...(postInstallHandlers !== undefined && { postInstallHandlers }),
  });

  return { runner, strategyDeps, onProgress, onComplete, onCompleted, completed, completedPayloads };
}

/**
 * Build a minimal running install job.
 * @param overrides - Optional field overrides
 * @returns A typed install job
 */
function makeJob(
  overrides: {
    makeActive?: boolean;
    version?: string;
  } = {},
): Parameters<typeof ClientBinaryJobRunner.prototype.startJob>[0] {
  return {
    jobId: 'test-job-id',
    clientId: 'test-client',
    version: overrides.version ?? '1.0.0',
    strategy: 'manifest-bucket',
    status: 'pending',
    makeActive: overrides.makeActive ?? false,
    reason: 'install',
  };
}

/**
 * Create a completion callback that resolves when the async runner reaches a terminal state.
 * @param completedPayloads - Optional payload accumulator.
 * @returns Completion callback and terminal-state promise.
 */
function createCompletionSpy<TPayload extends object = ClientInstallCompleted>(
  completedPayloads: TPayload[] = [],
): {
  /** Completion callback passed to the runner. */
  onCompleted: JobCompletedCallback;
  /** Resolves after the first completion payload is recorded. */
  completed: Promise<void>;
} {
  let resolveCompleted!: () => void;
  const timeoutMs = 2_000;
  let timeout: ReturnType<typeof setTimeout>;
  const completed = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for onCompleted after ${timeoutMs}ms`));
    }, timeoutMs);
    resolveCompleted = resolve;
  });
  const onCompleted: JobCompletedCallback = vi.fn().mockImplementation(async (payload) => {
    completedPayloads.push(payload as TPayload);
    clearTimeout(timeout);
    resolveCompleted();
  });
  return { onCompleted, completed };
}

/**
 * Wait for the next event-loop turn so cancellation-only tests can settle.
 * @param rounds - Number of setTimeout(0) rounds to flush
 */
async function flushAsync(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ClientBinaryJobRunner', () => {
  let runner: ClientBinaryJobRunner;

  beforeEach(() => {
    runner = new ClientBinaryJobRunner(makeStrategyDeps(), { basePath: BASE_PATH, configBasePath: BASE_PATH });
  });

  afterEach(() => {
    runner.cancelAll();
  });

  it('removes the installed artifact when persistence rejects the completed install', async () => {
    const strategyDeps = makeStrategyDeps();
    const cleanupRunner = new ClientBinaryJobRunner(strategyDeps, { basePath: BASE_PATH, configBasePath: BASE_PATH });
    const completedPayloads: ClientInstallCompleted[] = [];

    const onProgress: JobProgressCallback = vi.fn();
    const onComplete: JobCompletionCallback = vi.fn().mockRejectedValue(new Error('storage write failed'));
    const { onCompleted, completed } = createCompletionSpy(completedPayloads);

    cleanupRunner.startJob(makeJob(), makeManifestBucketDescriptor(), onProgress, onComplete, onCompleted);

    await completed;

    expect(strategyDeps.removeDirectory).toHaveBeenCalledWith('/opt/test/binaries/test-client/1.0.0');
    expect(completedPayloads).toHaveLength(1);
    expect(completedPayloads[0]).toMatchObject({
      clientId: 'test-client',
      version: '1.0.0',
      status: 'error',
      activeVersion: null,
      error: { message: 'storage write failed' },
    });

    cleanupRunner.cancelAll();
  });

  it('removes the installed artifact from disk when persistence rejects the completed install', async () => {
    const tmpBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-runner-cleanup-'));
    const strategyDeps = {
      ...makeStrategyDeps(),
      downloadFile: vi.fn().mockImplementation(async (_url: string, dest: string) => {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, 'archive');
        return dest;
      }),
      removeDirectory: async (dirPath: string) => {
        await fs.rm(dirPath, { recursive: true, force: true });
      },
    } satisfies StrategyDependencies;
    const cleanupRunner = new ClientBinaryJobRunner(strategyDeps, {
      basePath: tmpBasePath,
      configBasePath: tmpBasePath,
    });
    const artifactPath = path.join(tmpBasePath, 'test-client', '1.0.0');

    try {
      const onProgress: JobProgressCallback = vi.fn();
      const onComplete: JobCompletionCallback = vi.fn().mockRejectedValue(new Error('storage write failed'));
      const { onCompleted, completed } = createCompletionSpy();

      cleanupRunner.startJob(makeJob(), makeManifestBucketDescriptor(), onProgress, onComplete, onCompleted);

      await completed;

      await expect(fs.stat(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      cleanupRunner.cancelAll();
      await fs.rm(tmpBasePath, { recursive: true, force: true });
    }
  });

  it('removes the staged artifact when version verification fails before persistence', async () => {
    const strategyDeps = makeStrategyDeps();
    const verifyingRunner = new ClientBinaryJobRunner(strategyDeps, { basePath: BASE_PATH, configBasePath: BASE_PATH });
    const completedPayloads: ClientInstallCompleted[] = [];

    const onProgress: JobProgressCallback = vi.fn();
    const onComplete: JobCompletionCallback = vi.fn().mockResolvedValue(undefined);
    const { onCompleted, completed } = createCompletionSpy(completedPayloads);

    verifyingRunner.startJob(
      makeJob(),
      makeManifestBucketDescriptor(),
      onProgress,
      onComplete,
      onCompleted,
      undefined,
      ['/usr/bin/test-client', '--version'],
    );

    await completed;

    expect(strategyDeps.removeDirectory).toHaveBeenCalledWith('/opt/test/binaries/test-client/1.0.0');
    expect(onComplete).not.toHaveBeenCalled();
    expect(completedPayloads).toHaveLength(1);
    expect(completedPayloads[0]).toMatchObject({
      clientId: 'test-client',
      version: '1.0.0',
      status: 'error',
      activeVersion: null,
      error: { message: 'versionCommand[0] must be a relative path; received absolute path "/usr/bin/test-client"' },
    });

    verifyingRunner.cancelAll();
  });

  // -------------------------------------------------------------------------
  // safeOnProgress — progress failures must not fail the install
  // -------------------------------------------------------------------------

  it('completes successfully even when the onProgress callback throws on every call', async () => {
    const completedPayloads: ClientInstallCompleted[] = [];

    const throwingOnProgress: JobProgressCallback = () => {
      throw new Error('Progress emission error');
    };

    const onComplete: JobCompletionCallback = vi.fn().mockResolvedValue(undefined);

    const { onCompleted, completed } = createCompletionSpy(completedPayloads);

    runner.startJob(makeJob(), makeManifestBucketDescriptor(), throwingOnProgress, onComplete, onCompleted);

    await completed;

    expect(completedPayloads).toHaveLength(1);
    expect(completedPayloads[0]?.status).toBe('success');
    expect(onComplete).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // activating stage
  // -------------------------------------------------------------------------

  it('emits the activating progress stage when makeActive is true', async () => {
    const progressPayloads: ClientInstallProgress[] = [];

    const onProgress: JobProgressCallback = (payload) => {
      progressPayloads.push(payload);
    };

    const onComplete: JobCompletionCallback = vi.fn().mockResolvedValue(undefined);
    const { onCompleted, completed } = createCompletionSpy();

    runner.startJob(makeJob({ makeActive: true }), makeManifestBucketDescriptor(), onProgress, onComplete, onCompleted);

    await completed;

    const activatingEvents = progressPayloads.filter((p) => p.stage === 'activating');
    expect(activatingEvents).toHaveLength(1);

    const activating = activatingEvents[0];
    expect(activating?.clientId).toBe('test-client');
    expect(activating?.activeAfterCompletion).toBe(true);
    expect(activating?.progress).toBeNull();
  });

  it('does NOT emit the activating progress stage when makeActive is false', async () => {
    const progressPayloads: ClientInstallProgress[] = [];

    const onProgress: JobProgressCallback = (payload) => {
      progressPayloads.push(payload);
    };

    const onComplete: JobCompletionCallback = vi.fn().mockResolvedValue(undefined);
    const { onCompleted, completed } = createCompletionSpy();

    runner.startJob(
      makeJob({ makeActive: false }),
      makeManifestBucketDescriptor(),
      onProgress,
      onComplete,
      onCompleted,
    );

    await completed;

    const activatingEvents = progressPayloads.filter((p) => p.stage === 'activating');
    expect(activatingEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // cancelAll() — in-flight callbacks must be suppressed after cancellation
  // -------------------------------------------------------------------------

  it('cancelAll suppresses onComplete and onCompleted for a job that is still in flight', async () => {
    // Use a delay so the job is still executing when cancelAll fires.
    const slowRunner = new ClientBinaryJobRunner(makeStrategyDeps({ executeDelayMs: 50 }), {
      basePath: BASE_PATH,
      configBasePath: BASE_PATH,
    });

    const onComplete: JobCompletionCallback = vi.fn().mockResolvedValue(undefined);
    const onCompleted: JobCompletedCallback = vi.fn().mockResolvedValue(undefined);
    const onProgress: JobProgressCallback = vi.fn();

    slowRunner.startJob(
      makeJob({ makeActive: false }),
      makeManifestBucketDescriptor(),
      onProgress,
      onComplete,
      onCompleted,
    );

    // Cancel before the delayed download resolves.
    slowRunner.cancelAll();

    // Flush well past the 50 ms delay to allow any in-flight async work to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await flushAsync();

    // Neither the persistence callback nor the completion event should fire.
    expect(onComplete).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('cancelAll from verifying progress suppresses exec, onComplete, and onCompleted', async () => {
    const strategyDeps = makeStrategyDeps();
    const verifyingRunner = new ClientBinaryJobRunner(strategyDeps, { basePath: BASE_PATH, configBasePath: BASE_PATH });

    const onProgress: JobProgressCallback = (payload) => {
      if (payload.stage === 'verifying' && payload.metadata?.['kind'] === 'version-command') {
        verifyingRunner.cancelAll();
      }
    };
    const onComplete: JobCompletionCallback = vi.fn().mockResolvedValue(undefined);
    const onCompleted: JobCompletedCallback = vi.fn().mockResolvedValue(undefined);

    verifyingRunner.startJob(
      makeJob(),
      makeManifestBucketDescriptor(),
      onProgress,
      onComplete,
      onCompleted,
      undefined,
      ['bin/test-client', '--version'],
    );

    await flushAsync();

    expect(strategyDeps.exec).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // resolvePostInstallHandler — missing handler throws
  // -------------------------------------------------------------------------

  it('cleans the staged artifact and emits status error when no handler is registered for postInstall', async () => {
    // Config has no postInstallHandlers registered at all.
    const {
      runner: runnerWithoutHandlers,
      strategyDeps,
      onProgress,
      onComplete,
      onCompleted,
      completed,
      completedPayloads,
    } = createPostInstallFailureHarness();

    try {
      const postInstall = { kind: 'unregistered-kind' };
      runnerWithoutHandlers.startJob(
        makeJob(),
        makeManifestBucketDescriptor(),
        onProgress,
        onComplete,
        onCompleted,
        postInstall,
      );

      await completed;

      expect(completedPayloads).toHaveLength(1);
      expect(completedPayloads[0]?.status).toBe('error');
      expect(completedPayloads[0]?.error?.message).toContain('unregistered-kind');
      // onComplete (persistence) must NOT be called when the job fails.
      expect(onComplete).not.toHaveBeenCalled();
      expect(strategyDeps.removeDirectory).toHaveBeenCalledWith('/opt/test/binaries/test-client/1.0.0');
    } finally {
      runnerWithoutHandlers.cancelAll();
    }
  });

  it('cleans the staged artifact and emits status error when the registered post-install handler throws', async () => {
    // A registered handler that throws — this exercises the runJob catch block
    // for the post-install failure path, distinct from the missing-handler case.
    const throwingHandler = vi.fn().mockRejectedValue(new Error('chmod failed: permission denied'));
    const {
      runner: runnerWithThrowingHandler,
      strategyDeps,
      onProgress,
      onComplete,
      onCompleted,
      completed,
      completedPayloads,
    } = createPostInstallFailureHarness(new Map([['set-permissions', throwingHandler]]));

    try {
      const postInstall = { kind: 'set-permissions' };
      runnerWithThrowingHandler.startJob(
        makeJob(),
        makeManifestBucketDescriptor(),
        onProgress,
        onComplete,
        onCompleted,
        postInstall,
      );

      await completed;

      expect(completedPayloads).toHaveLength(1);
      expect(completedPayloads[0]?.status).toBe('error');
      expect(completedPayloads[0]?.error?.message).toBe('chmod failed: permission denied');
      // Persistence must NOT be called — the binary failed post-install.
      expect(onComplete).not.toHaveBeenCalled();
      // The staged artifact must be cleaned up.
      expect(strategyDeps.removeDirectory).toHaveBeenCalledWith('/opt/test/binaries/test-client/1.0.0');
    } finally {
      runnerWithThrowingHandler.cancelAll();
    }
  });

  // -------------------------------------------------------------------------
  // activating stage precedes onComplete (activation logic)
  // -------------------------------------------------------------------------

  it('emits the activating stage before calling onComplete', async () => {
    const callOrder: string[] = [];

    const onProgress: JobProgressCallback = (payload) => {
      if (payload.stage === 'activating') {
        callOrder.push('activating');
      }
    };

    const onComplete: JobCompletionCallback = vi.fn().mockImplementation(async () => {
      callOrder.push('onComplete');
    });
    const { onCompleted, completed } = createCompletionSpy();

    runner.startJob(makeJob({ makeActive: true }), makeManifestBucketDescriptor(), onProgress, onComplete, onCompleted);

    await completed;

    const activatingIndex = callOrder.indexOf('activating');
    const onCompleteIndex = callOrder.indexOf('onComplete');
    expect(activatingIndex).toBeGreaterThanOrEqual(0);
    expect(onCompleteIndex).toBeGreaterThanOrEqual(0);
    expect(activatingIndex).toBeLessThan(onCompleteIndex);
  });
});
