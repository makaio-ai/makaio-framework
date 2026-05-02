import { AgentSchemas } from '@makaio/contracts';
import type { ErrorCategory } from '@makaio/contracts';
import { resolveExitCode, type OutputFormatter, type OutputWriter, type TurnResult } from './types.js';

/**
 * Plain-text output formatter.
 *
 * Collects streaming text from `agent.message_delta` events, falling back to
 * `agent.message` when no deltas were received, then writes the result to
 * stdout on {@link flush}.
 */
export class TextFormatter implements OutputFormatter {
  private text = '';
  private receivedDeltas = false;
  private errorCategory: ErrorCategory | undefined = undefined;

  /**
   * @param output - Writer abstraction for stdout/stderr.
   */
  public constructor(private readonly output: OutputWriter) {}

  /**
   * Handle a bus event received from agent/session subscriptions.
   * @param subject - Bus subject string (e.g. `agent.message_delta`).
   * @param payload - Event payload.
   */
  public handleEvent(subject: string, payload: unknown): void {
    if (subject === 'agent.message_delta') {
      const parsed = AgentSchemas['message_delta'].safeParse(payload);
      if (parsed.success) {
        this.receivedDeltas = true;
        this.text += parsed.data.text;
      }
    } else if (subject === 'agent.message' && !this.receivedDeltas) {
      const parsed = AgentSchemas['message'].safeParse(payload);
      if (parsed.success) {
        this.text = parsed.data.content;
      }
    } else if (subject === 'agent.complete') {
      const parsed = AgentSchemas['complete'].safeParse(payload);
      if (parsed.success) {
        this.errorCategory = parsed.data.errorCategory;
      }
    }
  }

  /**
   * Flush final output and return the exit code.
   *
   * Writes buffered text to stdout on success, appending a trailing newline
   * when the text is non-empty but does not already end with one.
   * @param turnResult - The session.turn.completed payload.
   * @returns Exit code: 0 success, 1 error, 2 rate limit.
   */
  public flush(turnResult: TurnResult): number {
    const exitCode = resolveExitCode(this.errorCategory, turnResult.success);
    if (turnResult.success) {
      this.output.write(this.text);
      if (this.text.length > 0 && !this.text.endsWith('\n')) {
        this.output.write('\n');
      }
    } else if (turnResult.error) {
      this.output.error(`Error: ${turnResult.error}\n`);
    }
    return exitCode;
  }
}
