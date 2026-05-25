import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowWorkerConfig } from '@makaio/contracts';
import type { WorkflowPiscinaRunnerOptions } from '../types.js';

// Mock Piscina before importing the class under test
const mockRun = vi.fn();
const mockDestroy = vi.fn();
const mockConstructorOptions: Array<{ filename: string; maxThreads: number; idleTimeout: number }> = [];

vi.mock('piscina', () => ({
  default: class MockPiscina {
    public readonly filename: string;
    public readonly maxThreads: number;
    public readonly idleTimeout: number;

    public constructor(opts: { filename: string; maxThreads: number; idleTimeout: number }) {
      mockConstructorOptions.push(opts);
      this.filename = opts.filename;
      this.maxThreads = opts.maxThreads;
      this.idleTimeout = opts.idleTimeout;
    }

    public run = mockRun;
    public destroy = mockDestroy;
  },
}));

// Import after mocking
const { WorkflowPiscinaRunner } = await import('../workflow-piscina-runner.js');

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
 * @returns WorkflowPiscinaRunnerOptions with test values.
 */
function makeOptions(): WorkflowPiscinaRunnerOptions {
  return {
    workerEntry: '/path/to/workflow-worker-entry.mjs',
    manifest: { packages: [] },
  };
}

describe('WorkflowPiscinaRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConstructorOptions.length = 0;
  });

  it('passes config and manifest to pool.run()', async () => {
    const expectedResult = {
      executionId: 'test-exec',
      workflowId: 'test-workflow',
      status: 'completed',
    };
    mockRun.mockResolvedValueOnce(expectedResult);

    const options = makeOptions();
    const runner = new WorkflowPiscinaRunner(options);
    const config = makeConfig();
    const signal = new AbortController().signal;

    const result = await runner.run(config, signal);

    expect(mockRun).toHaveBeenCalledOnce();
    expect(mockRun).toHaveBeenCalledWith({ config, manifest: options.manifest }, { signal });
    expect(result).toEqual(expectedResult);
  });

  it('propagates abort signal to pool.run()', async () => {
    const controller = new AbortController();
    mockRun.mockRejectedValueOnce(new Error('The task was aborted'));

    const runner = new WorkflowPiscinaRunner(makeOptions());
    controller.abort();

    await expect(runner.run(makeConfig(), controller.signal)).rejects.toThrow('aborted');
    expect(mockRun).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });

  it('uses default maxConcurrency of 4 when not specified', () => {
    new WorkflowPiscinaRunner(makeOptions());

    expect(mockConstructorOptions).toEqual([
      { filename: '/path/to/workflow-worker-entry.mjs', maxThreads: 4, idleTimeout: 30_000 },
    ]);
  });

  it('uses custom maxConcurrency when specified', () => {
    const options: WorkflowPiscinaRunnerOptions = {
      ...makeOptions(),
      maxConcurrency: 8,
    };
    new WorkflowPiscinaRunner(options);

    expect(mockConstructorOptions).toEqual([
      { filename: '/path/to/workflow-worker-entry.mjs', maxThreads: 8, idleTimeout: 30_000 },
    ]);
  });

  it('dispose() calls pool.destroy()', async () => {
    mockDestroy.mockResolvedValueOnce(undefined);
    const runner = new WorkflowPiscinaRunner(makeOptions());

    await runner.dispose();

    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  it('propagates pool.run() rejection to caller', async () => {
    const error = new Error('Worker thread crashed');
    mockRun.mockRejectedValueOnce(error);

    const runner = new WorkflowPiscinaRunner(makeOptions());

    await expect(runner.run(makeConfig(), new AbortController().signal)).rejects.toThrow('Worker thread crashed');
  });
});
