import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowWorkerConfig } from '@makaio/contracts';
import type { ThinWorkflowPiscinaRunnerOptions } from '../types.js';
import { createWorkflowWorkerReadyMessage } from '../worker-ready-message.js';
import { acceptPiscinaBootstrapHandoff, type PiscinaBootstrapBinding } from '../piscina-bootstrap-handoff.js';

// Mock PiscinaPoolRunner before importing the class under test.
const mockPoolRun = vi.fn();
const mockMessageListeners = new Set<(message: unknown) => void>();
const mockMaterializeLocalDirectory = vi.fn();

vi.mock('../runtime/piscina-pool-runner.js', () => ({
  PiscinaPoolRunner: class MockPiscinaPoolRunner {
    public constructor(_options: ThinWorkflowPiscinaRunnerOptions) {}

    public run = mockPoolRun;
    public onMessage(listener: (message: unknown) => void): () => void {
      mockMessageListeners.add(listener);
      return () => mockMessageListeners.delete(listener);
    }
    public dispose = vi.fn();
  },
}));

vi.mock('../local-directory-materializer.js', () => ({
  materializeLocalDirectory: mockMaterializeLocalDirectory,
}));

// Import after mocking
const { ThinWorkflowPiscinaRunner } = await import('../thin-workflow-piscina-runner.js');

/** Attempt every readiness-aware dispatch below binds its worker thread to. */
const TEST_ATTEMPT_ID = 'attempt-readiness';

/**
 * Create a minimal WorkflowWorkerConfig for testing.
 * @param overrides - Optional config fields to replace in the fixture.
 * @returns A valid WorkflowWorkerConfig stub.
 */
function makeConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'test-workflow' },
    executionId: 'test-exec',
    workflowId: 'test-workflow',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    env: {},
    coordinatorSessionId: 'test-session',
    cancelSubject: 'workflow.cancel.test',
    suspensionStrategy: 'wait-in-process',
    ...overrides,
  };
}

/**
 * Create default runner options for testing.
 * @returns ThinWorkflowPiscinaRunnerOptions with test values.
 */
function makeOptions(): ThinWorkflowPiscinaRunnerOptions {
  return {
    workerEntry: '/path/to/workflow-worker-entry.mjs',
    manifest: { contributionRefs: [] },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

/**
 * Create a promise whose settlement is controlled by the test.
 * @returns Deferred promise controls.
 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/**
 * Emit a mocked Piscina worker message to all active listeners.
 * @param message - Message payload to deliver.
 */
function emitPoolMessage(message: unknown): void {
  for (const listener of mockMessageListeners) {
    listener(message);
  }
}

describe('ThinWorkflowPiscinaRunner', () => {
  beforeEach(() => {
    mockPoolRun.mockReset();
    mockMaterializeLocalDirectory.mockReset();
    mockMessageListeners.clear();
  });

  it('expires while resolving host source files and cannot dispatch after the resolver completes late', async () => {
    const materializer = await vi.importActual<typeof import('../local-directory-materializer.js')>(
      '../local-directory-materializer.js',
    );
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'piscina-bootstrap-budget-'));
    const root = createDeferred<string>();
    const resolverStarted = createDeferred<void>();
    const materialized = createDeferred<void>();
    const runner = new ThinWorkflowPiscinaRunner({
      ...makeOptions(),
      resolveWorkspaceRoot: async () => {
        resolverStarted.resolve();
        return root.promise;
      },
    });
    try {
      await writeFile(join(workspaceRoot, 'workflow.mjs'), 'export default {};');
      const rootDigest = await materializer.computeDirectoryDigest(workspaceRoot);
      mockMaterializeLocalDirectory.mockImplementationOnce(
        async (...args: Parameters<typeof materializer.materializeLocalDirectory>) => {
          try {
            return await materializer.materializeLocalDirectory(...args);
          } finally {
            materialized.resolve();
          }
        },
      );
      vi.useFakeTimers();
      const run = runner.runWithReadiness(
        makeConfig({
          source: { kind: 'path', path: 'workflow.mjs' },
          materializationSpec: {
            kind: 'local-directory',
            workspaceId: 'workspace',
            rootDigest,
            sourcePath: 'workflow.mjs',
          },
        }),
        new AbortController().signal,
        undefined,
        {
          executionAttemptId: TEST_ATTEMPT_ID,
          bootstrapDeadlineAt: new Date(Date.now() + 1000).toISOString(),
        },
      );
      const settlements = Promise.allSettled([run.result, run.ready]);
      await resolverStarted.promise;
      expect(mockMessageListeners.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await settlements).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ code: 'WORKER_BOOTSTRAP_DEADLINE_EXCEEDED' }) },
        { status: 'rejected', reason: expect.objectContaining({ code: 'WORKER_BOOTSTRAP_DEADLINE_EXCEEDED' }) },
      ]);
      expect(mockMessageListeners.size).toBe(0);
      expect(mockPoolRun).not.toHaveBeenCalled();
      root.resolve(workspaceRoot);
      await materialized.promise;
      await Promise.resolve();
      expect(mockPoolRun).not.toHaveBeenCalled();
      expect(mockMessageListeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
      root.resolve(workspaceRoot);
      if (mockMaterializeLocalDirectory.mock.calls.length > 0) await materialized.promise;
      await runner.dispose();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { bootstrapDeadlineAt: 'not-a-timestamp', message: 'valid absolute ISO timestamp' },
    { bootstrapDeadlineAt: '2000-01-01T00:00:00.000Z', message: 'bootstrap deadline exceeded' },
  ])('rejects both readiness and result without leaking a listener for $bootstrapDeadlineAt', async ({
    bootstrapDeadlineAt,
    message,
  }) => {
    const runner = new ThinWorkflowPiscinaRunner(makeOptions());
    try {
      const run = runner.runWithReadiness(makeConfig(), new AbortController().signal, undefined, {
        executionAttemptId: TEST_ATTEMPT_ID,
        bootstrapDeadlineAt,
      });
      const result = expect(run.result).rejects.toThrow(message);
      const ready = expect(run.ready).rejects.toThrow(message);
      await Promise.all([result, ready]);
      expect(mockMessageListeners.size).toBe(0);
      expect(mockMaterializeLocalDirectory).not.toHaveBeenCalled();
      expect(mockPoolRun).not.toHaveBeenCalled();
    } finally {
      await runner.dispose();
    }
  });

  it('passes config and construction-time manifest to pool.run()', async () => {
    const expectedResult = {
      executionId: 'test-exec',
      workflowId: 'test-workflow',
      status: 'completed',
    };
    mockPoolRun.mockResolvedValueOnce(expectedResult);

    const options = makeOptions();
    const runner = new ThinWorkflowPiscinaRunner(options);
    const config = makeConfig();
    const signal = new AbortController().signal;

    const result = await runner.run(config, signal);

    expect(mockPoolRun).toHaveBeenCalledOnce();
    expect(mockPoolRun).toHaveBeenCalledWith(
      { kind: 'unbound', config, manifest: options.manifest, contributionEntrypoints: [] },
      signal,
    );
    expect(result).toEqual({ state: 'uncommitted', result: expectedResult });
  });

  it('materializes a local-directory source and verified contributions before dispatching to Piscina', async () => {
    const expectedResult = {
      executionId: 'test-exec',
      workflowId: 'test-workflow',
      status: 'completed' as const,
    };
    const manifest = {
      contributionRefs: [
        {
          packageName: 'pkg-a',
          version: '1.0.0',
          entrypoint: 'dist/worker.mjs',
          integrity: 'sha384-verified',
        },
      ],
    };
    const config = makeConfig({
      source: { kind: 'path', path: 'workflows/example.mjs' },
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'workspace-a',
        rootDigest: 'sha256-workspace',
        sourcePath: 'workflows/example.mjs',
      },
    });
    const resolveWorkspaceRoot = vi.fn().mockResolvedValue('/workspace-a');
    mockMaterializeLocalDirectory.mockResolvedValueOnce({
      workspaceRoot: '/workspace-a',
      sourcePath: '/workspace-a/workflows/example.mjs',
      contributionEntrypoints: ['/workspace-a/node_modules/pkg-a/dist/worker.mjs'],
      platform: 'linux',
      arch: 'x64',
    });
    mockPoolRun.mockResolvedValueOnce(expectedResult);

    const runner = new ThinWorkflowPiscinaRunner({ ...makeOptions(), resolveWorkspaceRoot });
    await runner.run(config, new AbortController().signal, manifest);

    expect(mockMaterializeLocalDirectory).toHaveBeenCalledWith(config.materializationSpec, manifest.contributionRefs, {
      resolveWorkspaceRoot,
    });
    expect(mockPoolRun).toHaveBeenCalledWith(
      {
        kind: 'unbound',
        config: {
          ...config,
          source: { kind: 'path', path: '/workspace-a/workflows/example.mjs' },
        },
        manifest,
        contributionEntrypoints: ['/workspace-a/node_modules/pkg-a/dist/worker.mjs'],
      },
      expect.any(AbortSignal),
    );
  });

  it('requires a local-directory realization for declared contributions', async () => {
    const expectedResult = {
      executionId: 'test-exec',
      workflowId: 'test-workflow',
      status: 'completed',
    };
    mockPoolRun.mockResolvedValueOnce(expectedResult);

    const runner = new ThinWorkflowPiscinaRunner(makeOptions());
    const config = makeConfig();
    const signal = new AbortController().signal;
    const perCallManifest = {
      contributionRefs: [
        {
          packageName: 'pkg-a',
          version: '1.0.0',
          entrypoint: 'pkg-a.js',
          integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uFPNZHzA3w0=',
        },
      ],
    };

    await expect(runner.run(config, signal, perCallManifest)).rejects.toThrow(
      'requires a local-directory materialization spec',
    );
    expect(mockPoolRun).not.toHaveBeenCalled();
  });

  it('propagates abort signal to pool.run()', async () => {
    const controller = new AbortController();
    mockPoolRun.mockRejectedValueOnce(new Error('The task was aborted'));

    const runner = new ThinWorkflowPiscinaRunner(makeOptions());
    controller.abort();

    await expect(runner.run(makeConfig(), controller.signal)).rejects.toThrow('aborted');
    expect(mockPoolRun).not.toHaveBeenCalled();
  });

  it('propagates pool.run() rejection to caller', async () => {
    const error = new Error('Worker thread crashed');
    mockPoolRun.mockRejectedValueOnce(error);

    const runner = new ThinWorkflowPiscinaRunner(makeOptions());

    await expect(runner.run(makeConfig(), new AbortController().signal)).rejects.toThrow('Worker thread crashed');
  });

  it('dispatches an attempt-bound task when readiness is requested', async () => {
    mockPoolRun.mockResolvedValueOnce({ executionId: 'test-exec', workflowId: 'test-workflow', status: 'completed' });
    const runner = new ThinWorkflowPiscinaRunner(makeOptions());
    const bootstrapDeadlineAt = new Date(Date.now() + 120_000).toISOString();

    const run = runner.runWithReadiness(makeConfig(), new AbortController().signal, undefined, {
      executionAttemptId: TEST_ATTEMPT_ID,
      bootstrapDeadlineAt,
    });
    // This worker exits without taking bootstrap ownership. Both public
    // promises reject instead of waiting for readiness until deadline expiry.
    await expect(run.ready).rejects.toThrow('completed before bootstrap handoff');
    await expect(run.result).rejects.toThrow('completed before bootstrap handoff');

    // The attempt identity travels as its own task shape, so the attempt-free
    // `run()` task never carries an empty attempt field.
    expect(mockPoolRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'attempt-bound', executionAttemptId: TEST_ATTEMPT_ID, bootstrapDeadlineAt }),
      expect.anything(),
      expect.any(Array),
    );
  });

  it('resolves readiness from the matching worker ready message', async () => {
    const result = createDeferred<{ executionId: string; workflowId: string; status: 'completed' }>();
    mockPoolRun.mockImplementationOnce(async (binding: PiscinaBootstrapBinding) => {
      await acceptPiscinaBootstrapHandoff(binding);
      return result.promise;
    });
    const runner = new ThinWorkflowPiscinaRunner(makeOptions());
    const config = makeConfig();

    const run = runner.runWithReadiness(config, new AbortController().signal, undefined, {
      executionAttemptId: TEST_ATTEMPT_ID,
      bootstrapDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
    });

    emitPoolMessage(createWorkflowWorkerReadyMessage('other-exec', config.cancelSubject, TEST_ATTEMPT_ID));
    await expect(Promise.race([run.ready.then(() => 'ready'), Promise.resolve('pending')])).resolves.toBe('pending');

    // Another attempt's thread reporting on the same pool is a correlation
    // miss, not this dispatch's readiness.
    emitPoolMessage(createWorkflowWorkerReadyMessage(config.executionId, config.cancelSubject, 'attempt-elsewhere'));
    await expect(Promise.race([run.ready.then(() => 'ready'), Promise.resolve('pending')])).resolves.toBe('pending');

    emitPoolMessage(createWorkflowWorkerReadyMessage(config.executionId, config.cancelSubject, TEST_ATTEMPT_ID));
    await expect(run.ready).resolves.toMatchObject({ executionAttemptId: TEST_ATTEMPT_ID });
    result.resolve({ executionId: config.executionId, workflowId: config.workflowId, status: 'completed' });
    await expect(run.result).resolves.toMatchObject({ status: 'completed' });
  });

  it('rejects readiness when the worker result rejects before ready', async () => {
    const error = new Error('worker crashed');
    mockPoolRun.mockRejectedValueOnce(error);
    const runner = new ThinWorkflowPiscinaRunner(makeOptions());

    const run = runner.runWithReadiness(makeConfig(), new AbortController().signal, undefined, {
      executionAttemptId: TEST_ATTEMPT_ID,
      bootstrapDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
    });

    await expect(run.ready).rejects.toThrow('worker crashed');
    await expect(run.result).rejects.toBe(error);
  });

  it('rejects readiness when the worker completes before ready', async () => {
    mockPoolRun.mockImplementationOnce(async (binding: PiscinaBootstrapBinding) => {
      await acceptPiscinaBootstrapHandoff(binding);
      return { executionId: 'test-exec', workflowId: 'test-workflow', status: 'completed' };
    });
    const runner = new ThinWorkflowPiscinaRunner(makeOptions());

    const run = runner.runWithReadiness(makeConfig(), new AbortController().signal, undefined, {
      executionAttemptId: TEST_ATTEMPT_ID,
      bootstrapDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
    });

    await expect(run.ready).rejects.toThrow('Workflow worker completed before ready signal: test-exec');
    await expect(run.result).resolves.toMatchObject({ status: 'completed' });
  });
});
