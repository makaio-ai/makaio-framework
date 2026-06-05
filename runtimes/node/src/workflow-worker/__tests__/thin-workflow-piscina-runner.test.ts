import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowWorkerConfig } from '@makaio/contracts';
import type { ThinWorkflowPiscinaRunnerOptions } from '../types.js';
import { createWorkflowWorkerReadyMessage } from '../worker-ready-message.js';

// Mock PiscinaPoolRunner before importing the class under test.
const mockPoolRun = vi.fn();
const mockMessageListeners = new Set<(message: unknown) => void>();

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

// Import after mocking
const { ThinWorkflowPiscinaRunner } = await import('../thin-workflow-piscina-runner.js');

/**
 * Create a minimal WorkflowWorkerConfig for testing.
 * @returns A valid WorkflowWorkerConfig stub.
 */
function makeConfig(): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'test-workflow' },
    executionId: 'test-exec',
    workflowId: 'test-workflow',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    context: {
      repoPath: '/repo',
      makaioHome: '/home/.makaio',
      os: 'linux',
      arch: 'x64',
    },
    env: {},
    coordinatorSessionId: 'test-session',
    cancelSubject: 'workflow.cancel.test',
  };
}

/**
 * Create default runner options for testing.
 * @returns ThinWorkflowPiscinaRunnerOptions with test values.
 */
function makeOptions(): ThinWorkflowPiscinaRunnerOptions {
  return {
    workerEntry: '/path/to/workflow-worker-entry.mjs',
    manifest: { packages: [] },
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
    vi.clearAllMocks();
    mockMessageListeners.clear();
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
    expect(mockPoolRun).toHaveBeenCalledWith({ config, manifest: options.manifest }, signal);
    expect(result).toEqual(expectedResult);
  });

  it('passes per-call manifest override to pool.run()', async () => {
    const expectedResult = {
      executionId: 'test-exec',
      workflowId: 'test-workflow',
      status: 'completed',
    };
    mockPoolRun.mockResolvedValueOnce(expectedResult);

    const runner = new ThinWorkflowPiscinaRunner(makeOptions());
    const config = makeConfig();
    const signal = new AbortController().signal;
    const perCallManifest = { packages: [{ name: 'pkg-a', importPath: './pkg-a.js' }] };

    const result = await runner.run(config, signal, perCallManifest);

    expect(mockPoolRun).toHaveBeenCalledOnce();
    expect(mockPoolRun).toHaveBeenCalledWith({ config, manifest: perCallManifest }, signal);
    expect(result).toEqual(expectedResult);
  });

  it('propagates abort signal to pool.run()', async () => {
    const controller = new AbortController();
    mockPoolRun.mockRejectedValueOnce(new Error('The task was aborted'));

    const runner = new ThinWorkflowPiscinaRunner(makeOptions());
    controller.abort();

    await expect(runner.run(makeConfig(), controller.signal)).rejects.toThrow('aborted');
    expect(mockPoolRun).toHaveBeenCalledWith(expect.anything(), controller.signal);
  });

  it('propagates pool.run() rejection to caller', async () => {
    const error = new Error('Worker thread crashed');
    mockPoolRun.mockRejectedValueOnce(error);

    const runner = new ThinWorkflowPiscinaRunner(makeOptions());

    await expect(runner.run(makeConfig(), new AbortController().signal)).rejects.toThrow('Worker thread crashed');
  });

  it('resolves readiness from the matching worker ready message', async () => {
    const result = createDeferred<{ executionId: string; workflowId: string; status: 'completed' }>();
    mockPoolRun.mockReturnValueOnce(result.promise);
    const runner = new ThinWorkflowPiscinaRunner(makeOptions());
    const config = makeConfig();

    const run = runner.runWithReadiness(config, new AbortController().signal);

    emitPoolMessage(createWorkflowWorkerReadyMessage('other-exec', config.cancelSubject));
    await expect(Promise.race([run.ready.then(() => 'ready'), Promise.resolve('pending')])).resolves.toBe('pending');

    emitPoolMessage(createWorkflowWorkerReadyMessage(config.executionId, config.cancelSubject, ['adapter-a']));
    await expect(run.ready).resolves.toMatchObject({ adapters: ['adapter-a'] });
    result.resolve({ executionId: config.executionId, workflowId: config.workflowId, status: 'completed' });
    await expect(run.result).resolves.toMatchObject({ status: 'completed' });
  });

  it('rejects readiness when the worker result rejects before ready', async () => {
    const error = new Error('worker crashed');
    mockPoolRun.mockRejectedValueOnce(error);
    const runner = new ThinWorkflowPiscinaRunner(makeOptions());

    const run = runner.runWithReadiness(makeConfig(), new AbortController().signal);

    await expect(run.ready).rejects.toThrow('worker crashed');
    await expect(run.result).rejects.toBe(error);
  });

  it('rejects readiness when the worker completes before ready', async () => {
    mockPoolRun.mockResolvedValueOnce({ executionId: 'test-exec', workflowId: 'test-workflow', status: 'completed' });
    const runner = new ThinWorkflowPiscinaRunner(makeOptions());

    const run = runner.runWithReadiness(makeConfig(), new AbortController().signal);

    await expect(run.ready).rejects.toThrow('Workflow worker completed before ready signal: test-exec');
  });
});
