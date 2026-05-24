/**
 * CLI argument parsing for the git hook receiver binary.
 *
 * The receiver is invoked by native Git wrapper scripts with the following
 * convention:
 *
 *   git-hook-receiver --event <name> --state <path> [-- [hookArgv...]]
 *
 * Arguments after `--` are the native hook arguments forwarded by the wrapper.
 * @packageDocumentation
 */

/**
 * Parsed arguments for the git hook receiver process.
 */
export interface GitHookReceiverArgs {
  /** Native Git hook event name (e.g. `'post-commit'`, `'post-checkout'`). */
  readonly eventName: string;
  /**
   * Absolute path to the install state file written at hook installation time.
   *
   * Used to locate the install record for diagnostic purposes.
   */
  readonly stateFile: string;
  /** Hook arguments forwarded after `--` by the wrapper script. */
  readonly argv: readonly string[];
}

/**
 * Parse receiver arguments from raw process argv.
 *
 * Splits on `--` to separate receiver options from forwarded hook arguments.
 * @param argv - Raw process argv after stripping the node and script path
 *   (i.e. `process.argv.slice(2)`).
 * @returns Parsed receiver arguments.
 * @throws When `--event` or `--state` are missing.
 */
export function parseReceiverArgs(argv: readonly string[]): GitHookReceiverArgs {
  const separator = argv.indexOf('--');
  const options = separator >= 0 ? argv.slice(0, separator) : argv;
  const hookArgv = separator >= 0 ? argv.slice(separator + 1) : [];

  const eventIndex = options.indexOf('--event');
  const stateIndex = options.indexOf('--state');
  const eventName = eventIndex >= 0 ? options[eventIndex + 1] : undefined;
  const stateFile = stateIndex >= 0 ? options[stateIndex + 1] : undefined;

  if (!eventName) {
    throw new Error('[git-hook-receiver] Missing --event');
  }
  if (!stateFile) {
    throw new Error('[git-hook-receiver] Missing --state');
  }

  return { eventName, stateFile, argv: hookArgv };
}
