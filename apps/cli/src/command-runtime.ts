import type { IMakaioBus } from '@makaio/bus-core';
import type {
  BeforeRunContext,
  BeforeRunResult,
  CommandContext,
  CliContribution,
  ProvideBusContext,
} from '@makaio/kernel/cli';
import { formatConnectionError } from './connection-error.js';
import { CLI_COMMAND_ABORT_SIGNALS, CLI_COMMAND_SIGNAL_EXIT_CODES } from '@makaio/utils';

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
 * @returns A resolved bus handle with a unified `dispose` contract.
 */
export async function resolveContributionBus(
  externalBus: IMakaioBus | null,
  provideBus: CliContribution['provideBus'],
  subcommandName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<ResolvedCliBus> {
  if (externalBus !== null) {
    return { bus: externalBus, dispose: noopDispose };
  }

  if (provideBus) {
    const context: ProvideBusContext = { subcommandName, args, cwd };
    const handle = await provideBus(context);
    if (handle !== null) {
      return { bus: handle.bus, dispose: () => handle.dispose() };
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
 * Callers must invoke `cleanup()` when the command finishes (typically in a
 * `finally` block) to remove process signal listeners if no signal was received.
 * @typeParam TArgs - Inferred from the command's Zod schema.
 */
export interface ProcessCommandContextResult<TArgs> {
  /** The command context to pass to the handler. */
  readonly context: CommandContext<TArgs>;
  /**
   * Remove process signal listeners registered for this command.
   *
   * Must be called when the command completes (success or failure) so the
   * listeners do not accumulate across many commands in a long-lived process.
   * Calling this after a signal has already fired is safe (a no-op).
   */
  cleanup(): void;
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
  /** Remove process signal listeners registered for this invocation. */
  cleanup(): void;
}

/**
 * Create a process-backed signal context for local CLI execution.
 *
 * Registers one-shot handlers for command-abort process signals. Each handler
 * aborts the returned `signal` and sets the conventional signal exit code.
 * This intentionally gives command `finally` blocks a chance to dispose
 * embedded runtimes instead of letting Node terminate immediately.
 * The caller **must** invoke `cleanup()` when command dispatch finishes so the
 * listeners are removed if no signal was received.
 * @returns Signal context and a `cleanup` function to remove registered signal listeners.
 */
export function createProcessCommandSignalContext(): ProcessCommandSignalContext {
  const controller = new AbortController();
  let cleaned = false;
  const listeners = CLI_COMMAND_ABORT_SIGNALS.map((signal) => {
    const listener: NodeJS.SignalsListener = () => onSignal(signal);
    process.once(signal, listener);
    return { signal, listener };
  });
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const { signal, listener } of listeners) {
      process.off(signal, listener);
    }
  };
  const onSignal = (signal: CommandAbortSignal) => {
    if (!controller.signal.aborted) {
      cleanup();
      controller.abort(signal);
      process.exitCode = CLI_COMMAND_SIGNAL_EXIT_CODES[signal];
    }
  };

  return {
    signal: controller.signal,
    cleanup,
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
 * @returns Context and a `cleanup` function to remove the registered signal listeners.
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
    cleanup: signalContext.cleanup,
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
