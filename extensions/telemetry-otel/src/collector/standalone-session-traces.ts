/**
 * Pure builders for agent sessions that never link to a workflow execution.
 * @packageDocumentation
 */

import type { SpanDraft } from '../contracts/types.js';
import { SpanBuilder } from './span-builder.js';
import type { UnresolvedToolCall, UnresolvedUsage } from './types.js';

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
