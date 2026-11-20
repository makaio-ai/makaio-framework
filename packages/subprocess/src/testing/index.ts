/**
 * Test doubles for code that takes the start port (`LaunchFunction`) as a parameter.
 * @packageDocumentation
 */
import type { LaunchFunction, LaunchOptions, LaunchResult } from '../launch.js';

/** A start port that records every call; see {@link recordingLaunch}. */
export interface RecordingLaunch {
  readonly launch: LaunchFunction;
  /** The options of every call, in order. */
  readonly calls: LaunchOptions[];
}

/**
 * Result of a call beyond the given results: completed, with empty captured output when the
 * call asked for capture, as a real completed launch has.
 * @param options - The options of that call.
 * @returns The completed result.
 */
function completed(options: LaunchOptions): LaunchResult {
  return options.output.kind === 'capture'
    ? { status: 'completed', output: { stdout: '', stderr: '' } }
    : { status: 'completed' };
}

/**
 * Build an implementation of the start port that starts nothing: it records the options it got and
 * returns a process whose result is already settled.
 * @param results - Result of the first call, the second call, and so on; later calls complete, with empty captured output when capture was requested.
 * @returns The port and the recorded options.
 */
export function recordingLaunch(...results: readonly LaunchResult[]): RecordingLaunch {
  const calls: LaunchOptions[] = [];
  const launch: LaunchFunction = (options) => {
    calls.push(options);
    return { pid: undefined, result: Promise.resolve(results[calls.length - 1] ?? completed(options)) };
  };
  return { launch, calls };
}
