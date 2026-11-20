/**
 * The common caller of `launch`: run one command, keep its captured output on
 * success, and keep the failure for the caller to word.
 */
import { launch as realLaunch, type LaunchFunction, type LaunchOptions, type LaunchResult } from './launch.js';

/** Options of {@link launchForOutput}: those of `launch`, with the output always captured. */
export interface LaunchForOutputOptions extends Omit<LaunchOptions, 'output'> {
  /** Longest captured output, in bytes, stdout and stderr together. */
  readonly outputLimitBytes: number;
}

/** What {@link launchForOutput} reports; a failure carries the whole result for the caller's own message. */
export type LaunchForOutputResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly result: LaunchResult };

/**
 * Run one bounded command and return its output when it completed.
 *
 * A command that did not complete (non-zero exit, timeout, output limit, refusal) comes back as
 * `{ ok: false, result }`: the caller words its own error, so no command argument or output leaks
 * from here. A command cancelled through `options.signal` rethrows the signal's abort reason, so a
 * cancellation stays a cancellation and never becomes a command failure.
 * @param options - The command, its bounds and the output limit.
 * @param launch - The start port; defaults to the real `launch`.
 * @returns The captured output, or the result that explains why there is none.
 * @throws The abort reason of `options.signal` when the command was cancelled.
 */
export async function launchForOutput(
  options: LaunchForOutputOptions,
  launch: LaunchFunction = realLaunch,
): Promise<LaunchForOutputResult> {
  const { outputLimitBytes, ...rest } = options;
  const result = await launch({ ...rest, output: { kind: 'capture', limitBytes: outputLimitBytes } }).result;
  if (result.status === 'cancelled') options.signal?.throwIfAborted();
  if (result.status === 'completed' && result.output !== undefined) {
    return { ok: true, stdout: result.output.stdout, stderr: result.output.stderr };
  }
  return { ok: false, result };
}
