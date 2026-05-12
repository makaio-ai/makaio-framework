import type { IMakaioBus } from '@makaio/bus-core';
import type { BeforeRunContext, BeforeRunResult, CommandContext } from '@makaio/kernel/cli';
import { formatConnectionError } from './connection-error.js';

/**
 * Result of {@link createProcessCommandContext}.
 *
 * Callers must invoke `cleanup()` when the command finishes (typically in a
 * `finally` block) to remove the SIGINT listener if no signal was received.
 * @typeParam TArgs - Inferred from the command's Zod schema.
 */
export interface ProcessCommandContextResult<TArgs> {
  /** The command context to pass to the handler. */
  readonly context: CommandContext<TArgs>;
  /**
   * Remove the SIGINT listener registered for this command.
   *
   * Must be called when the command completes (success or failure) so the
   * listener does not accumulate across many commands in a long-lived process.
   * Calling this after SIGINT has already fired is safe (a no-op).
   */
  cleanup(): void;
}

/**
 * Create the process-backed command context for local CLI execution.
 *
 * Registers a one-shot SIGINT handler that aborts the returned `signal` so
 * long-running commands can tear down cleanly when the user presses Ctrl-C.
 * The caller **must** invoke the returned `cleanup()` when the command
 * finishes so the listener is removed if no signal was received.
 * @param args - Parsed command arguments.
 * @param bus - Connected bus instance.
 * @returns Context and a `cleanup` function to remove the SIGINT listener.
 */
export function createProcessCommandContext<TArgs>(
  args: TArgs,
  bus: IMakaioBus | null,
): ProcessCommandContextResult<TArgs> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  const context: CommandContext<TArgs> = {
    args,
    bus,
    output: {
      write: (text: string) => void process.stdout.write(text),
      error: (text: string) => void process.stderr.write(text),
    },
    signal: controller.signal,
    setExitCode: (exitCode: number) => {
      process.exitCode = exitCode;
    },
  };

  return {
    context,
    cleanup: () => process.off('SIGINT', onSigint),
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
