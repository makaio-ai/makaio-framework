import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowWorkerConfig } from '@makaio/contracts';
import type { WorkflowPiscinaRunnerOptions } from '../types.js';

// Mock PiscinaPoolRunner before importing the class under test.
const mockPoolRun = vi.fn();
const mockPoolDispose = vi.fn();
const mockConstructorOptions: WorkflowPiscinaRunnerOptions[] = [];

vi.mock('../../workflow-step-runner/piscina-pool-runner.js', () => ({
  PiscinaPoolRunner: class MockPiscinaPoolRunner {
    public constructor(options: WorkflowPiscinaRunnerOptions) {
      mockConstructorOptions.push(options);
    }

    public run = mockPoolRun;
    public dispose = mockPoolDispose;
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

  it('passes config and construction-time manifest to pool.run()', async () => {
    const expectedResult = {
      executionId: 'test-exec',
      workflowId: 'test-workflow',
      status: 'completed',
    };
    mockPoolRun.mockResolvedValueOnce(expectedResult);

    const options = makeOptions();
    const runner = new WorkflowPiscinaRunner(options);
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

    const runner = new WorkflowPiscinaRunner(makeOptions());
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

    const runner = new WorkflowPiscinaRunner(makeOptions());
    controller.abort();

    await expect(runner.run(makeConfig(), controller.signal)).rejects.toThrow('aborted');
    expect(mockPoolRun).toHaveBeenCalledWith(expect.anything(), controller.signal);
  });

  it('passes options to PiscinaPoolRunner when maxConcurrency is omitted', () => {
    new WorkflowPiscinaRunner(makeOptions());

    expect(mockConstructorOptions).toEqual([makeOptions()]);
  });

  it('passes custom maxConcurrency to PiscinaPoolRunner when specified', () => {
    const options: WorkflowPiscinaRunnerOptions = {
      ...makeOptions(),
      maxConcurrency: 8,
    };
    new WorkflowPiscinaRunner(options);

    expect(mockConstructorOptions).toEqual([options]);
  });

  it('dispose() calls pool.dispose()', async () => {
    mockPoolDispose.mockResolvedValueOnce(undefined);
    const runner = new WorkflowPiscinaRunner(makeOptions());

    await runner.dispose();

    expect(mockPoolDispose).toHaveBeenCalledOnce();
  });

  it('propagates pool.run() rejection to caller', async () => {
    const error = new Error('Worker thread crashed');
    mockPoolRun.mockRejectedValueOnce(error);

    const runner = new WorkflowPiscinaRunner(makeOptions());

    await expect(runner.run(makeConfig(), new AbortController().signal)).rejects.toThrow('Worker thread crashed');
  });
});
