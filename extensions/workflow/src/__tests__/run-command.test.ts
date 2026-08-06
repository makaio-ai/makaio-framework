/**
 * Tests for the `workflow run` CLI handler.
 *
 * The handler is exercised against a real `createBusInstance()` with
 * test-local `workflow.runFile` and `workflow.execution.*` handlers so tests
 * verify the full request dispatch path without relying on an actual runtime.
 */
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '@makaio/contracts';
import type { WorkflowRunArgs } from '../run-command.js';
import { handleWorkflowRun, resolvePayload, WorkflowRunArgsSchema } from '../run-command.js';
import type { CommandContext } from '@makaio/kernel/cli';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];

/**
 * Stub stdin as a TTY to prevent readStdin() from hanging in tests.
 * @returns Restore function.
 */
function stubStdinAsTTY(): () => void {
  const mockStdin = {
    isTTY: true as boolean | undefined,
    [Symbol.asyncIterator]: async function* () {
      // Never yields — TTY stdin is not consumed.
    },
  };
  const spy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(mockStdin as typeof process.stdin);
  return () => spy.mockRestore();
}

/**
 * Stub stdin as a pipe (non-TTY) that yields the given content.
 * @param content - Content to yield from the async iterator.
 * @returns Restore function.
 */
function stubStdinAsPipe(content: string): () => void {
  const mockStdin = {
    isTTY: false as boolean | undefined,
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(content);
    },
  };
  const spy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(mockStdin as typeof process.stdin);
  return () => spy.mockRestore();
}

/**
 * Stub stdin as a pipe that stays open until destroyed.
 * @returns Restore function.
 */
function stubPendingStdinPipe(): () => void {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: false });
  const spy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
  return () => {
    stdin.destroy();
    spy.mockRestore();
  };
}

afterEach(() => {
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  vi.restoreAllMocks();
});

function createOutput() {
  return {
    write(text: string): void {
      stdoutChunks.push(text);
    },
    error(text: string): void {
      stderrChunks.push(text);
    },
  };
}

function createContext(
  bus: IMakaioBus | null,
  args: WorkflowRunArgs,
  signal: AbortSignal = new AbortController().signal,
): CommandContext<WorkflowRunArgs> & { readonly setExitCodeSpy: ReturnType<typeof vi.fn> } {
  const setExitCodeSpy = vi.fn<(code: number) => void>();
  return {
    args,
    bus,
    output: createOutput(),
    signal,
    setExitCode: setExitCodeSpy,
    setExitCodeSpy,
  };
}

/**
 * Parse workflow run args with defaults applied.
 * @param overrides - Partial args to override.
 * @returns Validated args.
 */
function makeArgs(overrides: Partial<WorkflowRunArgs> & { file: string }): WorkflowRunArgs {
  return WorkflowRunArgsSchema.parse(overrides);
}

// ---------------------------------------------------------------------------
// resolvePayload
// ---------------------------------------------------------------------------

describe('resolvePayload', () => {
  it('uses --payload when provided and returns payload mode', async () => {
    const restore = stubStdinAsTTY();
    try {
      const result = await resolvePayload(JSON.stringify({ branch: 'main' }));
      expect(result.mode).toBe('payload');
      expect(result.triggerPayload).toEqual({ branch: 'main' });
    } finally {
      restore();
    }
  });

  it('enters await-trigger mode when no payload and stdin is TTY', async () => {
    const restore = stubStdinAsTTY();
    try {
      const result = await resolvePayload(undefined);
      expect(result.mode).toBe('await-trigger');
      expect(result.triggerPayload).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('reads non-TTY stdin as payload when --payload is absent', async () => {
    const restore = stubStdinAsPipe('{"pr":42}');
    try {
      const result = await resolvePayload(undefined);
      expect(result.mode).toBe('payload');
      expect(result.triggerPayload).toEqual({ pr: 42 });
    } finally {
      restore();
    }
  });

  it('rejects non-object JSON from --payload', async () => {
    const restore = stubStdinAsTTY();
    try {
      await expect(resolvePayload('["not","an","object"]')).rejects.toThrow('payload must be a JSON object');
    } finally {
      restore();
    }
  });

  it('rejects non-object JSON from stdin', async () => {
    const restore = stubStdinAsPipe('"not an object"');
    try {
      await expect(resolvePayload(undefined)).rejects.toThrow('payload must be a JSON object');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// WorkflowRunArgsSchema
// ---------------------------------------------------------------------------

describe('WorkflowRunArgsSchema', () => {
  it('requires the file positional argument', () => {
    expect(() => WorkflowRunArgsSchema.parse({})).toThrow();
  });

  it('parses minimal args with only file provided', () => {
    const args = WorkflowRunArgsSchema.parse({ file: './my-workflow.ts' });
    expect(args.file).toBe('./my-workflow.ts');
    expect(args.payload).toBeUndefined();
    expect(args.dryRun).toBeUndefined();
    expect(args.verbose).toBeUndefined();
    expect(args.timeout).toBeUndefined();
  });

  it('parses all optional fields', () => {
    const args = WorkflowRunArgsSchema.parse({
      file: './workflow.ts',
      payload: '{"key":"value"}',
      dryRun: true,
      timeout: 5000,
      verbose: true,
    });
    expect(args.payload).toBe('{"key":"value"}');
    expect(args.dryRun).toBe(true);
    expect(args.timeout).toBe(5000);
    expect(args.verbose).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleWorkflowRun — --payload mode
// ---------------------------------------------------------------------------

describe('handleWorkflowRun with --payload', () => {
  let bus: IMakaioBus;
  let restoreStdin: () => void;

  beforeEach(() => {
    bus = createBusInstance();
    restoreStdin = stubStdinAsTTY();
  });

  afterEach(() => {
    restoreStdin();
  });

  it('dispatches workflow.runFile with the parsed payload and awaits completion', async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];

    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      capturedRequests.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ executionId: 'exec-1' });
    });

    const ctx = createContext(bus, makeArgs({ file: './wf.ts', payload: '{"branch":"main"}' }));

    const runPromise = handleWorkflowRun(ctx);

    // Emit execution.completed to unblock bus.once().
    await bus.emit(WorkflowSubjects.execution.completed, {
      executionId: 'exec-1',
      workflowId: 'wf-test',
      totalDuration: 123,
    });

    await runPromise;

    cleanupRunFile();

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({
      filePath: resolve(process.cwd(), './wf.ts'),
      triggerPayload: { branch: 'main' },
      triggerMode: 'immediate',
    });
    expect(stdoutChunks.join('')).toContain('exec-1');
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
  });

  it('dispatches workflow.runFile with an absolute file path resolved from cwd', async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo/project');

    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      capturedRequests.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ executionId: 'exec-abs-1' });
    });

    const ctx = createContext(bus, makeArgs({ file: './workflows/review.ts', payload: '{}' }));
    try {
      const runPromise = handleWorkflowRun(ctx);

      await bus.emit(WorkflowSubjects.execution.completed, {
        executionId: 'exec-abs-1',
        workflowId: 'wf-test',
        totalDuration: 100,
      });

      await runPromise;
    } finally {
      cleanupRunFile();
      cwdSpy.mockRestore();
    }

    expect(capturedRequests[0]).toMatchObject({
      filePath: resolve('/repo/project', './workflows/review.ts'),
      triggerPayload: {},
      triggerMode: 'immediate',
    });
  });

  it('preserves already-absolute workflow file paths', async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];

    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      capturedRequests.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ executionId: 'exec-abs-2' });
    });

    const ctx = createContext(bus, makeArgs({ file: '/tmp/workflow.mjs', payload: '{}' }));
    const runPromise = handleWorkflowRun(ctx);

    await bus.emit(WorkflowSubjects.execution.completed, {
      executionId: 'exec-abs-2',
      workflowId: 'wf-test',
      totalDuration: 101,
    });

    await runPromise;
    cleanupRunFile();

    expect(capturedRequests[0]).toMatchObject({ filePath: resolve('/tmp/workflow.mjs') });
  });

  it('does not dispatch workflow.runFile when the command signal is already aborted', async () => {
    const runFileHandler = vi.fn();
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      runFileHandler(ctx.payload);
      ctx.setResult({ executionId: 'exec-aborted' });
    });
    const controller = new AbortController();
    controller.abort('SIGTERM');

    const ctx = createContext(bus, makeArgs({ file: './wf.ts', payload: '{}' }), controller.signal);
    await handleWorkflowRun(ctx);
    cleanupRunFile();

    expect(runFileHandler).not.toHaveBeenCalled();
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(143);
  });

  it('sets exit code 1 and writes an error when runFile request fails', async () => {
    // No handler registered for runFile — bus will throw.
    const ctx = createContext(bus, makeArgs({ file: './missing.ts', payload: '{}' }));
    await handleWorkflowRun(ctx);

    expect(stderrChunks.join('')).toContain('Error:');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });

  it('sets exit code 1 on invalid JSON payload', async () => {
    const ctx = createContext(bus, makeArgs({ file: './wf.ts', payload: '{not-json}' }));
    await handleWorkflowRun(ctx);

    expect(stderrChunks.join('')).toContain('invalid JSON payload');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });

  it('aborts a pending runFile request when the command signal aborts', async () => {
    let resolveRunFileStarted!: () => void;
    const runFileStarted = new Promise<void>((resolveStarted) => {
      resolveRunFileStarted = resolveStarted;
    });
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, async () => {
      resolveRunFileStarted();
      await new Promise(() => undefined);
    });
    const controller = new AbortController();
    const ctx = createContext(bus, makeArgs({ file: './wf.ts', payload: '{}' }), controller.signal);

    const runPromise = handleWorkflowRun(ctx);
    await runFileStarted;
    controller.abort('SIGTERM');
    await runPromise;
    cleanupRunFile();

    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(143);
  });
});

// ---------------------------------------------------------------------------
// handleWorkflowRun — non-TTY stdin mode
// ---------------------------------------------------------------------------

describe('handleWorkflowRun with piped stdin', () => {
  let bus: IMakaioBus;
  let restoreStdin: () => void;

  beforeEach(() => {
    bus = createBusInstance();
  });

  afterEach(() => {
    restoreStdin?.();
  });

  it('reads stdin and starts workflow when stdin is not a TTY', async () => {
    restoreStdin = stubStdinAsPipe('{"event":"push"}');

    const capturedRequests: Array<Record<string, unknown>> = [];
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      capturedRequests.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ executionId: 'exec-stdin-1' });
    });

    const ctx = createContext(bus, makeArgs({ file: './wf.ts' }));
    const runPromise = handleWorkflowRun(ctx);

    await bus.emit(WorkflowSubjects.execution.completed, {
      executionId: 'exec-stdin-1',
      workflowId: 'wf-test',
      totalDuration: 200,
    });

    await runPromise;
    cleanupRunFile();

    expect(capturedRequests[0]).toMatchObject({
      filePath: resolve(process.cwd(), './wf.ts'),
      triggerPayload: { event: 'push' },
    });
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
  });

  it('preserves signal exit code when stdin aborts while reading payload', async () => {
    restoreStdin = stubPendingStdinPipe();
    const runFileHandler = vi.fn();
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      runFileHandler(ctx.payload);
      ctx.setResult({ executionId: 'exec-stdin-abort' });
    });
    const controller = new AbortController();
    const ctx = createContext(bus, makeArgs({ file: './wf.ts' }), controller.signal);

    const runPromise = handleWorkflowRun(ctx);
    controller.abort('SIGTERM');
    await runPromise;
    cleanupRunFile();

    expect(runFileHandler).not.toHaveBeenCalled();
    expect(stderrChunks.join('')).not.toContain('invalid JSON payload');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(143);
  });
});

// ---------------------------------------------------------------------------
// handleWorkflowRun — await-trigger mode
// ---------------------------------------------------------------------------

describe('handleWorkflowRun in await-trigger mode', () => {
  let bus: IMakaioBus;
  let restoreStdin: () => void;

  beforeEach(() => {
    bus = createBusInstance();
    restoreStdin = stubStdinAsTTY();
  });

  afterEach(() => {
    restoreStdin();
  });

  it('registers the workflow and waits for completion in await-trigger mode when stdin is TTY and no --payload', async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      capturedRequests.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ executionId: 'exec-await-1' });
    });

    const ctx = createContext(bus, makeArgs({ file: './trigger-wf.ts' }));
    const runPromise = handleWorkflowRun(ctx);

    await new Promise<void>((resolve) => setImmediate(resolve));
    await bus.emit(WorkflowSubjects.execution.completed, {
      executionId: 'exec-await-1',
      workflowId: 'wf-test',
      totalDuration: 25,
    });

    await runPromise;

    cleanupRunFile();

    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('Awaiting trigger for workflow');
    expect(stdout).toContain('Execution exec-await-1 waiting for trigger');
    expect(stdout).toContain('Ctrl-C');
    expect(capturedRequests).toEqual([expect.objectContaining({ triggerMode: 'await-trigger' })]);
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleWorkflowRun — --verbose flag
// ---------------------------------------------------------------------------

describe('handleWorkflowRun with --verbose', () => {
  let bus: IMakaioBus;
  let restoreStdin: () => void;

  beforeEach(() => {
    bus = createBusInstance();
    restoreStdin = stubStdinAsTTY();
  });

  afterEach(() => {
    restoreStdin();
  });

  it('subscribes to lifecycle events and streams them to stderr', async () => {
    // The runFile handler emits step.started synchronously after the response.
    // This simulates the workflow engine starting a step immediately.
    // The verbose subscription is set up AFTER bus.request(runFile) returns, so
    // events emitted by the bus handler itself (after setResult) cannot be
    // captured. Instead, we emit step.started AFTER the handler sets up its
    // subscription by waiting for the runFile response to complete in the handler.
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      ctx.setResult({ executionId: 'exec-verbose-1' });
    });

    const ctx = createContext(bus, makeArgs({ file: './wf.ts', payload: '{}', verbose: true }));
    const runPromise = handleWorkflowRun(ctx);

    // Yield a full event-loop turn so the handler can:
    // 1. Finish resolvePayload()
    // 2. Call bus.request(runFile) and receive the response
    // 3. Register the verbose subscribeLifecycleEvents() listener
    // Only THEN emit the lifecycle event so the subscription is in place.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Emit a step.started lifecycle event — subscription is now registered.
    await bus.emit(WorkflowSubjects.step.started, {
      executionId: 'exec-verbose-1',
      stepId: 'step-1',
      stepType: 'station',
    });

    await bus.emit(WorkflowSubjects.execution.completed, {
      executionId: 'exec-verbose-1',
      workflowId: 'wf-test',
      totalDuration: 50,
    });

    await runPromise;
    cleanupRunFile();

    const stderr = stderrChunks.join('');
    expect(stderr).toContain('step.started');
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleWorkflowRun — execution.failed event
// ---------------------------------------------------------------------------

describe('handleWorkflowRun — execution.failed', () => {
  let bus: IMakaioBus;
  let restoreStdin: () => void;

  beforeEach(() => {
    bus = createBusInstance();
    restoreStdin = stubStdinAsTTY();
  });

  afterEach(() => {
    restoreStdin();
  });

  it('sets exit code 1 and writes the failure reason when execution.failed arrives', async () => {
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      ctx.setResult({ executionId: 'exec-fail-1' });
    });

    const ctx = createContext(bus, makeArgs({ file: './wf.ts', payload: '{}' }));
    const runPromise = handleWorkflowRun(ctx);

    await bus.emit(WorkflowSubjects.execution.failed, {
      executionId: 'exec-fail-1',
      workflowId: 'wf-test',
      error: 'step "fetch" timed out',
    });

    await runPromise;
    cleanupRunFile();

    expect(stderrChunks.join('')).toContain('step "fetch" timed out');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });

  it('handles execution.failed emitted through the runFile bus handler', async () => {
    let runFileRequests = 0;
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, async (ctx) => {
      runFileRequests += 1;
      ctx.setResult({ executionId: 'exec-handler-fail' });
      await bus.emit(WorkflowSubjects.execution.failed, {
        executionId: 'exec-handler-fail',
        workflowId: 'wf-test',
        error: 'runtime handler emitted failure',
      });
    });

    const ctx = createContext(bus, makeArgs({ file: './wf.ts', payload: '{}' }));
    await handleWorkflowRun(ctx);
    cleanupRunFile();

    expect(runFileRequests).toBe(1);
    expect(stderrChunks.join('')).toContain('runtime handler emitted failure');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });

  it('ignores failed events for unrelated execution IDs', async () => {
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      ctx.setResult({ executionId: 'exec-target' });
    });

    const ctx = createContext(bus, makeArgs({ file: './wf.ts', payload: '{}' }));
    const runPromise = handleWorkflowRun(ctx);

    // Emit failure for a different execution — should be ignored.
    await bus.emit(WorkflowSubjects.execution.failed, {
      executionId: 'exec-other',
      workflowId: 'wf-test',
      error: 'unrelated failure',
    });

    // Now complete the target execution normally.
    await bus.emit(WorkflowSubjects.execution.completed, {
      executionId: 'exec-target',
      workflowId: 'wf-test',
      totalDuration: 42,
    });

    await runPromise;
    cleanupRunFile();

    expect(stderrChunks.join('')).not.toContain('unrelated failure');
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
  });

  it('handles failed event arriving before setExecutionId is called', async () => {
    // This test verifies the buffer-first design: the failed event may arrive
    // synchronously from the bus handler before we call setExecutionId().
    let resolveRunFile!: () => void;
    const runFileHandled = new Promise<void>((r) => {
      resolveRunFile = r;
    });

    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, async (ctx) => {
      // Emit the failure event before setResult() so it lands in the buffer
      // before the executionId is known to the waiter.
      await bus.emit(WorkflowSubjects.execution.failed, {
        executionId: 'exec-early-fail',
        workflowId: 'wf-test',
        error: 'crashed before start',
      });
      ctx.setResult({ executionId: 'exec-early-fail' });
      resolveRunFile();
    });

    const ctx = createContext(bus, makeArgs({ file: './wf.ts', payload: '{}' }));
    const runPromise = handleWorkflowRun(ctx);

    await runFileHandled;
    await runPromise;
    cleanupRunFile();

    expect(stderrChunks.join('')).toContain('crashed before start');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// handleWorkflowRun — --dry-run flag
// ---------------------------------------------------------------------------

describe('handleWorkflowRun with --dry-run', () => {
  let bus: IMakaioBus;
  let restoreStdin: () => void;

  beforeEach(() => {
    bus = createBusInstance();
    restoreStdin = stubStdinAsTTY();
  });

  afterEach(() => {
    restoreStdin();
  });

  it('does not dispatch runFile because the bus contract has no dry-run mode', async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      capturedRequests.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ executionId: 'exec-dry-1' });
    });

    const ctx = createContext(bus, makeArgs({ file: './wf.ts', dryRun: true }));
    await handleWorkflowRun(ctx);

    cleanupRunFile();

    expect(capturedRequests).toHaveLength(0);
    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('Dry run requested');
    expect(stdout).toContain('No workflow was executed');
    expect(stderrChunks.join('')).toContain('not supported');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });

  it('does not require a bus before refusing unsupported dry-run execution', async () => {
    const ctx = createContext(null, makeArgs({ file: './wf.ts', dryRun: true }));
    await handleWorkflowRun(ctx);

    expect(stdoutChunks.join('')).toContain('No workflow was executed');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });

  it('validates payload shape without dispatching in dry-run mode', async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      capturedRequests.push(ctx.payload as Record<string, unknown>);
      ctx.setResult({ executionId: 'exec-dry-invalid' });
    });

    const ctx = createContext(bus, makeArgs({ file: './wf.ts', payload: '[]', dryRun: true }));
    await handleWorkflowRun(ctx);

    cleanupRunFile();

    expect(capturedRequests).toHaveLength(0);
    expect(stderrChunks.join('')).toContain('payload must be a JSON object');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(1);
  });

  it('preserves signal exit code when dry-run stdin aborts while reading payload', async () => {
    restoreStdin();
    restoreStdin = stubPendingStdinPipe();
    const runFileHandler = vi.fn();
    const cleanupRunFile = bus.on(WorkflowSubjects.runFile, (ctx) => {
      runFileHandler(ctx.payload);
      ctx.setResult({ executionId: 'exec-dry-stdin-abort' });
    });
    const controller = new AbortController();
    const ctx = createContext(bus, makeArgs({ file: './wf.ts', dryRun: true }), controller.signal);

    const runPromise = handleWorkflowRun(ctx);
    controller.abort('SIGTERM');
    await runPromise;
    cleanupRunFile();

    expect(runFileHandler).not.toHaveBeenCalled();
    expect(stderrChunks.join('')).not.toContain('invalid JSON payload');
    expect(ctx.setExitCodeSpy).toHaveBeenCalledWith(143);
  });
});
