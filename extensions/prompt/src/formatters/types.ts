import type { z } from 'zod';
import type { ErrorCategory, AgentSchemas } from '@makaio/contracts';

/** Output format selection. */
export type OutputFormat = 'text' | 'json' | 'stream-json';

/**
 * Stateful event consumer that formats agent bus events into CLI output.
 * Lifecycle: construct → handleEvent() calls during turn → flush() on completion.
 */
export interface OutputFormatter {
  /**
   * Handle a bus event received from agent/session subscriptions.
   * @param subject - Bus subject string (e.g., 'agent.message_delta').
   * @param payload - Event payload.
   */
  handleEvent(subject: string, payload: unknown): void;

  /**
   * Flush final output and return the exit code.
   * Called once when the turn completes.
   * @param turnResult - The session.turn.completed payload.
   * @returns Exit code: 0 success, 1 error, 2 rate limit, 124 timeout.
   */
  flush(turnResult: TurnResult): number;
}

/** Subset of session.turn.completed payload needed by formatters. */
export interface TurnResult {
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnNumber: number;
  readonly success: boolean;
  readonly error?: string;
}

/** Accumulated usage from agent.usage events. */
export interface AccumulatedUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number | null;
  model: string | null;
  provider: string | null;
}

/**
 * Create a zero-initialized usage accumulator.
 * @returns A fresh {@link AccumulatedUsage} with all counters set to zero.
 */
export function createEmptyUsage(): AccumulatedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: null,
    model: null,
    provider: null,
  };
}

/** Parsed payload from `agent.usage` bus events. */
type UsageEvent = z.infer<(typeof AgentSchemas)['usage']>;

/**
 * Accumulate a parsed usage event into an {@link AccumulatedUsage} in-place.
 * @param acc - Mutable usage accumulator to update.
 * @param usage - Parsed payload from an `agent.usage` bus event.
 */
export function accumulateUsage(acc: AccumulatedUsage, usage: UsageEvent): void {
  acc.inputTokens += usage.inputTokens;
  acc.outputTokens += usage.outputTokens;
  acc.reasoningTokens += usage.reasoningTokens;
  acc.cacheReadTokens += usage.inputCachedTokens;
  acc.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  acc.totalTokens += usage.totalTokens;

  if (usage.cost !== undefined) {
    acc.cost = (acc.cost ?? 0) + usage.cost;
  }

  acc.model = usage.model;
  acc.provider = usage.provider;
}

/** OutputWriter abstraction from CommandContext. */
export interface OutputWriter {
  write(text: string): void;
  error(text: string): void;
}

// ---------------------------------------------------------------------------
// Shared exit codes
// ---------------------------------------------------------------------------

/** Successful completion. */
export const EXIT_SUCCESS = 0;
/** General error. */
export const EXIT_ERROR = 1;
/** Rate-limit error from the provider. */
export const EXIT_RATE_LIMIT = 2;

/**
 * Resolve the process exit code from the observed error category and turn success flag.
 * @param errorCategory - Optional error category from `agent.complete`.
 * @param success - Whether the turn completed successfully.
 * @returns Numeric exit code.
 */
export function resolveExitCode(errorCategory: ErrorCategory | undefined, success: boolean): number {
  if (!success && errorCategory === 'rate_limit') return EXIT_RATE_LIMIT;
  if (!success) return EXIT_ERROR;
  return EXIT_SUCCESS;
}
