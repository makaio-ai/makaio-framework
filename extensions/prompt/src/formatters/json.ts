import { AgentSchemas } from '@makaio/contracts';
import type { ErrorCategory } from '@makaio/contracts';
import {
  accumulateUsage,
  createEmptyUsage,
  resolveExitCode,
  type AccumulatedUsage,
  type OutputFormatter,
  type OutputWriter,
  type TurnResult,
} from './types.js';

/**
 * The single JSON envelope emitted to stdout on flush.
 * Follows the design-doc specification for Claude-compatible output.
 */
interface ResultEnvelope {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  model: string | null;
  total_cost_usd: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * JSON output formatter for the `makaio prompt` CLI extension.
 *
 * Buffers all agent bus events during a turn and emits a single
 * Claude-compatible JSON result envelope to stdout on `flush()`.
 *
 * Lifecycle: construct → `handleEvent()` (zero or more times) → `flush()` (once).
 */
export class JsonFormatter implements OutputFormatter {
  private readonly textChunks: string[] = [];
  private readonly usage: AccumulatedUsage = createEmptyUsage();
  private receivedDeltas = false;
  private turnCount = 0;
  private errorCategory: ErrorCategory | undefined = undefined;

  /**
   * @param writer - Output destination for the final JSON envelope.
   * @param startedAt - Epoch milliseconds when command execution started.
   */
  public constructor(
    private readonly writer: OutputWriter,
    private readonly startedAt: number = Date.now(),
  ) {}

  /**
   * Handle a bus event.
   *
   * Payloads are validated via {@link AgentSchemas} safeParse; malformed
   * events are silently dropped. Unknown subjects are ignored.
   * @param subject - Bus subject string.
   * @param payload - Event payload.
   */
  public handleEvent(subject: string, payload: unknown): void {
    switch (subject) {
      case 'agent.message_delta': {
        const parsed = AgentSchemas['message_delta'].safeParse(payload);
        if (parsed.success) {
          this.receivedDeltas = true;
          this.textChunks.push(parsed.data.text);
        }
        break;
      }
      case 'agent.message': {
        const parsed = AgentSchemas['message'].safeParse(payload);
        if (parsed.success && !this.receivedDeltas)
          this.textChunks.splice(0, this.textChunks.length, parsed.data.content);
        break;
      }
      case 'agent.usage': {
        const parsed = AgentSchemas['usage'].safeParse(payload);
        if (parsed.success) accumulateUsage(this.usage, parsed.data);
        break;
      }
      case 'agent.turn.completed': {
        this.turnCount += 1;
        break;
      }
      case 'agent.complete': {
        const parsed = AgentSchemas['complete'].safeParse(payload);
        if (parsed.success) this.errorCategory = parsed.data.errorCategory;
        break;
      }
      default:
        break;
    }
  }

  /**
   * Emit the final JSON result envelope and return the exit code.
   * @param turnResult - The session.turn.completed payload.
   * @returns Exit code: 0 success, 1 error, 2 rate limit.
   */
  public flush(turnResult: TurnResult): number {
    const exitCode = resolveExitCode(this.errorCategory, turnResult.success);
    const isError = exitCode !== 0;

    const envelope: ResultEnvelope = {
      type: 'result',
      subtype: isError ? 'error' : 'success',
      is_error: isError,
      duration_ms: Date.now() - this.startedAt,
      num_turns: Math.max(this.turnCount, turnResult.turnNumber),
      result: turnResult.success ? this.textChunks.join('') : (turnResult.error ?? ''),
      session_id: turnResult.sessionId,
      model: this.usage.model,
      total_cost_usd: this.usage.cost,
      usage: {
        inputTokens: this.usage.inputTokens,
        outputTokens: this.usage.outputTokens,
      },
    };

    this.writer.write(`${JSON.stringify(envelope)}\n`);
    return exitCode;
  }
}
