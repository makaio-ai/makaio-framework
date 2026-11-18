import type { IMakaioBus } from '@makaio/bus-core';
import type {
  BeforeRunContext,
  BeforeRunResult,
  CommandContext,
  CliContribution,
  EmbeddedBusHandle,
  ProvideBusContext,
} from '@makaio/kernel/cli';
import { readCancellation } from '@makaio/kernel';
import { formatConnectionError } from './connection-error.js';
import { installHostShutdown, resourceStepStopBudgetMs } from '@makaio/runtime-node';
import { CLI_COMMAND_ABORT_SIGNALS, CLI_COMMAND_SIGNAL_EXIT_CODES, outerBoundMs } from '@makaio/utils';

type CommandAbortSignal = (typeof CLI_COMMAND_ABORT_SIGNALS)[number];

// ---------------------------------------------------------------------------
// Resolved bus — embedded or external bus with unified dispose contract
// ---------------------------------------------------------------------------

/**
 * A resolved bus instance for a single CLI command invocation.
 *
 * Returned by {@link resolveContributionBus}. The `bus` field is `null` when
 * neither an external connection nor an embedded provider was available.
 * Callers **must** invoke `dispose()` in a `finally` block regardless of
 * whether `bus` is null — the no-op case is safe.
 */
export interface ResolvedCliBus {
  /** The live bus instance, or `null` when no bus is available. */
  readonly bus: IMakaioBus | null;
  /**
   * Release resources associated with an embedded bus.
   *
   * For external buses this is a no-op. For embedded buses this shuts down
   * the in-process runtime. Always safe to call; embedded teardown failures
   * propagate to the caller so command dispatch can surface them.
   * @returns A promise that resolves when teardown is complete.
   */
  dispose(): Promise<void>;
}

// Shared no-op disposer for cases where no embedded bus was created.
const noopDispose = (): Promise<void> => Promise.resolve();

/**
 * Resolve the effective bus for a single CLI command invocation.
 *
 * Resolution order (first match wins):
 * 1. External bus — when `externalBus` is non-null it is returned directly and
 *    `provideBus` is **never** called.
 * 2. Embedded bus — when `externalBus` is null and `provideBus` is defined,
 *    the hook is called and the returned handle is wrapped. If the hook returns
 *    `null` the invocation falls through to case 3.
 * 3. No bus — `{ bus: null, dispose: noop }`.
 * @param externalBus - Pre-connected external bus, or `null` when unavailable.
 * @param provideBus - Optional embedded bus factory from the contribution.
 * @param subcommandName - Name of the subcommand being invoked (forwarded to
 *   the factory via {@link ProvideBusContext}).
 * @param args - Parsed command arguments (forwarded to the factory).
 * @param cwd - Working directory from which the CLI was invoked.
 * @param signalContext - Signal context of the invocation; its signal and stop-budget
 *   report are what the embedded provider receives through {@link ProvideBusContext}.
 * @returns A resolved bus handle with a unified `dispose` contract.
 */
export async function resolveContributionBus(
  externalBus: IMakaioBus | null,
  provideBus: CliContribution['provideBus'],
  subcommandName: string,
  args: Record<string, unknown>,
  cwd: string,
  signalContext: ProcessCommandSignalContext,
): Promise<ResolvedCliBus> {
  if (externalBus !== null) {
    return { bus: externalBus, dispose: noopDispose };
  }

  if (provideBus) {
    const context: ProvideBusContext = {
      subcommandName,
      args,
      cwd,
      signal: signalContext.signal,
      onStopBudget: signalContext.onStopBudget,
    };
    const provisioning = provideBus(context);
    // Registered before the boot is awaited: a signal during it must find the boot to cancel and the handle to dispose.
    const disposeEmbedded = signalContext.adoptEmbeddedBus(provisioning);
    const handle = await provisioning;
    if (handle !== null) {
      return { bus: handle.bus, dispose: disposeEmbedded };
    }
  }

  return { bus: null, dispose: noopDispose };
}

/**
 * Return the executable bus provider only when both manifest and contribution
 * declare the serializable bus-provisioning capability.
 *
 * `provideBus` is executable code; `canProvideBus` is the routing contract that
 * makes invoking that code intentional and discoverable before connection.
 * @param contribution - Executable CLI contribution loaded for dispatch.
 * @param manifestCanProvideBus - Whether the serializable manifest declared the capability.
 * @returns Authorized bus provider, or `undefined` when either side omitted the capability.
 */
export function getAuthorizedProvideBus(
  contribution: Pick<CliContribution, 'canProvideBus' | 'provideBus'>,
  manifestCanProvideBus = true,
): CliContribution['provideBus'] {
  return manifestCanProvideBus && contribution.canProvideBus === true ? contribution.provideBus : undefined;
}

// ---------------------------------------------------------------------------
// Process command context — signal handling + output wiring
// ---------------------------------------------------------------------------

/**
 * Result of {@link createProcessCommandContext}.
 *
 * Callers must invoke `finish()` when the command has finished, including the
 * disposal of what it owns (typically in a `finally` block after the embedded
 * bus was disposed), so the process signals are given back.
 * @typeParam TArgs - Inferred from the command's Zod schema.
 */
export interface ProcessCommandContextResult<TArgs> {
  /** The command context to pass to the handler. */
  readonly context: CommandContext<TArgs>;
  /**
   * Declare the command finished. See {@link ProcessCommandSignalContext.finish}.
   * @returns Settles once the process signals have been given back.
   */
  finish(): Promise<void>;
}

/**
 * Process-level signal context for one local command invocation.
 *
 * Create this after command args parse and before command-owned resources
 * (such as an embedded bus) are allocated, so process signals can abort the
 * invocation signal while `finally` blocks still dispose those resources.
 */
export interface ProcessCommandSignalContext {
  /** Abort signal shared with the eventual {@link CommandContext}. */
  readonly signal: AbortSignal;
  /**
   * Receive the bound an embedded provider reports for stopping what it started
   * (see {@link ProvideBusContext.onStopBudget}).
   * @param stopBudgetMs - Reads the current bound in milliseconds, or `undefined` when nothing is running.
   */
  onStopBudget(stopBudgetMs: () => number | undefined): void;
  /**
   * Take over the stopping of the embedded bus that is being provisioned. When a
   * signal arrives, the shutdown stops it on its own once the handler has had its
   * wind-down, whether or not the handler ever returns: so a command that does not
   * honour the abort cannot leave the runtime (and the children it started) running
   * when the shutdown ends the process.
   * @param provisioning - The pending result of the provider.
   * @returns The disposal of the embedded bus, shared with the shutdown: the first call starts it, later ones
   *   join it, and a failed one is not kept. Once the provisioning has settled without a handle it does nothing.
   */
  adoptEmbeddedBus(provisioning: Promise<EmbeddedBusHandle | null>): () => Promise<void>;
  /**
   * Declare the handler settled: it has returned or failed, and what the command
   * owns is about to be disposed. A shutdown that is waiting for the handler to
   * wind down moves on to stopping the embedded bus.
   */
  handlerSettled(): void;
  /**
   * Declare the command finished: its handler has returned and what it owns has
   * been disposed. A shutdown that a signal requested while the command ran
   * completes now and gives the signals back; without one the signals are given
   * back at once. Safe to call repeatedly.
   * @returns Settles once the process signals have been given back.
   */
  finish(): Promise<void>;
}

/**
 * Time the handler of an aborted command gets to wind down before the shutdown
 * stops the runtime it uses on its own: one bounded stop, the unit every process and
 * resource stop in the runtime uses. The command contract is to honour the abort
 * signal promptly; this is what keeps a handler that does not from making the
 * invocation impossible to interrupt.
 * @returns The wind-down window, in milliseconds.
 */
function commandWindDownMs(): number {
  return resourceStepStopBudgetMs();
}

/**
 * Narrow a shutdown reason to the process signals a command stops on.
 * @param reason - Reason the shutdown was requested with.
 * @returns The signal, or `undefined` when the reason is not one.
 */
function toCommandAbortSignal(reason: string): CommandAbortSignal | undefined {
  return CLI_COMMAND_ABORT_SIGNALS.find((signal) => signal === reason);
}

/**
 * Create a process-backed signal context for local CLI execution.
 *
 * Built on the host shutdown coordinator: its listeners stay installed until the
 * command has finished ({@link ProcessCommandSignalContext.finish}), so a signal
 * that arrives while the embedded runtime is being stopped joins the shutdown in
 * progress instead of taking the default action and ending the process in the
 * middle of it. The first signal aborts the returned `signal` with the signal's
 * name as reason and sets the conventional signal exit code; this gives command
 * `finally` blocks a chance to dispose embedded runtimes instead of letting
 * Node terminate immediately.
 *
 * The shutdown is bounded, stage by stage. The handler gets one wind-down window
 * to return after the abort; the embedded runtime is then stopped inside the bound
 * its provider reports. A stage that does not finish is named, the next one still
 * runs, and the process ends with status 1 once every stage has been handled.
 * @returns Signal context; the caller **must** invoke `finish()` when command dispatch finishes.
 */
export function createProcessCommandSignalContext(): ProcessCommandSignalContext {
  const controller = new AbortController();
  let stopBudgetMs: (() => number | undefined) | undefined;
  let disposeEmbedded: (() => Promise<void>) | undefined;
  let provisioningPending = false;
  let markHandlerSettled!: () => void;
  const handlerSettled = new Promise<void>((resolve) => {
    markHandlerSettled = resolve;
  });

  const shutdown = installHostShutdown({
    label: 'cli',
    signals: CLI_COMMAND_ABORT_SIGNALS,
    steps: [
      {
        name: 'command',
        // While the embedded bus is still being provisioned there is no handler to wind down
        // and the stage returns at once; the boot is cancelled and bounded by the next stage.
        budgetMs: () => outerBoundMs(commandWindDownMs()),
        run: () => (provisioningPending ? undefined : handlerSettled),
      },
      {
        name: 'embedded runtime',
        // A provider that reports no bound (or none while it is running) leaves the invocation
        // with the router's default: one bounded stop.
        budgetMs: () => outerBoundMs(stopBudgetMs?.() ?? resourceStepStopBudgetMs()),
        run: () => disposeEmbedded?.(),
      },
    ],
    onRequest: (reason) => {
      const signal = toCommandAbortSignal(reason);
      if (signal === undefined) return;
      process.exitCode = CLI_COMMAND_SIGNAL_EXIT_CODES[signal];
      controller.abort(signal);
    },
  });

  return {
    signal: controller.signal,
    onStopBudget: (read) => {
      stopBudgetMs = read;
    },
    adoptEmbeddedBus: (pending) => {
      provisioningPending = true;
      const done = (): void => {
        provisioningPending = false;
      };
      pending.then(done, done);
      let disposing: Promise<void> | undefined;
      disposeEmbedded = () => {
        disposing ??= (async () => {
          // A provisioning that a signal cancelled cleanly has no handle and nothing to dispose. Any
          // other rejection (a failed rollback of the cancelled boot, a failed provisioning) reaches
          // the shutdown, which must end with failure: the dispatcher drops its copy of it once the
          // signal has aborted.
          const handle = await pending.catch((error: unknown) => {
            if (readCancellation(error, controller.signal)?.length === 0) return null;
            throw error;
          });
          await handle?.dispose();
        })().catch((error: unknown) => {
          disposing = undefined;
          throw error;
        });
        return disposing;
      };
      return disposeEmbedded;
    },
    handlerSettled: () => markHandlerSettled(),
    finish: async () => {
      markHandlerSettled();
      shutdown.release();
      await shutdown.finished();
    },
  };
}

/**
 * Report a command-dispatch failure using the local CLI error convention.
 * @param error - Error or thrown value to report.
 */
export function reportCommandFailure(error: unknown): void {
  console.error(`Command failed:`, error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

/**
 * Dispose a resolved CLI bus without letting teardown failures bypass command error handling.
 * @param resolved - Resolved bus handle for the current invocation, if one was created.
 */
export async function disposeResolvedBusForCommand(resolved: ResolvedCliBus | undefined): Promise<void> {
  try {
    await resolved?.dispose();
  } catch (error) {
    reportCommandFailure(error);
  }
}

/**
 * Finish one command invocation: declare the handler settled, dispose what the
 * command owns, and give the process signals back. Every dispatcher calls it
 * from its `finally` block.
 * @param resolved - Resolved bus handle for the current invocation, if one was created.
 * @param signalContext - Signal context of the invocation.
 */
export async function finishCommand(
  resolved: ResolvedCliBus | undefined,
  signalContext: ProcessCommandSignalContext,
): Promise<void> {
  signalContext.handlerSettled();
  await disposeResolvedBusForCommand(resolved);
  await signalContext.finish();
}

/**
 * Create the process-backed command context for local CLI execution.
 *
 * By default this creates its own signal context. Command dispatchers that
 * allocate resources before handler invocation should create a
 * {@link ProcessCommandSignalContext} earlier and pass it here, so signals
 * received during embedded boot or `beforeRun` still abort the handler signal
 * while outer `finally` blocks dispose command-owned resources.
 * @param args - Parsed command arguments.
 * @param bus - Connected bus instance.
 * @param signalContext - Optional pre-created signal context for this invocation.
 * @returns Context and a `finish` function that gives the process signals back.
 */
export function createProcessCommandContext<TArgs>(
  args: TArgs,
  bus: IMakaioBus | null,
  signalContext: ProcessCommandSignalContext = createProcessCommandSignalContext(),
): ProcessCommandContextResult<TArgs> {
  const context: CommandContext<TArgs> = {
    args,
    bus,
    output: {
      write: (text: string) => void process.stdout.write(text),
      error: (text: string) => void process.stderr.write(text),
    },
    signal: signalContext.signal,
    setExitCode: (exitCode: number) => {
      process.exitCode = exitCode;
    },
  };

  return {
    context,
    finish: signalContext.finish,
  };
}

/**
 * Disconnect a command bus without letting teardown failures escape.
 * @param bus - Bus instance to disconnect.
 */
export function disconnectBusSafely(bus: IMakaioBus): void {
  try {
    bus.disconnect();
  } catch (err) {
    console.warn('Failed to disconnect bus:', err instanceof Error ? err.message : err);
  }
}

/**
 * Stop command dispatch once the process-backed command signal has fired.
 *
 * The signal handler already set `process.exitCode` to the conventional
 * signal-specific value. Pre-run gates must not run after that point or
 * overwrite the signal exit with their own policy/connection failure code.
 * @param signal - Command abort signal for this invocation.
 * @returns Whether command dispatch should return immediately.
 */
export function shouldStopForCommandSignal(signal: AbortSignal): boolean {
  return signal.aborted;
}

// ---------------------------------------------------------------------------
// beforeRun gate — shared between schema-adapter and manifest-commands
// ---------------------------------------------------------------------------

/** Outcome of {@link evaluateBeforeRunGate}. */
export type BeforeRunGateResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly message: string; readonly exitCode: number };

/**
 * Determine whether an unknown hook value satisfies the CLI beforeRun result contract.
 * @param value - Value returned by a beforeRun hook.
 * @returns Whether the value is a valid {@link BeforeRunResult}.
 */
function isBeforeRunResult(value: unknown): value is BeforeRunResult {
  if (typeof value !== 'object' || value === null || !('proceed' in value)) {
    return false;
  }

  const result = value as { readonly proceed: unknown; readonly message?: unknown; readonly exitCode?: unknown };
  if (result.proceed === true) {
    return true;
  }

  return (
    result.proceed === false &&
    typeof result.message === 'string' &&
    (result.exitCode === undefined || typeof result.exitCode === 'number')
  );
}

/**
 * Evaluate the `beforeRun` gate for a CLI command invocation.
 *
 * When `beforeRun` is defined, it replaces the default bus-required gate.
 * When absent, the default gate requires a non-null bus. Errors thrown by
 * `beforeRun` are caught and surfaced as a blocked result.
 * @param beforeRun - The contribution's optional gate hook.
 * @param context - Gate context (subcommand name, args, bus).
 * @param connectionError - Human-readable connection failure reason.
 * @returns Whether the handler is allowed to execute.
 */
export async function evaluateBeforeRunGate(
  // Accepts `unknown` return so the isBeforeRunResult guard catches malformed results.
  beforeRun: ((context: BeforeRunContext) => unknown | Promise<unknown>) | undefined,
  context: BeforeRunContext,
  connectionError?: string,
): Promise<BeforeRunGateResult> {
  if (beforeRun) {
    let result: unknown;
    try {
      result = await beforeRun(context);
    } catch (err) {
      return {
        allowed: false,
        message: `beforeRun hook failed: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      };
    }
    if (!isBeforeRunResult(result)) {
      return {
        allowed: false,
        message: 'beforeRun hook failed: hook returned an invalid result',
        exitCode: 1,
      };
    }
    if (!result.proceed) {
      return { allowed: false, message: result.message, exitCode: result.exitCode ?? 1 };
    }
    return { allowed: true };
  }

  if (!context.bus) {
    return { allowed: false, message: formatConnectionError(connectionError), exitCode: 1 };
  }

  return { allowed: true };
}
