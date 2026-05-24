import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { StepRunConfig, StepRunResult } from '@makaio/contracts';
import type { DockerStepRunnerOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn();
const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// ---------------------------------------------------------------------------
// Mock @makaio/subprocess (decodeJsonlChunk)
// ---------------------------------------------------------------------------

vi.mock('@makaio/subprocess', () => ({
  decodeJsonlChunk: (chunk: string, buffer: string) => {
    const full = buffer + chunk;
    const lines = full.split('\n');
    const remaining = lines.pop() ?? '';
    const messages: unknown[] = [];
    const errors: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed));
      } catch {
        errors.push(trimmed);
      }
    }

    return { messages, errors, remaining };
  },
}));

// Import after mocking
const { DockerStepRunner } = await import('../docker-step-runner.js');

/**
 * Create a minimal StepRunConfig for testing.
 * @returns A valid StepRunConfig stub.
 */
function makeConfig(): StepRunConfig {
  return {
    stepId: 'docker-step',
    executionId: 'docker-exec',
    workflowId: 'docker-wf',
    coordinatorSessionId: 'docker-session',
    stepType: 'shell',
    stepDefinition: { id: 'docker-step', type: 'shell', command: ['echo', 'hello'] },
    resolvedInputs: {},
    busAuth: { kind: 'hmac', secret: 'super-secret-do-not-leak' },
    platformDefaults: { cwd: '/workspace' },
    cancelSubject: 'workflow.cancel.docker-test',
  };
}

/**
 * Create default runner options for testing.
 * @returns DockerStepRunnerOptions with test values.
 */
function makeOptions(): DockerStepRunnerOptions {
  return {
    mode: 'docker',
    imageName: 'makaio/worker:latest',
    workerEntry: '/app/worker-entry.mjs',
    cwd: '/host/workspace',
    platformDefaults: { cwd: '/host/workspace' },
    manifest: { packages: [] },
  };
}

/**
 * Create a mock spawned process for docker start --attach.
 * @returns Mock process with stdin/stdout/stderr emitters.
 */
function createMockSpawnProcess(): EventEmitter & {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

/**
 * Flush pending microtasks to allow async operations to settle.
 * Multiple awaits are needed because the docker runner chains multiple
 * async operations (createContainer then startAndCommunicate).
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => r());
  }
}

describe('DockerStepRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports managesWorkflowLifecycle as false', () => {
    const runner = new DockerStepRunner(makeOptions());

    expect(runner.managesWorkflowLifecycle).toBe(false);
  });

  it('creates container with correct docker args (no secrets in args)', async () => {
    const containerId = 'abc123container';
    const options = makeOptions();

    // Mock docker create
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'create') {
          cb(null, `${containerId}\n`, '');
        } else if (args[0] === 'rm') {
          cb(null, '', '');
        }
      },
    );

    // Mock docker start --attach
    const proc = createMockSpawnProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const runner = new DockerStepRunner(options);
    const config = makeConfig();
    const signal = new AbortController().signal;

    const resultPromise = runner.run(config, signal);
    await flushMicrotasks();

    // Verify docker create was called with correct argv array
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'create',
        '--network',
        'host',
        '-v',
        `${options.cwd}:/workspace`,
        '-w',
        '/workspace',
        '--label',
        `makaio.step=${config.executionId}:${config.stepId}`,
        '-i',
        options.imageName,
        'node',
        options.workerEntry,
      ]),
      expect.any(Function),
    );

    // Verify secrets are NOT in the create args
    const createCall = mockExecFile.mock.calls[0] as [string, string[], unknown];
    const createArgs = createCall[1];
    const argsStr = createArgs.join(' ');
    expect(argsStr).not.toContain('super-secret-do-not-leak');

    // Simulate ready + result from container stdout
    const result: StepRunResult = { status: 'completed', output: 'docker-out', telemetry: { duration: 200 } };
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify(result) + '\n'));

    const actual = await resultPromise;
    expect(actual).toEqual(result);
  });

  it('launches source TypeScript worker entries with the tsx loader', async () => {
    const containerId = 'source-entry';
    const options: DockerStepRunnerOptions = {
      ...makeOptions(),
      workerEntry: '/app/worker-entry.ts',
    };

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'create') {
          cb(null, `${containerId}\n`, '');
        } else if (args[0] === 'rm') {
          cb(null, '', '');
        }
      },
    );

    const proc = createMockSpawnProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const runner = new DockerStepRunner(options);
    const resultPromise = runner.run(makeConfig(), new AbortController().signal);
    await flushMicrotasks();

    const createCall = mockExecFile.mock.calls.find((call) => (call as [string, string[]])[1][0] === 'create');
    const createArgs = (createCall as [string, string[]])[1];
    const nodeIndex = createArgs.indexOf('node');
    expect(createArgs.slice(nodeIndex)).toEqual(['node', '--import', 'tsx/esm', '/app/worker-entry.ts']);

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ status: 'completed', telemetry: { duration: 1 } }) + '\n'));
    await resultPromise;
  });

  it('launches dist ESM worker entries as plain node scripts', async () => {
    const containerId = 'dist-entry';

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'create') {
          cb(null, `${containerId}\n`, '');
        } else if (args[0] === 'rm') {
          cb(null, '', '');
        }
      },
    );

    const proc = createMockSpawnProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const runner = new DockerStepRunner(makeOptions());
    const resultPromise = runner.run(makeConfig(), new AbortController().signal);
    await flushMicrotasks();

    const createCall = mockExecFile.mock.calls.find((call) => (call as [string, string[]])[1][0] === 'create');
    const createArgs = (createCall as [string, string[]])[1];
    const nodeIndex = createArgs.indexOf('node');
    expect(createArgs.slice(nodeIndex)).toEqual(['node', '/app/worker-entry.mjs']);

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ status: 'completed', telemetry: { duration: 1 } }) + '\n'));
    await resultPromise;
  });

  it('sends config via stdin (secrets stay in stdin, not CLI args)', async () => {
    const containerId = 'def456';

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'create') {
          cb(null, `${containerId}\n`, '');
        } else if (args[0] === 'rm') {
          cb(null, '', '');
        }
      },
    );

    const proc = createMockSpawnProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const runner = new DockerStepRunner(makeOptions());
    const config = makeConfig();
    const signal = new AbortController().signal;

    const resultPromise = runner.run(config, signal);
    await flushMicrotasks();

    // Verify stdin.write was called with the config payload
    expect(proc.stdin.write).toHaveBeenCalledOnce();
    const writtenPayload = proc.stdin.write.mock.calls[0]![0] as string;
    const parsed = JSON.parse(writtenPayload.trim());
    expect(parsed.config).toEqual(config);
    expect(parsed.config.busAuth.secret).toBe('super-secret-do-not-leak');
    expect(proc.stdin.end).toHaveBeenCalledOnce();

    // Finish
    const result: StepRunResult = { status: 'completed', telemetry: { duration: 1 } };
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify(result) + '\n'));
    await resultPromise;
  });

  it('always removes container in finally (even on success)', async () => {
    const containerId = 'cleanup-test';

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'create') {
          cb(null, `${containerId}\n`, '');
        } else if (args[0] === 'rm') {
          cb(null, '', '');
        }
      },
    );

    const proc = createMockSpawnProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const runner = new DockerStepRunner(makeOptions());
    const signal = new AbortController().signal;

    const resultPromise = runner.run(makeConfig(), signal);
    await flushMicrotasks();

    const result: StepRunResult = { status: 'completed', telemetry: { duration: 1 } };
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify(result) + '\n'));
    await resultPromise;

    // Verify docker rm -f was called
    const rmCall = mockExecFile.mock.calls.find((call) => (call as [string, string[]])[1][0] === 'rm');
    expect(rmCall).toBeDefined();
    expect((rmCall as [string, string[]])[1]).toEqual(['rm', '-f', containerId]);
  });

  it('starts graceful termination on abort and settles after docker exits', async () => {
    const containerId = 'abort-test';

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'create') {
          cb(null, `${containerId}\n`, '');
        } else if (args[0] === 'rm') {
          cb(null, '', '');
        }
      },
    );

    const proc = createMockSpawnProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const controller = new AbortController();
    const runner = new DockerStepRunner(makeOptions());

    const resultPromise = runner.run(makeConfig(), controller.signal);
    await flushMicrotasks();

    controller.abort();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    proc.emit('exit', 143);

    await expect(resultPromise).rejects.toThrow('aborted');
  });

  it('rejects when container exits before producing result', async () => {
    const containerId = 'early-exit';

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'create') {
          cb(null, `${containerId}\n`, '');
        } else if (args[0] === 'rm') {
          cb(null, '', '');
        }
      },
    );

    const proc = createMockSpawnProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const runner = new DockerStepRunner(makeOptions());
    const signal = new AbortController().signal;

    const resultPromise = runner.run(makeConfig(), signal);
    await flushMicrotasks();

    proc.emit('exit', 1);

    await expect(resultPromise).rejects.toThrow('exited with code 1');
  });

  it('forceKill calls docker stop on the active container', async () => {
    const containerId = 'force-kill-test';

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'create') {
          cb(null, `${containerId}\n`, '');
        } else if (args[0] === 'rm') {
          cb(null, '', '');
        } else if (args[0] === 'stop') {
          cb(null, '', '');
        }
      },
    );

    const proc = createMockSpawnProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const runner = new DockerStepRunner(makeOptions());
    const config = makeConfig();
    const signal = new AbortController().signal;

    const resultPromise = runner.run(config, signal);
    await flushMicrotasks();

    runner.forceKill('docker-exec', 'docker-step');

    // Verify docker stop was called
    const stopCall = mockExecFile.mock.calls.find((call) => (call as [string, string[]])[1][0] === 'stop');
    expect(stopCall).toBeDefined();
    expect((stopCall as [string, string[]])[1]).toEqual(['stop', '--time=0', containerId]);

    // Clean up
    const result: StepRunResult = { status: 'failed', telemetry: { duration: 0 } };
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify(result) + '\n'));
    await resultPromise;
  });

  it('uses custom network mode when specified', async () => {
    const containerId = 'network-test';
    const options: DockerStepRunnerOptions = {
      ...makeOptions(),
      networkMode: 'bridge',
    };

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'create') {
          cb(null, `${containerId}\n`, '');
        } else if (args[0] === 'rm') {
          cb(null, '', '');
        }
      },
    );

    const proc = createMockSpawnProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const runner = new DockerStepRunner(options);
    const signal = new AbortController().signal;

    const resultPromise = runner.run(makeConfig(), signal);
    await flushMicrotasks();

    const createCall = mockExecFile.mock.calls.find((call) => (call as [string, string[]])[1][0] === 'create');
    const createArgs = (createCall as [string, string[]])[1];
    const networkIdx = createArgs.indexOf('--network');
    expect(createArgs[networkIdx + 1]).toBe('bridge');

    // Clean up
    const result: StepRunResult = { status: 'completed', telemetry: { duration: 1 } };
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify(result) + '\n'));
    await resultPromise;
  });

  it('uses argv arrays for docker commands (no shell interpolation)', async () => {
    const containerId = 'argv-test';

    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'create') {
          cb(null, `${containerId}\n`, '');
        } else if (args[0] === 'rm') {
          cb(null, '', '');
        }
      },
    );

    const proc = createMockSpawnProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const runner = new DockerStepRunner(makeOptions());
    const signal = new AbortController().signal;

    const resultPromise = runner.run(makeConfig(), signal);
    await flushMicrotasks();

    // execFile receives argv array, not a string
    expect(mockExecFile).toHaveBeenCalledWith('docker', expect.any(Array), expect.any(Function));
    // spawn receives argv array too
    expect(mockSpawn).toHaveBeenCalledWith('docker', expect.any(Array), expect.any(Object));

    // Clean up
    const result: StepRunResult = { status: 'completed', telemetry: { duration: 1 } };
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify(result) + '\n'));
    await resultPromise;
  });
});
