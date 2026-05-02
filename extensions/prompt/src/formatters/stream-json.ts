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

// ─── Claude JSONL wire types ──────────────────────────────────────────────────

/** Claude system-init envelope emitted on agent.started. */
interface ClaudeSystemInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string | null;
  cwd: string | null;
}

/** Claude assistant message envelope carrying one or more content blocks. */
interface ClaudeAssistantMessage {
  type: 'assistant';
  message: {
    content: ClaudeContentBlock[];
  };
}

/** Claude user message envelope wrapping a single tool result. */
interface ClaudeUserMessage {
  type: 'user';
  message: {
    content: [ClaudeToolResultBlock];
  };
}

/** Claude result envelope emitted at flush time. */
interface ClaudeResult {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  model: string | null;
  total_cost_usd: number | null;
  usage: ClaudeUsage;
}

/** Accumulated usage in Claude snake_case wire format. */
interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

type ClaudeContentBlock = ClaudeThinkingBlock | ClaudeTextBlock | ClaudeToolUseBlock;

/** Thinking block for extended reasoning content. */
interface ClaudeThinkingBlock {
  type: 'thinking';
  thinking: string;
}

/** Plain text assistant content block. */
interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

/** Tool invocation block emitted by the assistant. */
interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Tool execution result block sent by the user role. */
interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

// ─── StreamJsonFormatter ──────────────────────────────────────────────────────

/**
 * Formats Makaio bus events as Claude-compatible JSONL written to stdout in real-time.
 *
 * Each handled bus event produces exactly one JSONL line (JSON.stringify followed by a
 * newline character) written immediately via the provided {@link OutputWriter}. Accumulated
 * state (usage, turn count, result text, session metadata) is flushed as a result envelope
 * on {@link flush}.
 *
 * Event to JSONL mapping:
 * - `agent.started`         → system/init line
 * - `agent.reasoning_delta` → assistant thinking block
 * - `agent.message_delta`   → assistant text block (streamed)
 * - `agent.message`         → assistant text block (only if no deltas received)
 * - `agent.tool.use`        → assistant tool_use block
 * - `agent.tool.completed`  → user tool_result block
 * - `agent.usage`           → accumulated (no immediate output)
 * - `agent.turn.completed`  → turn counter increment (no immediate output)
 * - `agent.complete`        → error category capture (no immediate output)
 * - flush                   → result envelope
 */
export class StreamJsonFormatter implements OutputFormatter {
  /** Accumulated result text from message_delta/message events for the final result envelope. */
  private text = '';

  /** Whether any `agent.message_delta` events were received this turn. */
  private receivedDeltas = false;

  /** Accumulated token usage across all `agent.usage` events. */
  private readonly usage: AccumulatedUsage = createEmptyUsage();

  /** Number of completed turns observed via `agent.turn.completed`. */
  private turnCount = 0;

  /** Error category captured from `agent.complete`, used to compute the exit code. */
  private errorCategory: ErrorCategory | undefined = undefined;

  /** Model identifier captured from `agent.started` (fallback when usage carries none). */
  private model: string | null = null;

  /**
   * @param sessionId - The Makaio session identifier for this run.
   * @param startTime - Epoch milliseconds when the run began, used to compute duration_ms.
   * @param writer - Output abstraction used to write JSONL lines.
   */
  public constructor(
    private readonly sessionId: string,
    private readonly startTime: number,
    private readonly writer: OutputWriter,
  ) {}

  /**
   * Handle a bus event received from agent/session subscriptions.
   *
   * Unrecognised subjects are silently ignored. Payloads that fail Zod
   * schema validation are silently dropped so that unknown future event shapes
   * do not crash the formatter.
   * @param subject - Bus subject string (e.g., `agent.message_delta`).
   * @param payload - Event payload (validated internally before use).
   */
  public handleEvent(subject: string, payload: unknown): void {
    switch (subject) {
      case 'agent.started':
        this.handleStarted(payload);
        break;
      case 'agent.reasoning_delta':
        this.handleReasoningDelta(payload);
        break;
      case 'agent.message_delta':
        this.handleMessageDelta(payload);
        break;
      case 'agent.message':
        this.handleMessage(payload);
        break;
      case 'agent.tool.use':
        this.handleToolUse(payload);
        break;
      case 'agent.tool.completed':
        this.handleToolCompleted(payload);
        break;
      case 'agent.usage':
        this.handleUsage(payload);
        break;
      case 'agent.turn.completed':
        this.turnCount += 1;
        break;
      case 'agent.complete':
        this.handleComplete(payload);
        break;
      default:
        break;
    }
  }

  /**
   * Flush final output and return the exit code.
   *
   * Emits the result envelope as a JSONL line and returns a numeric exit code
   * derived from the error category observed during the run.
   * @param turnResult - The session turn-completed payload.
   * @returns Exit code: 0 success, 1 error, 2 rate limit.
   */
  public flush(turnResult: TurnResult): number {
    const durationMs = Date.now() - this.startTime;
    const isError = !turnResult.success;

    const resultLine: ClaudeResult = {
      type: 'result',
      subtype: isError ? 'error' : 'success',
      is_error: isError,
      duration_ms: durationMs,
      num_turns: Math.max(this.turnCount, turnResult.turnNumber),
      result: turnResult.success ? this.text : (turnResult.error ?? ''),
      session_id: this.sessionId,
      model: this.usage.model ?? this.model,
      total_cost_usd: this.usage.cost,
      usage: toClaudeUsage(this.usage),
    };

    this.writeLine(resultLine);

    return resolveExitCode(this.errorCategory, turnResult.success);
  }

  // ─── Private event handlers ────────────────────────────────────────────────

  /**
   * Emit a system/init line and capture session metadata for later use.
   * @param payload - Raw agent.started payload.
   */
  private handleStarted(payload: unknown): void {
    const parsed = AgentSchemas['started'].safeParse(payload);
    if (!parsed.success) {
      return;
    }

    this.model = parsed.data.model;

    const line: ClaudeSystemInit = {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      model: parsed.data.model,
      cwd: parsed.data.cwd,
    };

    this.writeLine(line);
  }

  /**
   * Emit an assistant thinking block from a reasoning_delta event.
   * @param payload - Raw agent.reasoning_delta payload.
   */
  private handleReasoningDelta(payload: unknown): void {
    const parsed = AgentSchemas['reasoning_delta'].safeParse(payload);
    if (!parsed.success) {
      return;
    }

    const line: ClaudeAssistantMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: parsed.data.content }],
      },
    };

    this.writeLine(line);
  }

  /**
   * Emit an assistant text block and accumulate text for the result envelope.
   * @param payload - Raw agent.message_delta payload.
   */
  private handleMessageDelta(payload: unknown): void {
    const parsed = AgentSchemas['message_delta'].safeParse(payload);
    if (!parsed.success) {
      return;
    }

    this.receivedDeltas = true;
    this.text += parsed.data.text;

    const line: ClaudeAssistantMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: parsed.data.text }],
      },
    };

    this.writeLine(line);
  }

  /**
   * Emit an assistant text block only when no streaming deltas were received.
   *
   * This is the non-streaming fallback: when an adapter emits a complete
   * message in a single event rather than as a stream of deltas, we emit it
   * as a single text block and store it as the result text.
   * @param payload - Raw agent.message payload.
   */
  private handleMessage(payload: unknown): void {
    if (this.receivedDeltas) {
      return;
    }

    const parsed = AgentSchemas['message'].safeParse(payload);
    if (!parsed.success) {
      return;
    }

    this.text = parsed.data.content;

    const line: ClaudeAssistantMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: parsed.data.content }],
      },
    };

    this.writeLine(line);
  }

  /**
   * Emit an assistant tool_use block.
   * @param payload - Raw agent.tool.use payload.
   */
  private handleToolUse(payload: unknown): void {
    const parsed = AgentSchemas['tool.use'].safeParse(payload);
    if (!parsed.success) {
      return;
    }

    const line: ClaudeAssistantMessage = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: parsed.data.toolCallId,
            name: parsed.data.toolName,
            input: parsed.data.args ?? {},
          },
        ],
      },
    };

    this.writeLine(line);
  }

  /**
   * Emit a user tool_result block.
   *
   * The `result` field is JSON-stringified when it is not already a plain string.
   * The `is_error` field is the logical inverse of the `success` flag; an absent
   * `success` field is treated as success (is_error = false) for backward compatibility.
   * @param payload - Raw agent.tool.completed payload.
   */
  private handleToolCompleted(payload: unknown): void {
    const parsed = AgentSchemas['tool.completed'].safeParse(payload);
    if (!parsed.success) {
      return;
    }

    const { result, success, toolCallId } = parsed.data;
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    const isError = success === undefined ? false : !success;

    const line: ClaudeUserMessage = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content,
            is_error: isError,
          },
        ],
      },
    };

    this.writeLine(line);
  }

  /**
   * Accumulate token usage metrics from an agent.usage event.
   * @param payload - Raw agent.usage payload.
   */
  private handleUsage(payload: unknown): void {
    const parsed = AgentSchemas['usage'].safeParse(payload);
    if (!parsed.success) return;
    accumulateUsage(this.usage, parsed.data);
  }

  /**
   * Capture the error category from an agent.complete event for exit code resolution.
   * @param payload - Raw agent.complete payload.
   */
  private handleComplete(payload: unknown): void {
    const parsed = AgentSchemas['complete'].safeParse(payload);
    if (!parsed.success) {
      return;
    }

    if (parsed.data.errorCategory !== undefined) {
      this.errorCategory = parsed.data.errorCategory;
    }
  }

  /**
   * Serialize a value as a JSONL line and write it to the output writer.
   * @param value - The object to serialize.
   */
  private writeLine(value: object): void {
    this.writer.write(`${JSON.stringify(value)}\n`);
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Map {@link AccumulatedUsage} to the Claude snake_case usage shape.
 * @param usage - Internal accumulated usage counters.
 * @returns Claude-compatible usage object.
 */
function toClaudeUsage(usage: AccumulatedUsage): ClaudeUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
  };
}
