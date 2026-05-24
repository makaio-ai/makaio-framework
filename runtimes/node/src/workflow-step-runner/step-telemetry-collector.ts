import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import type { TokenUsage } from '@makaio/contracts';

/**
 * Accumulated telemetry snapshot returned by {@link StepTelemetryCollector.collect}.
 */
export interface CollectedStepTelemetry {
  /** Aggregated token usage across all usage events. */
  tokenUsage: TokenUsage;
  /** Total number of tool use events observed. */
  toolCalls: number;
}

/**
 * Subscribes to agent events on a local bus and aggregates telemetry
 * for a single step execution.
 *
 * Listens to `AgentSubjects.usage` for token counts and
 * `AgentSubjects.tool.use` for tool call counts. Designed to be
 * created before a step executes and disposed after.
 */
export class StepTelemetryCollector {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedTokens = 0;
  private toolCallCount = 0;

  private readonly unsubscribers: Array<() => void> = [];

  /**
   * Create a new telemetry collector subscribed to the given bus.
   * @param bus - Bus instance to subscribe to for agent events.
   */
  public constructor(bus: IMakaioBus) {
    this.unsubscribers.push(
      bus.on(AgentSubjects.usage, (ctx) => {
        this.inputTokens += ctx.payload.inputTokens;
        this.outputTokens += ctx.payload.outputTokens;
        this.cachedTokens += ctx.payload.inputCachedTokens;
      }),
    );

    this.unsubscribers.push(
      bus.on(AgentSubjects.tool.use, () => {
        this.toolCallCount += 1;
      }),
    );
  }

  /**
   * Collect the accumulated telemetry snapshot.
   * @returns Aggregated token usage and tool call count.
   */
  public collect(): CollectedStepTelemetry {
    return {
      tokenUsage: {
        input: this.inputTokens,
        output: this.outputTokens,
        cached: this.cachedTokens,
      },
      toolCalls: this.toolCallCount,
    };
  }

  /**
   * Unsubscribe all event listeners. Call when the step completes.
   */
  public dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;
  }
}
