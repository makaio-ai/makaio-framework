/**
 * Pure builders for agent sessions that never link to a workflow execution.
 * @packageDocumentation
 */

import type { SpanDraft } from '../contracts/types.js';
import { SpanBuilder } from './span-builder.js';
import type { BufferedToolCall, UnresolvedToolCall, UnresolvedUsage } from './types.js';

type ToolLifecycle = BufferedToolCall | UnresolvedToolCall;

/** Result of a bounded export attempt sequence. */
export type ExportAttemptResult =
  | { readonly success: true; readonly recovered: boolean }
  | { readonly success: false; readonly error: unknown };

/** Input for {@link buildStandaloneSessionTrace}. */
export interface StandaloneSessionTraceInput {
  /** Agent session identifier. */
  readonly sessionId: string;
  /** Collector-local segment number. */
  readonly segment: number;
  /** Usage events retained during the late-correlation window. */
  readonly usages: readonly UnresolvedUsage[];
  /** Tool events retained during the late-correlation window. */
  readonly tools: readonly UnresolvedToolCall[];
  /** End timestamp for tool calls without a completion event. */
  readonly fallbackEndedAt: number;
}

/**
 * Merge lifecycle state retained across an export with events that arrived while it was in flight.
 * @param retained - Lifecycle state removed for the attempted export.
 * @param current - State observed after the export started.
 * @returns One lifecycle that preserves the earliest start and strongest terminal event.
 */
export function mergeRetainedToolLifecycle<T extends ToolLifecycle>(retained: T, current: T | undefined): T {
  if (current === undefined) return retained;
  const currentTerminalWins =
    current.endedAt !== undefined && (retained.endedAt === undefined || current.endedAt >= retained.endedAt);
  const terminalWinner = currentTerminalWins ? current : retained;
  const terminalFallback = currentTerminalWins ? retained : current;
  return {
    ...current,
    toolName: retained.toolName,
    startedAt: Math.min(retained.startedAt, current.startedAt),
    ingestedAt: Math.min(retained.ingestedAt, current.ingestedAt),
    endedAt: terminalWinner.endedAt,
    success: terminalWinner.success ?? terminalFallback.success,
  };
}

/**
 * Run one export operation with a bounded retry budget.
 * @param attempts - Maximum number of attempts, including the first call.
 * @param operation - Export operation to invoke.
 * @param recover - Optional failure hook that returns true when correlation recovery handled the batch.
 * @returns A discriminated success or final-failure result.
 */
export async function retryExport(
  attempts: number,
  operation: () => Promise<void>,
  recover?: (error: unknown) => boolean | Promise<boolean>,
): Promise<ExportAttemptResult> {
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return { success: true, recovered: false };
    } catch (error) {
      if (await recover?.(error)) return { success: true, recovered: true };
      failure = error;
    }
  }
  return { success: false, error: failure };
}

/**
 * Build one standalone session root plus its LLM and tool child spans.
 * @param input - Session identity, events, segment, and fallback timing.
 * @returns Ordered span drafts with the root first.
 */
export function buildStandaloneSessionTrace(input: StandaloneSessionTraceInput): SpanDraft[] {
  const usageTimes = input.usages.map((usage) => {
    const endedAt = usage.occurredAt ?? usage.ingestedAt;
    return { startedAt: endedAt - (usage.duration ?? 0), endedAt };
  });
  let startedAt = Number.POSITIVE_INFINITY;
  let endedAt = Number.NEGATIVE_INFINITY;
  for (const time of usageTimes) {
    startedAt = Math.min(startedAt, time.startedAt);
    endedAt = Math.max(endedAt, time.endedAt);
  }
  for (const tool of input.tools) {
    startedAt = Math.min(startedAt, tool.startedAt);
    endedAt = Math.max(endedAt, tool.endedAt ?? input.fallbackEndedAt);
  }
  const drafts: SpanDraft[] = [
    SpanBuilder.buildStandaloneSessionSpan({
      sessionId: input.sessionId,
      segment: input.segment,
      startedAt,
      endedAt,
    }),
  ];

  for (const [sequence, usage] of input.usages.entries()) {
    const usageEndedAt = usage.occurredAt ?? usage.ingestedAt;
    drafts.push(
      SpanBuilder.buildStandaloneLlmSpan({
        ...usage,
        sessionId: input.sessionId,
        sequence,
        segment: input.segment,
        startedAt: usageEndedAt - (usage.duration ?? 0),
        endedAt: usageEndedAt,
      }),
    );
  }
  for (const tool of input.tools) {
    drafts.push(
      SpanBuilder.buildStandaloneToolSpan({
        ...tool,
        sessionId: input.sessionId,
        segment: input.segment,
        endedAt: tool.endedAt ?? input.fallbackEndedAt,
      }),
    );
  }

  return drafts;
}
