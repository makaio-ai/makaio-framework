/**
 * Bounded capture of the stdout and stderr of one launched command.
 *
 * Both streams share one byte budget. Each stream is decoded as UTF-8 across
 * chunk boundaries. The chunk that crosses the budget is cut at the limit and
 * everything after it is dropped; a multi-byte character cut by the limit is
 * dropped with it rather than replaced.
 */

/** Text a launched command wrote to its output streams. */
export interface LaunchCapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/** Which output stream a chunk came from. */
export type LaunchOutputStream = 'stdout' | 'stderr';

/** Collector of the output of one command; see {@link createOutputCapture}. */
export interface OutputCapture {
  /**
   * Take one chunk of a stream. The first chunk that exceeds the budget is cut
   * at the limit and calls `onLimit` once; later chunks are dropped.
   */
  push(stream: LaunchOutputStream, chunk: Buffer): void;
  /** End the capture and return the text; call once, after the last chunk. */
  finish(): LaunchCapturedOutput;
}

/**
 * Create a capture with a shared byte budget.
 * @param limitBytes - Most bytes retained over both streams together.
 * @param onLimit - Called once, when output beyond the budget arrives.
 * @returns The collector.
 */
export function createOutputCapture(limitBytes: number, onLimit: () => void): OutputCapture {
  const decoders: Record<LaunchOutputStream, TextDecoder> = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const text: Record<LaunchOutputStream, string> = { stdout: '', stderr: '' };
  let retained = 0;
  let truncated = false;
  return {
    push(stream, chunk) {
      if (truncated) return;
      const room = limitBytes - retained;
      const exceeds = chunk.length > room;
      const accepted = exceeds ? chunk.subarray(0, room) : chunk;
      retained += accepted.length;
      text[stream] += decoders[stream].decode(accepted, { stream: true });
      if (exceeds) {
        truncated = true;
        onLimit();
      }
    },
    finish() {
      if (!truncated) {
        text.stdout += decoders.stdout.decode();
        text.stderr += decoders.stderr.decode();
      }
      return { stdout: text.stdout, stderr: text.stderr };
    },
  };
}
