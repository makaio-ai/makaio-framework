import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepRunConfig, StepRunResult } from '@makaio/contracts';
import type { PiscinaStepRunnerOptions } from '../types.js';

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
const { PiscinaStepRunner } = await import('../piscina-step-runner.js');

/**
 * Create a minimal StepRunConfig for testing.
 * @returns A valid StepRunConfig stub.
 */
function makeConfig(): StepRunConfig {
  return {
    stepId: 'test-step',
    executionId: 'test-exec',
    workflowId: 'test-workflow',
    coordinatorSessionId: 'test-session',
    stepType: 'shell',
    stepDefinition: { id: 'test-step', type: 'shell', command: ['echo', 'hi'] },
    resolvedInputs: {},
    busAuth: { kind: 'none' },
    platformDefaults: { cwd: '/tmp' },
    cancelSubject: 'workflow.cancel.test',
  };
}

/**
 * Create default runner options for testing.
 * @returns PiscinaStepRunnerOptions with test values.
 */
function makeOptions(): PiscinaStepRunnerOptions {
  return {
    mode: 'piscina',
    workerEntry: '/path/to/worker-entry.mjs',
    cwd: '/tmp',
    platformDefaults: { cwd: '/tmp' },
    manifest: { packages: [] },
  };
}

describe('PiscinaStepRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConstructorOptions.length = 0;
  });

  it('reports managesWorkflowLifecycle as false', () => {
    const runner = new PiscinaStepRunner(makeOptions());

    expect(runner.managesWorkflowLifecycle).toBe(false);
  });

  it('passes config and manifest to pool.run()', async () => {
    const expectedResult: StepRunResult = {
      status: 'completed',
      output: 'hello',
      telemetry: { duration: 100 },
    };
    mockRun.mockResolvedValueOnce(expectedResult);

    const options = makeOptions();
    const runner = new PiscinaStepRunner(options);
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

    const runner = new PiscinaStepRunner(makeOptions());
    controller.abort();

    await expect(runner.run(makeConfig(), controller.signal)).rejects.toThrow('aborted');
    expect(mockRun).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });

  it('uses default maxConcurrency of 4 when not specified', () => {
    new PiscinaStepRunner(makeOptions());

    expect(mockConstructorOptions).toEqual([
      { filename: '/path/to/worker-entry.mjs', maxThreads: 4, idleTimeout: 30_000 },
    ]);
  });

  it('uses custom maxConcurrency when specified', () => {
    const options: PiscinaStepRunnerOptions = {
      ...makeOptions(),
      maxConcurrency: 8,
    };
    new PiscinaStepRunner(options);

    expect(mockConstructorOptions).toEqual([
      { filename: '/path/to/worker-entry.mjs', maxThreads: 8, idleTimeout: 30_000 },
    ]);
  });

  it('dispose() calls pool.destroy()', async () => {
    mockDestroy.mockResolvedValueOnce(undefined);
    const runner = new PiscinaStepRunner(makeOptions());

    await runner.dispose();

    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  it('propagates pool.run() rejection to caller', async () => {
    const error = new Error('Worker thread crashed');
    mockRun.mockRejectedValueOnce(error);

    const runner = new PiscinaStepRunner(makeOptions());

    await expect(runner.run(makeConfig(), new AbortController().signal)).rejects.toThrow('Worker thread crashed');
  });
});
