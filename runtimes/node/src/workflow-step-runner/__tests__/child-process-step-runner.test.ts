import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepRunConfig, StepRunResult } from '@makaio/contracts';
import type { ChildProcessStepRunnerOptions } from '../types.js';
import type { IJsonlTransport } from '@makaio/subprocess';

// ---------------------------------------------------------------------------
// Mock @makaio/subprocess
// ---------------------------------------------------------------------------

/** Minimal mock process surface needed by tests. */
interface MockProcess {
  kill: ReturnType<typeof vi.fn>;
}

interface MockTransport {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  process: MockProcess;
  messageListeners: Set<(msg: unknown) => void>;
  errorListeners: Set<(err: Error) => void>;
  onMessage: (listener: (msg: unknown) => void) => () => void;
  onError: (listener: (err: Error) => void) => () => void;
}

let mockTransport: MockTransport;

vi.mock('@makaio/subprocess', () => ({
  createJsonlTransport: (_opts: unknown): IJsonlTransport => {
    const messageListeners = new Set<(msg: unknown) => void>();
    const errorListeners = new Set<(err: Error) => void>();
    const mockProcess: MockProcess = { kill: vi.fn() };

    mockTransport = {
      send: vi.fn(),
      close: vi.fn(),
      process: mockProcess,
      messageListeners,
      errorListeners,
      onMessage: (listener: (msg: unknown) => void) => {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      onError: (listener: (err: Error) => void) => {
        errorListeners.add(listener);
        return () => errorListeners.delete(listener);
      },
    };

    return mockTransport as unknown as IJsonlTransport;
  },
}));

// Import after mocking
const { ChildProcessStepRunner } = await import('../child-process-step-runner.js');

/**
 * Create a minimal StepRunConfig for testing.
 * @returns A valid StepRunConfig stub.
 */
function makeConfig(): StepRunConfig {
  return {
    stepId: 'step-1',
    executionId: 'exec-1',
    workflowId: 'wf-1',
    coordinatorSessionId: 'session-1',
    stepType: 'shell',
    stepDefinition: { id: 'step-1', type: 'shell', command: ['echo', 'hello'] },
    resolvedInputs: {},
    busAuth: { kind: 'none' },
    platformDefaults: { cwd: '/workspace' },
    cancelSubject: 'workflow.cancel.test',
  };
}

/**
 * Create default runner options for testing.
 * @returns ChildProcessStepRunnerOptions with test values.
 */
function makeOptions(): ChildProcessStepRunnerOptions {
  return {
    mode: 'child-process',
    workerEntry: '/path/to/worker-entry.ts',
    cwd: '/workspace',
    manifest: { packages: [{ name: 'test-ext', importPath: '@test/ext' }] },
  };
}

/**
 * Simulate the ready + result message sequence from the child process.
 * @param result - The StepRunResult the child process produces.
 */
function emitReadyThenResult(result: StepRunResult): void {
  // Emit ready signal
  for (const listener of mockTransport.messageListeners) {
    listener({ jsonrpc: '2.0', method: 'ready' });
  }
  // Emit result
  for (const listener of mockTransport.messageListeners) {
    listener(result);
  }
}

describe('ChildProcessStepRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports managesWorkflowLifecycle as false', () => {
    const runner = new ChildProcessStepRunner(makeOptions());

    expect(runner.managesWorkflowLifecycle).toBe(false);
  });

  it('sends config and manifest to the child process via transport.send()', async () => {
    const options = makeOptions();
    const runner = new ChildProcessStepRunner(options);
    const config = makeConfig();
    const signal = new AbortController().signal;

    const resultPromise = runner.run(config, signal);

    // Let the send happen on next tick
    await Promise.resolve();

    expect(mockTransport.send).toHaveBeenCalledOnce();
    expect(mockTransport.send).toHaveBeenCalledWith({
      config,
      manifest: options.manifest,
    });

    // Simulate response
    const expectedResult: StepRunResult = {
      status: 'completed',
      output: 'done',
      telemetry: { duration: 50 },
    };
    emitReadyThenResult(expectedResult);

    const result = await resultPromise;
    expect(result).toEqual(expectedResult);
  });

  it('skips ready message and resolves with result message', async () => {
    const runner = new ChildProcessStepRunner(makeOptions());
    const signal = new AbortController().signal;

    const resultPromise = runner.run(makeConfig(), signal);
    await Promise.resolve();

    const expectedResult: StepRunResult = {
      status: 'failed',
      error: 'something went wrong',
      telemetry: { duration: 10 },
    };
    emitReadyThenResult(expectedResult);

    const result = await resultPromise;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('something went wrong');
  });

  it('handles result without preceding ready message (tolerant)', async () => {
    const runner = new ChildProcessStepRunner(makeOptions());
    const signal = new AbortController().signal;

    const resultPromise = runner.run(makeConfig(), signal);
    await Promise.resolve();

    // Emit result directly without ready signal
    const expectedResult: StepRunResult = {
      status: 'completed',
      output: 'direct',
      telemetry: { duration: 25 },
    };
    for (const listener of mockTransport.messageListeners) {
      listener(expectedResult);
    }

    const result = await resultPromise;
    expect(result).toEqual(expectedResult);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const runner = new ChildProcessStepRunner(makeOptions());
    const controller = new AbortController();
    controller.abort();

    await expect(runner.run(makeConfig(), controller.signal)).rejects.toThrow('aborted');
  });

  it('rejects and kills process when signal is aborted during execution', async () => {
    const runner = new ChildProcessStepRunner(makeOptions());
    const controller = new AbortController();

    const resultPromise = runner.run(makeConfig(), controller.signal);
    await Promise.resolve();

    controller.abort();

    await expect(resultPromise).rejects.toThrow('aborted');
    expect(mockTransport.process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects when transport emits an error', async () => {
    const runner = new ChildProcessStepRunner(makeOptions());
    const signal = new AbortController().signal;

    const resultPromise = runner.run(makeConfig(), signal);
    await Promise.resolve();

    // Emit error from transport
    for (const listener of mockTransport.errorListeners) {
      listener(new Error('process crashed'));
    }

    await expect(resultPromise).rejects.toThrow('process crashed');
  });

  it('closes transport in finally block after successful run', async () => {
    const runner = new ChildProcessStepRunner(makeOptions());
    const signal = new AbortController().signal;

    const resultPromise = runner.run(makeConfig(), signal);
    await Promise.resolve();

    emitReadyThenResult({ status: 'completed', telemetry: { duration: 1 } });
    await resultPromise;

    expect(mockTransport.close).toHaveBeenCalledOnce();
  });

  it('forceKill sends SIGKILL to the active process', async () => {
    const runner = new ChildProcessStepRunner(makeOptions());
    const signal = new AbortController().signal;

    // Start a run so the process is tracked
    const resultPromise = runner.run(makeConfig(), signal);
    await Promise.resolve();

    runner.forceKill('exec-1', 'step-1');
    expect(mockTransport.process.kill).toHaveBeenCalledWith('SIGKILL');

    // Clean up
    emitReadyThenResult({ status: 'failed', telemetry: { duration: 0 } });
    await resultPromise;
  });

  it('forceKill is a no-op when no process is active for the key', () => {
    const runner = new ChildProcessStepRunner(makeOptions());

    // Should not throw
    runner.forceKill('nonexistent', 'nope');
  });
});
