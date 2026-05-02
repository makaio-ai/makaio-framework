import type { TurnUsage, UsageMetrics } from '@makaio/contracts';

/**
 * Minimal subset of an `agent.usage` event required for per-turn aggregation.
 * Only token counts are captured; cost fields require external pricing data.
 */
export interface AgentUsageEvent {
  /** Agent that produced the usage. */
  agentId: string;
  /** Input tokens consumed in this API call. */
  inputTokens: number;
  /** Output tokens produced in this API call. */
  outputTokens: number;
}

/**
 * Accumulates `agent.usage` events during a single turn and produces a
 * {@link TurnUsage} snapshot suitable for persisting to the `turns.usage` column.
 *
 * Intentionally bus-free: the orchestrator owns the subscription and calls
 * `add()` for each event, then calls `flush()` when the turn completes.
 * @example
 * ```typescript
 * const accumulator = new TurnUsageAccumulator();
 * // ...on every agent.usage event during the turn:
 * accumulator.add(usagePayload);
 * // ...on turn completion:
 * const usage = accumulator.flush();
 * await bus.request(TurnStorageSubjects.complete, { turnId, status, usage });
 * ```
 */
export class TurnUsageAccumulator {
  /** Per-agent running totals. */
  private readonly byAgent = new Map<string, UsageMetrics>();

  /**
   * Add a usage event to the accumulator.
   *
   * Only `inputTokens` and `outputTokens` are aggregated; these are the fields
   * captured by `UsageMetrics`. The `cost` field requires external pricing data
   * and is omitted from per-turn aggregation.
   * @param event - Usage event payload from `AgentSubjects.usage`
   */
  public add(event: AgentUsageEvent): void {
    const existing = this.byAgent.get(event.agentId);
    if (existing) {
      existing.inputTokens += event.inputTokens;
      existing.outputTokens += event.outputTokens;
    } else {
      this.byAgent.set(event.agentId, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
    }
  }

  /**
   * Produce an aggregated {@link TurnUsage} snapshot without clearing state.
   *
   * Useful when callers need to persist usage first and only clear the
   * accumulator after durable writes succeed.
   * @returns Aggregated usage or `undefined` if no events were accumulated
   */
  public snapshot(): TurnUsage | undefined {
    if (this.byAgent.size === 0) {
      return undefined;
    }

    let totalInput = 0;
    let totalOutput = 0;
    const byAgentSnapshot: Record<string, UsageMetrics> = {};

    for (const [agentId, metrics] of this.byAgent) {
      totalInput += metrics.inputTokens;
      totalOutput += metrics.outputTokens;
      byAgentSnapshot[agentId] = { ...metrics };
    }

    return {
      total: { inputTokens: totalInput, outputTokens: totalOutput },
      byAgent: byAgentSnapshot,
    };
  }

  /**
   * Produce the aggregated {@link TurnUsage} and reset internal state.
   *
   * Returns `undefined` when no usage events were received (e.g., turn was
   * completed immediately without any AI calls), so callers can omit the
   * field rather than writing a zero-valued record.
   * @returns Aggregated usage or `undefined` if no events were accumulated
   */
  public flush(): TurnUsage | undefined {
    const usage = this.snapshot();
    this.byAgent.clear();
    return usage;
  }

  /**
   * Clear accumulated usage without computing a snapshot.
   */
  public clear(): void {
    this.byAgent.clear();
  }
}
