import type { IMakaioBus } from '@makaio/bus-core';
import type { CommandContext } from '@makaio/kernel/cli';

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
export function createProcessCommandContext<TArgs>(args: TArgs, bus: IMakaioBus): ProcessCommandContextResult<TArgs> {
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
