/**
 * Service wiring for the telemetry-otel extension.
 *
 * Bridges workflow and agent bus events to the {@link SpanCollector}, runs
 * collected span drafts through the {@link SpanEnricherPipeline}, and
 * forwards enriched batches to the configured emitter.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, WorkflowSubjects } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import type { SpanDraft } from './contracts/index.js';
import { TelemetryOtelSubjects } from './contracts/index.js';
import type { TelemetryOtelConfig } from './config.js';
import { SpanCollector } from './collector/span-collector.js';
import { SpanEnricherRuleRegistry } from './enrichers/registry.js';
import { SpanEnricherPipeline } from './enrichers/pipeline.js';

/**
 * Export sink for enriched span drafts.
 */
export interface TelemetryOtelSpanEmitter {
  /**
   * Export a batch of enriched span drafts.
   * @param drafts - Span drafts ready for export.
   */
  emit(drafts: readonly SpanDraft[]): Promise<void>;
  /**
   * Drain and stop the emitter before service shutdown completes.
   * @returns Promise resolved after pending exports are drained.
   */
  shutdown?(): Promise<void>;
}

/**
 * Construction options for {@link TelemetryOtelService}.
 */
export interface TelemetryOtelServiceOptions {
  /** Bus instance used for handler registration. */
  readonly bus: IMakaioBus;
  /** Parsed telemetry-otel extension configuration. */
  readonly config: TelemetryOtelConfig;
  /** Emitter that exports fully enriched span batches. */
  readonly emitter: TelemetryOtelSpanEmitter;
  /**
   * Clock function returning the current wall-clock time in Unix milliseconds.
   *
   * Defaults to `Date.now`. Inject a deterministic clock in tests.
   */
  readonly now?: () => number;
}

/**
 * Wires workflow and agent bus events to the span pipeline.
 *
 * On construction this service:
 * 1. Creates a {@link SpanCollector} whose `emit` callback runs each draft
 *    through the {@link SpanEnricherPipeline} before forwarding to the real
 *    emitter.
 * 2. Creates a {@link SpanEnricherRuleRegistry} and a
 *    {@link SpanEnricherPipeline} backed by the bus and that registry.
 * 3. In `onInit`, registers bus handlers for all workflow execution and frame
 *    events, all relevant agent events, and the enricher registration subjects.
 * 4. Starts a sweep interval that calls `collector.sweepOrphans()` on
 *    `config.batchConfig.scheduledDelayMs`.
 * 5. In `onDestroy`, flushes all open executions with error status via `collector.flushAll()`.
 */
export class TelemetryOtelService extends BaseService {
  private readonly collector: SpanCollector;
  private readonly registry: SpanEnricherRuleRegistry;
  private readonly pipeline: SpanEnricherPipeline;
  private readonly emitter: TelemetryOtelSpanEmitter;
  private readonly clock: () => number;
  private readonly scheduledDelayMs: number;
  private readonly terminalTelemetryTasks = new Set<Promise<void>>();
  private sweepIntervalId: ReturnType<typeof setInterval> | undefined;

  /**
   * @param options - Service construction options.
   */
  public constructor(options: TelemetryOtelServiceOptions) {
    super(options.bus);

    this.clock = options.now ?? (() => Date.now());
    this.scheduledDelayMs = options.config.batchConfig.scheduledDelayMs;

    this.registry = new SpanEnricherRuleRegistry();
    this.pipeline = new SpanEnricherPipeline({
      bus: options.bus,
      registry: this.registry,
    });

    this.emitter = options.emitter;
    this.collector = new SpanCollector({
      now: this.clock,
      orphanTimeoutMs: options.config.orphanTimeoutMs,
      maxOpenExecutions: options.config.maxOpenExecutions,
      emit: async (drafts) => {
        // Enrichment is fail-closed within telemetry: a broken enricher should
        // reach service error handling instead of exporting incomplete spans.
        const enriched = await Promise.all(drafts.map((d) => this.pipeline.enrich(d)));
        await this.emitter.emit(enriched);
      },
    });
  }

  /**
   * Register all bus handlers and start the orphan sweep interval.
   */
  protected onInit(): void {
    // ── Execution lifecycle ───────────────────────────────────────

    this.registerHandler(WorkflowSubjects.execution.started, (ctx) => {
      const eviction = this.collector.onExecutionStarted(ctx.payload, ctx.payload.startedAt ?? this.clock());
      if (eviction !== undefined) {
        this.observeTerminalTelemetry('evicted', () => eviction);
      }
    });

    this.registerHandler(WorkflowSubjects.execution.completed, async (ctx) => {
      await this.handleTerminalTelemetry('completed', () =>
        this.collector.onExecutionCompleted(ctx.payload, ctx.payload.completedAt ?? this.clock()),
      );
    });

    this.registerHandler(WorkflowSubjects.execution.failed, async (ctx) => {
      await this.handleTerminalTelemetry('failed', () =>
        this.collector.onExecutionFailed(ctx.payload, ctx.payload.completedAt ?? this.clock()),
      );
    });

    this.registerHandler(WorkflowSubjects.execution.cancelled, async (ctx) => {
      await this.handleTerminalTelemetry('cancelled', () =>
        this.collector.onExecutionCancelled(ctx.payload, ctx.payload.completedAt ?? this.clock()),
      );
    });

    // ── Frame lifecycle ───────────────────────────────────────────

    this.registerHandler(WorkflowSubjects.frame.started, (ctx) => {
      this.collector.onFrameStarted(ctx.payload, ctx.payload.startedAt ?? this.clock());
    });

    this.registerHandler(WorkflowSubjects.frame.completed, (ctx) => {
      this.collector.onFrameCompleted(ctx.payload, ctx.payload.completedAt ?? this.clock());
    });

    this.registerHandler(WorkflowSubjects.frame.failed, (ctx) => {
      this.collector.onFrameFailed(ctx.payload, ctx.payload.completedAt ?? this.clock());
    });

    this.registerHandler(WorkflowSubjects.frame.sessionLinked, (ctx) => {
      this.collector.onFrameSessionLinked(ctx.payload);
    });

    // ── Agent events ──────────────────────────────────────────────

    this.registerHandler(AgentSubjects.usage, (ctx) => {
      this.collector.onAgentUsage(ctx.payload);
    });

    this.registerHandler(AgentSubjects.tool.started, (ctx) => {
      this.collector.onAgentToolStarted(ctx.payload);
    });

    this.registerHandler(AgentSubjects.tool.completed, (ctx) => {
      this.collector.onAgentToolCompleted(ctx.payload);
    });

    // ── Enricher rule registration ────────────────────────────────

    this.registerHandler(TelemetryOtelSubjects.registerEnricherRule, (ctx) => {
      this.registry.register(ctx.payload);
    });

    this.registerHandler(TelemetryOtelSubjects.unregisterEnricherRule, (ctx) => {
      this.registry.unregister(ctx.payload.ruleId);
    });

    // ── Orphan sweep interval ─────────────────────────────────────

    this.sweepIntervalId = setInterval(() => {
      void this.collector.sweepOrphans();
    }, this.scheduledDelayMs);

    this.addCleanup(() => {
      this.clearSweepInterval();
    });
  }

  /**
   * Flush all open executions with error status before the service stops, then
   * shut down the emitter so the {@link BatchSpanProcessor} queue is drained
   * before the process exits.
   */
  protected async onDestroy(): Promise<void> {
    this.clearSweepInterval();
    try {
      await this.drainTerminalTelemetry();
      await this.handleTerminalTelemetry('shutdown', () => this.collector.flushAll());
      await this.drainTerminalTelemetry();
    } finally {
      await this.emitter.shutdown?.();
    }
  }

  private observeTerminalTelemetry(status: string, operation: () => Promise<void>): void {
    const task = this.handleTerminalTelemetry(status, operation);
    this.terminalTelemetryTasks.add(task);
    void task.finally(() => {
      this.terminalTelemetryTasks.delete(task);
    });
  }

  private async drainTerminalTelemetry(): Promise<void> {
    while (this.terminalTelemetryTasks.size > 0) {
      await Promise.all([...this.terminalTelemetryTasks]);
    }
  }

  private async handleTerminalTelemetry(status: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      console.warn(`[telemetry-otel] Failed to export terminal '${status}' telemetry`, error);
    }
  }

  private clearSweepInterval(): void {
    if (this.sweepIntervalId === undefined) {
      return;
    }

    clearInterval(this.sweepIntervalId);
    this.sweepIntervalId = undefined;
  }
}
