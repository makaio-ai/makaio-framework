/**
 * Core logic for the `makaio workflow run` CLI subcommand.
 *
 * Runs a workflow TypeScript or JavaScript file via the Makaio bus.
 * The command flow is:
 *
 * 1. Resolve a JSON-object trigger payload from `--payload`, piped stdin, or await-trigger
 *    mode (when stdin is a TTY and `--payload` is absent).
 * 2. In dry-run mode: validate local CLI inputs and exit without dispatching.
 * 3. Optionally subscribe to workflow lifecycle events when `--verbose` is set.
 * 4. Dispatch `workflow.runFile` to start the execution.
 * 5. Wait for `execution.completed` or `execution.failed` and report the outcome.
 * 6. In `--watch` mode with await-trigger: loop back to step 4.
 * 7. Clean up subscriptions in the `finally` block.
 */
import { resolve } from 'node:path';
import { z } from 'zod';
import type { WildcardContext } from '@makaio/core';
import { defineCliSubcommand, requireBus, type CommandContext } from '@makaio/kernel/cli';
import { WorkflowSubjects } from '@makaio/contracts';
import { OnceAbortError } from '@makaio/bus-core';
import { CLI_EXIT_CODES, classifyCliCommandError, readStdin, resolveCliSignalExitCode } from '@makaio/utils';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the `workflow run` subcommand arguments.
 *
 * Each option carries CLI metadata via `.meta()` so the framework can
 * generate `--help` output and parse command-line flags without additional
 * glue code.
 */
export const WorkflowRunArgsSchema = z.object({
  file: z.string().meta({
    positional: true,
    placeholder: '<file>',
    description: 'Workflow TS/JS file path',
  }),
  payload: z.string().optional().meta({
    description: 'Trigger payload as JSON',
    placeholder: '<json>',
  }),
  dryRun: z.boolean().optional().meta({
    description: 'Validate local inputs without starting an execution',
  }),
  timeout: z.number().optional().meta({
    description: 'Max wait time in milliseconds',
    placeholder: '<ms>',
  }),
  verbose: z.boolean().optional().meta({
    description: 'Stream lifecycle events to stderr',
  }),
  watch: z.boolean().optional().meta({
    description: 'Keep running after completion, re-await triggers',
  }),
});

/** Inferred type for validated command arguments. */
export type WorkflowRunArgs = z.infer<typeof WorkflowRunArgsSchema>;

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

const EXIT_FAILURE = CLI_EXIT_CODES.failure;
const EXIT_TIMEOUT = CLI_EXIT_CODES.timeout;
const EXIT_ABORT = CLI_EXIT_CODES.abort;

// ---------------------------------------------------------------------------
// Payload resolution
// ---------------------------------------------------------------------------

/**
 * Payload mode for the run command.
 *
 * - `payload`: `--payload` flag or piped stdin provided a JSON object.
 * - `await-trigger`: no payload available; execution waits for a trigger event.
 */
export type PayloadMode = 'payload' | 'await-trigger';

/**
 * Parsed trigger payload and the mode that was selected.
 */
export interface ResolvedPayload {
  /** Selected payload mode. */
  readonly mode: PayloadMode;
  /** Parsed trigger payload, or `undefined` in await-trigger mode. */
  readonly triggerPayload: Record<string, unknown> | undefined;
}

/**
 * Parse a CLI-supplied payload as the workflow trigger payload contract.
 *
 * `workflow.runFile` accepts `triggerPayload` as `Record<string, unknown>`.
 * Arrays, primitives, and `null` are valid JSON values but not valid workflow
 * trigger payloads, so the CLI rejects them before dispatching to the bus.
 * @param value - Raw JSON string supplied by `--payload` or stdin.
 * @returns Parsed JSON object.
 */
function parseTriggerPayload(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('payload must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve the trigger payload and the operating mode.
 *
 * Priority order:
 * 1. `--payload` flag (explicit JSON string).
 * 2. Piped stdin (non-TTY, reads all available bytes).
 * 3. Await-trigger mode (TTY stdin, no flag).
 * @param payloadArg - Value of the `--payload` flag.
 * @param signal - Optional command abort signal that cancels piped stdin reads.
 * @returns Resolved payload and mode.
 */
export async function resolvePayload(payloadArg: string | undefined, signal?: AbortSignal): Promise<ResolvedPayload> {
  if (payloadArg !== undefined) {
    return { mode: 'payload', triggerPayload: parseTriggerPayload(payloadArg) };
  }

  const stdin = await readStdin(signal);
  if (stdin !== null && stdin.trim() !== '') {
    return { mode: 'payload', triggerPayload: parseTriggerPayload(stdin.trim()) };
  }

  return { mode: 'await-trigger', triggerPayload: undefined };
}

// ---------------------------------------------------------------------------
// Verbose lifecycle subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to all workflow lifecycle events and write them to stderr.
 *
 * Subscribes to the `workflow.$all` wildcard subject so every emitted event
 * (step started, step completed, execution started, etc.) is visible. The
 * subscription is filtered by `executionId` once the execution starts.
 * @param ctx - CLI command context.
 * @param executionId - Execution ID to filter events by.
 * @returns Unsubscribe function.
 */
function subscribeLifecycleEvents(ctx: CommandContext<WorkflowRunArgs>, executionId: string): () => void {
  const bus = requireBus(ctx);
  return bus.on(
    WorkflowSubjects.$all,
    (busCtx: WildcardContext<unknown, unknown>) => {
      if (!busCtx.isRequest) {
        ctx.output.error(`[workflow] ${busCtx.subject} ${JSON.stringify(busCtx.payload)}\n`);
      }
    },
    { filter: { executionId } },
  );
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

/**
 * Execute dry-run mode: validate local CLI inputs without dispatching.
 *
 * The current `workflow.runFile` bus contract starts an execution and has no
 * plan-only mode. Dry-run therefore refuses to dispatch rather than reporting
 * that no steps were executed after starting a real workflow.
 * @param ctx - CLI command context.
 */
async function handleDryRun(ctx: CommandContext<WorkflowRunArgs>): Promise<void> {
  const { args } = ctx;

  try {
    await resolvePayload(args.payload, ctx.signal);
  } catch (err) {
    if (classifyCliCommandError(err) === 'abort') {
      handleCommandError(err, args.timeout, ctx);
      return;
    }
    writeInvalidPayloadError(ctx, err);
    return;
  }

  ctx.output.write(`Dry run requested for workflow: ${args.file}\n`);
  ctx.output.write('No workflow was executed.\n');
  ctx.output.error('Error: --dry-run is not supported by the workflow.runFile execution contract.\n');
  ctx.setExitCode(EXIT_FAILURE);
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Resolved execution completion details.
 */
interface CompletionResult {
  /** Total execution duration in milliseconds. */
  readonly totalDuration: number;
  /** ID of the completed execution. */
  readonly executionId: string;
}

/**
 * Deferred waiter for the `execution.completed` or `execution.failed` event.
 *
 * Pre-registers the subscription before the `runFile` request so events
 * emitted synchronously during request handling are never dropped.
 */
interface CompletionWaiter {
  /** Await this promise to wait for `execution.completed` or `execution.failed`. */
  readonly promise: Promise<CompletionResult>;
  /**
   * Activate filtering once the execution ID is known.
   * @param id - Execution ID returned by the `runFile` request.
   */
  setExecutionId(id: string): void;
  /** Clean up the subscription regardless of outcome. */
  cleanup(): void;
}

/**
 * Detect events that arrive after the command already knows which execution it
 * owns but belong to another workflow run.
 * @param targetExecutionId - Execution ID returned by `workflow.runFile`, if known.
 * @param eventExecutionId - Execution ID carried by the lifecycle event.
 * @returns `true` when the event should be ignored.
 */
function isUnrelatedLifecycleEvent(targetExecutionId: string | undefined, eventExecutionId: string): boolean {
  return targetExecutionId !== undefined && eventExecutionId !== targetExecutionId;
}

/**
 * Resolve the workflow file path for the `workflow.runFile` bus contract.
 * @param file - File path supplied through the CLI positional argument.
 * @returns Absolute file path resolved from the command process working directory.
 */
function resolveWorkflowFilePath(file: string): string {
  return resolve(process.cwd(), file);
}

/**
 * Wait for the workflow execution to complete or fail.
 *
 * Subscribes to `execution.completed` and `execution.failed` BEFORE the
 * `runFile` request is dispatched so events emitted synchronously by the bus
 * handler are never missed. Events received before `setExecutionId` is called
 * are buffered and checked retroactively — the handler callbacks are
 * synchronous to avoid deadlocking callers that `await bus.emit(...)`.
 *
 * Implementation note: `bus.once()` requires the filter to be set at
 * subscription time, but `executionId` is only known after `runFile` responds.
 * We therefore use `bus.on()` with event buffers so the subscriptions are
 * registered first, then matched retroactively with the resolved `executionId`.
 * @param bus - Bus client to subscribe on.
 * @param signal - Abort signal to honour Ctrl-C cancellation.
 * @param timeoutMs - Optional timeout in milliseconds.
 * @returns A {@link CompletionWaiter} for the execution lifecycle.
 */
function createCompletionWaiter(
  bus: ReturnType<typeof requireBus>,
  signal: AbortSignal,
  timeoutMs: number | undefined,
): CompletionWaiter {
  let targetExecutionId: string | undefined;
  const buffered: Array<{ executionId: string; totalDuration: number }> = [];
  const bufferedFailures: Array<{ executionId: string; error: string }> = [];

  let resolveCompletion: (value: CompletionResult) => void;
  let rejectCompletion: (reason: unknown) => void;
  const completionPromise = new Promise<CompletionResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  /**
   * Try to resolve or reject the completion promise from the buffers.
   *
   * Called both when a new event arrives (before ID is known) and when the
   * execution ID is set (to drain any already-buffered matching events).
   * Failures take priority: if both a completion and a failure are buffered
   * for the same execution, the failure is reported.
   */
  function tryResolve(): void {
    if (targetExecutionId === undefined) return;
    const failure = bufferedFailures.find((e) => e.executionId === targetExecutionId);
    if (failure !== undefined) {
      buffered.length = 0;
      bufferedFailures.length = 0;
      rejectCompletion(new WorkflowExecutionFailedError(failure.error));
      return;
    }
    const match = buffered.find((e) => e.executionId === targetExecutionId);
    if (match !== undefined) {
      buffered.length = 0;
      resolveCompletion({ totalDuration: match.totalDuration, executionId: match.executionId });
    }
  }

  // Subscribe synchronously before any async work — the handlers are intentionally
  // synchronous so bus.emit() callers are not blocked by an awaiting callback.
  const unsubscribeCompleted = bus.on(WorkflowSubjects.execution.completed, (busCtx) => {
    const payload = busCtx.payload as { executionId: string; totalDuration: number };
    if (isUnrelatedLifecycleEvent(targetExecutionId, payload.executionId)) return;
    buffered.push({ executionId: payload.executionId, totalDuration: payload.totalDuration });
    tryResolve();
  });

  const unsubscribeFailed = bus.on(WorkflowSubjects.execution.failed, (busCtx) => {
    const payload = busCtx.payload as { executionId: string; error: string };
    if (isUnrelatedLifecycleEvent(targetExecutionId, payload.executionId)) return;
    bufferedFailures.push({ executionId: payload.executionId, error: payload.error });
    tryResolve();
  });

  // Honour abort signal for process-signal cancellation.
  const abortHandler = () => {
    rejectCompletion(new OnceAbortError());
  };
  if (signal.aborted) {
    abortHandler();
  } else {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  // Apply timeout if requested.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`once() timed out after ${timeoutMs}ms waiting for subject: execution.completed`);
      err.name = 'OnceTimeoutError';
      rejectCompletion(err);
    }, timeoutMs);
  }

  const releaseResources = (): void => {
    signal.removeEventListener('abort', abortHandler);
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

  // Ensure signal listener and timeout are removed when the promise settles.
  // The .catch(() => {}) suppresses the unhandled-rejection warning on the
  // cleanup branch — the rejection still propagates through completionPromise
  // itself, which the caller awaits.
  completionPromise.finally(() => releaseResources()).catch(() => {});

  return {
    promise: completionPromise,
    setExecutionId(id: string): void {
      targetExecutionId = id;
      tryResolve();
    },
    cleanup(): void {
      unsubscribeCompleted();
      unsubscribeFailed();
      releaseResources();
    },
  };
}

/**
 * Execute the `makaio workflow run` command.
 *
 * Resolves the operating mode from payload sources, dispatches the
 * `workflow.runFile` bus request, and waits for the execution to settle.
 *
 * The completion subscription is established as the very first synchronous
 * operation so it is guaranteed to be registered before any event can fire,
 * including events emitted by bus handlers that respond synchronously to the
 * `runFile` request. The subscription is cancelled if the resolved mode turns
 * out to be `await-trigger`.
 *
 * Subscriptions are always cleaned up in the `finally` block.
 * @param ctx - Command context provided by the CLI framework.
 */
export async function handleWorkflowRun(ctx: CommandContext<WorkflowRunArgs>): Promise<void> {
  const { args, signal } = ctx;

  if (args.dryRun === true) {
    await handleDryRun(ctx);
    return;
  }

  const bus = requireBus(ctx);

  // Register the completion listener BEFORE any async work (resolvePayload)
  // so it is guaranteed to be in place if the bus handler emits
  // execution.completed synchronously during the runFile request.
  const waiter = createCompletionWaiter(bus, signal, args.timeout);

  let resolvedPayload: ResolvedPayload;
  try {
    resolvedPayload = await resolvePayload(args.payload, signal);
  } catch (err) {
    waiter.cleanup();
    if (classifyCliCommandError(err) === 'abort') {
      handleCommandError(err, args.timeout, ctx);
      return;
    }
    writeInvalidPayloadError(ctx, err);
    return;
  }

  const isAwaitTrigger = resolvedPayload.mode === 'await-trigger';
  const isWatch = args.watch === true && isAwaitTrigger;

  if (isAwaitTrigger) {
    ctx.output.write(`Awaiting trigger for workflow: ${args.file}\n`);
    if (isWatch) {
      ctx.output.write('(Watch mode — re-awaits after each execution. Press Ctrl-C to stop)\n');
    } else {
      ctx.output.write('(Press Ctrl-C to cancel)\n');
    }
  }

  if (args.watch === true && !isAwaitTrigger) {
    ctx.output.error('Warning: --watch is ignored when a payload is provided.\n');
  }

  // First iteration uses the pre-registered waiter; watch iterations create fresh ones.
  let currentWaiter = waiter;
  do {
    const failed = await runOnce(ctx, bus, resolvedPayload, isAwaitTrigger, currentWaiter);
    if (failed) return;
    if (isWatch && !signal.aborted) {
      currentWaiter = createCompletionWaiter(bus, signal, args.timeout);
    }
  } while (isWatch && !signal.aborted);
}

/**
 * Execute one workflow run cycle: dispatch, wait for completion, report.
 * @param ctx - CLI command context.
 * @param bus - Connected bus instance.
 * @param resolvedPayload - Resolved trigger payload and mode.
 * @param isAwaitTrigger - Whether the execution awaits a bus trigger.
 * @param waiter - Pre-registered completion waiter.
 * @returns `true` when the run failed and the caller should stop.
 */
async function runOnce(
  ctx: CommandContext<WorkflowRunArgs>,
  bus: ReturnType<typeof requireBus>,
  resolvedPayload: ResolvedPayload,
  isAwaitTrigger: boolean,
  waiter: CompletionWaiter,
): Promise<boolean> {
  const { args } = ctx;

  const cleanups: Array<() => void> = [waiter.cleanup];

  try {
    if (ctx.signal.aborted) {
      throw new OnceAbortError();
    }
    const filePath = resolveWorkflowFilePath(args.file);
    const { executionId } = await bus.request(
      WorkflowSubjects.runFile,
      {
        filePath,
        ...(resolvedPayload.triggerPayload !== undefined && { triggerPayload: resolvedPayload.triggerPayload }),
      },
      { signal: ctx.signal },
    );

    if (args.verbose === true) {
      cleanups.push(subscribeLifecycleEvents(ctx, executionId));
    }

    if (isAwaitTrigger) {
      ctx.output.write(`Execution ${executionId} waiting for trigger...\n`);
    } else {
      ctx.output.write(`Running workflow: ${args.file} (executionId: ${executionId})\n`);
    }

    waiter.setExecutionId(executionId);
    const completion = await waiter.promise;

    ctx.output.write(`Workflow completed in ${completion.totalDuration}ms (executionId: ${completion.executionId})\n`);
    return false;
  } catch (err) {
    if (isWorkflowFailedError(err)) {
      ctx.output.error(`Error: workflow execution failed — ${(err as WorkflowExecutionFailedError).failureReason}\n`);
      ctx.setExitCode(EXIT_FAILURE);
      return true;
    }
    handleCommandError(resolveCommandError(err, ctx.signal), args.timeout, ctx);
    return true;
  } finally {
    for (const cleanup of cleanups) {
      cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Narrow error to detect workflow execution failures relayed through
 * `execution.failed` events that reject the completion waiter promise.
 *
 * The bus does not throw a typed error for event-based failures; instead the
 * command subscribes separately and throws a structured sentinel.
 * @param err - Caught error.
 * @returns Whether the error is a {@link WorkflowExecutionFailedError}.
 */
function isWorkflowFailedError(err: unknown): err is WorkflowExecutionFailedError {
  return err instanceof Error && err.name === 'WorkflowExecutionFailedError';
}

/**
 * Report malformed trigger payload input consistently across real and dry-run
 * modes.
 * @param ctx - CLI command context for output and exit code.
 * @param err - Parse or shape validation error.
 */
function writeInvalidPayloadError(ctx: CommandContext<WorkflowRunArgs>, err: unknown): void {
  ctx.output.error(`Error: invalid JSON payload — ${err instanceof Error ? err.message : String(err)}\n`);
  ctx.setExitCode(EXIT_FAILURE);
}

/**
 * Normalize generic abort errors produced by bus request cancellation into the
 * stable CLI abort sentinel used for process-signal exit codes.
 * @param err - Caught command error.
 * @param signal - Command abort signal.
 * @returns Original error, or a {@link OnceAbortError} when the command signal fired.
 */
function resolveCommandError(err: unknown, signal: AbortSignal): unknown {
  if (signal.aborted && classifyCliCommandError(err) === 'failure') {
    return new OnceAbortError();
  }
  return err;
}

/**
 * Sentinel thrown inside the execution-failed subscription to propagate the
 * failure reason back to the command handler.
 */
class WorkflowExecutionFailedError extends Error {
  /** Human-readable failure reason from the `execution.failed` event. */
  public readonly failureReason: string;

  /**
   * @param reason - Error message from the `execution.failed` payload.
   */
  public constructor(reason: string) {
    super(reason);
    this.name = 'WorkflowExecutionFailedError';
    this.failureReason = reason;
  }
}

/**
 * Map a caught error to the appropriate exit code and write user-facing output.
 *
 * `OnceAbortError` → signal-specific process exit code when available, otherwise 130.
 * Error named `'OnceTimeoutError'` → 124 (GNU timeout convention).
 * All other errors → 1 with the error message written to stderr.
 * @param err - The caught error value.
 * @param timeoutMs - Configured timeout in milliseconds (for the error message).
 * @param ctx - CLI command context for output and exit code.
 */
function handleCommandError(err: unknown, timeoutMs: number | undefined, ctx: CommandContext<WorkflowRunArgs>): void {
  switch (classifyCliCommandError(err)) {
    case 'abort':
      ctx.setExitCode(resolveCliSignalExitCode(ctx.signal.reason) ?? EXIT_ABORT);
      return;
    case 'timeout': {
      const timeoutLabel = timeoutMs !== undefined ? `${timeoutMs}ms` : 'the configured timeout';
      ctx.output.error(`Error: workflow timed out after ${timeoutLabel}.\n`);
      ctx.setExitCode(EXIT_TIMEOUT);
      return;
    }
    case 'failure':
      ctx.output.error(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      ctx.setExitCode(EXIT_FAILURE);
      return;
  }
}

// ---------------------------------------------------------------------------
// Subcommand definition
// ---------------------------------------------------------------------------

export const workflowRunCommand = defineCliSubcommand(
  'run',
  'Run a workflow file',
  WorkflowRunArgsSchema,
  handleWorkflowRun,
);
