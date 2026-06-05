/* eslint max-lines: ["error", { "max": 650, "skipBlankLines": true, "skipComments": true }] */
/**
 * Stateful collector that converts workflow and agent bus events into
 * {@link SpanDraft} arrays ready for OTel export.
 *
 * **Lifecycle:**
 * 1. `onExecutionStarted` — opens an execution record.
 * 2. `onFrameStarted` — opens a frame record inside the execution.
 * 3. `onAgentUsage` / `onAgentTool*` — buffers agent metadata, linked later via session.
 * 4. `onFrameSessionLinked` — resolves the session→frame relationship and
 *    re-parents any buffered agent events for that session.
 * 5. `onFrameCompleted` / `onFrameFailed` — closes the frame record.
 * 6. `onExecutionCompleted` / `onExecutionFailed` / `onExecutionCancelled` —
 *    flushes all span drafts for the execution and removes it from memory.
 * 7. `sweepOrphans` — call periodically; promotes stale sessionless agent
 *    events to orphan spans and drops stale sessioned events that never linked,
 *    without terminating still-active executions.
 * @packageDocumentation
 */

import type { SpanDraft } from '../contracts/types.js';
import { SpanBuilder } from './span-builder.js';
import { SessionIndex } from './session-index.js';
import type {
  BufferedToolCall,
  BufferedUsage,
  CollectorOptions,
  FrameRecord,
  OpenExecution,
  UnresolvedToolCall,
  UnresolvedUsage,
} from './types.js';

/**
 * Payload shape for `workflow.execution.started`.
 *
 * Only the fields consumed by the collector are declared here; extra fields
 * are ignored at the call site.
 */
export interface ExecutionStartedPayload {
  readonly executionId: string;
  readonly workflowId: string;
}

/**
 * Payload shape for `workflow.execution.completed`.
 */
export interface ExecutionCompletedPayload {
  readonly executionId: string;
  readonly totalDuration: number;
}

/**
 * Payload shape for `workflow.execution.failed`.
 */
export interface ExecutionFailedPayload {
  readonly executionId: string;
  readonly error: string;
}

/**
 * Payload shape for `workflow.execution.cancelled`.
 */
export interface ExecutionCancelledPayload {
  readonly executionId: string;
  readonly reason?: string;
}

/**
 * Payload shape for `workflow.frame.started`.
 */
export interface FrameStartedPayload {
  readonly executionId: string;
  readonly frameId: string;
  readonly nodeId: string;
  readonly nodeType: string;
  readonly path: readonly string[];
  readonly parentFrameId?: string;
  readonly startedAt?: number;
}

/**
 * Payload shape for `workflow.frame.completed`.
 *
 * `nodeType` and `path` are absent (not part of the real schema). The collector
 * reads those from the frame record snapshot taken at `frame.started`.
 */
export interface FrameCompletedPayload {
  readonly executionId: string;
  readonly frameId: string;
  readonly nodeId: string;
  readonly duration?: number;
  readonly completedAt?: number;
}

/**
 * Payload shape for `workflow.frame.failed`.
 */
export interface FrameFailedPayload {
  readonly executionId: string;
  readonly frameId: string;
  readonly nodeId: string;
  readonly error: string;
  readonly duration?: number;
  readonly completedAt?: number;
}

/**
 * Payload shape for `workflow.frame.sessionLinked`.
 */
export interface FrameSessionLinkedPayload {
  readonly executionId: string;
  readonly frameId: string;
  readonly sessionId: string;
}

/**
 * Subset of the `agent.usage` event consumed by the collector.
 *
 * Mirrors the fields on `UsageSchema` that are relevant to span construction.
 * `sessionId` is optional because the base event schema marks it as such.
 */
export interface AgentUsagePayload {
  readonly sessionId?: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly inputCachedTokens: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly costUnits: number;
  readonly costUnitType: 'requests' | 'tokens';
  readonly cost?: number;
  readonly currency?: string;
  readonly duration?: number;
  readonly occurredAt?: number;
}

/**
 * Payload shape for `agent.tool.started`.
 */
export interface AgentToolStartedPayload {
  readonly sessionId?: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly occurredAt?: number;
}

/**
 * Payload shape for `agent.tool.completed`.
 */
export interface AgentToolCompletedPayload {
  readonly sessionId?: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly success?: boolean;
  readonly occurredAt?: number;
}

/**
 * Converts workflow and agent lifecycle events into fully-resolved
 * {@link SpanDraft} arrays, emitted once per terminal execution event.
 *
 * The collector is injected with a clock so tests can advance time
 * deterministically without real timers.
 */
export class SpanCollector {
  private readonly options: CollectorOptions;
  private readonly executions = new Map<string, OpenExecution>();
  private readonly sessionIndex = new SessionIndex();
  private readonly unresolvedUsageBySession = new Map<string, UnresolvedUsage[]>();
  private readonly unresolvedToolsBySession = new Map<string, Map<string, UnresolvedToolCall>>();
  /**
   * Orphan spans that have been emitted out-of-band during `sweepOrphans`.
   * Stored per executionId so they can be appended when the execution flushes.
   */
  private readonly emittedOrphans = new Map<string, SpanDraft[]>();

  /**
   * @param options - Clock, timeout, capacity, and emit callback configuration.
   */
  public constructor(options: CollectorOptions) {
    this.options = options;
  }

  // ─────────────────────────────────────────────────────────────
  // Execution lifecycle
  // ─────────────────────────────────────────────────────────────

  /**
   * Opens a new execution record.
   *
   * When the open-execution cap is exceeded the oldest entry is force-flushed
   * with an error status before eviction, preserving whatever spans were
   * collected so far rather than silently dropping them.
   * @param payload - `workflow.execution.started` event payload.
   * @param startedAt - Event timestamp in Unix milliseconds.
   * @returns Promise for the detached eviction export when the cap evicts an execution.
   */
  public onExecutionStarted(payload: ExecutionStartedPayload, startedAt: number): Promise<void> | undefined {
    let eviction: Promise<void> | undefined;

    if (this.executions.size >= this.options.maxOpenExecutions) {
      const [oldestId] = this.executions.keys();
      if (oldestId !== undefined) {
        eviction = this.evictExecution(oldestId, 'max_open_executions');
      }
    }

    this.executions.set(payload.executionId, {
      executionId: payload.executionId,
      workflowId: payload.workflowId,
      startedAt,
      frames: new Map(),
      pendingUsage: [],
      pendingTools: new Map(),
      sessionFrameMap: new Map(),
      usageSequence: 0,
    });

    return eviction;
  }

  /**
   * Flushes and removes the execution as successfully completed.
   * @param payload - `workflow.execution.completed` event payload.
   * @param endedAt - Event timestamp in Unix milliseconds.
   */
  public async onExecutionCompleted(payload: ExecutionCompletedPayload, endedAt: number): Promise<void> {
    await this.flushExecution(payload.executionId, endedAt, 'ok');
  }

  /**
   * Flushes and removes the execution as failed.
   * @param payload - `workflow.execution.failed` event payload.
   * @param endedAt - Event timestamp in Unix milliseconds.
   */
  public async onExecutionFailed(payload: ExecutionFailedPayload, endedAt: number): Promise<void> {
    await this.flushExecution(payload.executionId, endedAt, 'error');
  }

  /**
   * Flushes and removes the execution as cancelled.
   * @param payload - `workflow.execution.cancelled` event payload.
   * @param endedAt - Event timestamp in Unix milliseconds.
   */
  public async onExecutionCancelled(payload: ExecutionCancelledPayload, endedAt: number): Promise<void> {
    await this.flushExecution(payload.executionId, endedAt, 'error');
  }

  // ─────────────────────────────────────────────────────────────
  // Frame lifecycle
  // ─────────────────────────────────────────────────────────────

  /**
   * Opens a frame record inside an in-flight execution.
   *
   * Silently ignored when the execution is not known (e.g. collector started
   * mid-execution).
   * @param payload - `workflow.frame.started` event payload.
   * @param startedAt - Event timestamp in Unix milliseconds.
   */
  public onFrameStarted(payload: FrameStartedPayload, startedAt: number): void {
    const execution = this.executions.get(payload.executionId);
    if (execution === undefined) {
      return;
    }

    const existing = execution.frames.get(payload.frameId);
    if (existing !== undefined) {
      existing.nodeId = payload.nodeId;
      existing.nodeType = payload.nodeType;
      existing.path = payload.path;
      existing.parentFrameId = payload.parentFrameId;
      existing.startedAt = startedAt;
      return;
    }

    execution.frames.set(payload.frameId, {
      frameId: payload.frameId,
      nodeId: payload.nodeId,
      nodeType: payload.nodeType,
      path: payload.path,
      parentFrameId: payload.parentFrameId,
      startedAt,
      endedAt: undefined,
      status: 'unset',
    });
  }

  /**
   * Closes the frame record as successfully completed.
   *
   * `nodeType` and `path` are NOT on the real `frame.completed` schema; the
   * collector preserves those from the `frame.started` snapshot.
   * @param payload - `workflow.frame.completed` event payload.
   * @param endedAt - Event timestamp in Unix milliseconds.
   */
  public onFrameCompleted(payload: FrameCompletedPayload, endedAt: number): void {
    this.closeFrame(payload.executionId, payload.frameId, payload.nodeId, endedAt, 'ok', payload.duration);
  }

  /**
   * Closes the frame record as failed.
   * @param payload - `workflow.frame.failed` event payload.
   * @param endedAt - Event timestamp in Unix milliseconds.
   */
  public onFrameFailed(payload: FrameFailedPayload, endedAt: number): void {
    this.closeFrame(payload.executionId, payload.frameId, payload.nodeId, endedAt, 'error', payload.duration);
  }

  /**
   * Links an agent session to a frame and re-parents any buffered usage
   * events for that session.
   * @param payload - `workflow.frame.sessionLinked` event payload.
   */
  public onFrameSessionLinked(payload: FrameSessionLinkedPayload): void {
    const execution = this.executions.get(payload.executionId);
    if (execution === undefined) {
      return;
    }

    execution.sessionFrameMap.set(payload.sessionId, payload.frameId);
    this.sessionIndex.link(payload.sessionId, payload.executionId, payload.frameId);
    this.replayUnresolvedUsage(payload.sessionId, execution);
    this.replayUnresolvedTools(payload.sessionId, execution);
  }

  // ─────────────────────────────────────────────────────────────
  // Agent events
  // ─────────────────────────────────────────────────────────────

  /**
   * Buffers an agent usage event for the matching workflow execution.
   *
   * When a `sessionId` is present and already resolved via
   * `frame.sessionLinked`, the event is immediately associated with its frame.
   * Otherwise, sessioned events remain unresolved until the next
   * `frame.sessionLinked` proves ownership. Sessionless events may use the
   * sole-open-execution fallback and later become orphan spans.
   * @param payload - `agent.usage` event payload.
   */
  public onAgentUsage(payload: AgentUsagePayload): void {
    const now = this.options.now();
    const unresolved = this.createUnresolvedUsage(payload, now);
    const execution = this.resolveExecutionForSession(payload.sessionId);

    if (execution !== undefined) {
      this.bufferUsageOnExecution(execution, unresolved);
      return;
    }

    if (payload.sessionId !== undefined) {
      const existing = this.unresolvedUsageBySession.get(payload.sessionId) ?? [];
      existing.push(unresolved);
      this.unresolvedUsageBySession.set(payload.sessionId, existing);
    }
  }

  /**
   * Opens or records a tool call span for the matching workflow execution.
   * @param payload - `agent.tool.started` event payload.
   */
  public onAgentToolStarted(payload: AgentToolStartedPayload): void {
    const now = this.options.now();
    const occurredAt = payload.occurredAt ?? now;
    const execution = this.resolveExecutionForSession(payload.sessionId);

    if (execution !== undefined) {
      this.mergeToolStartOnExecution(execution, {
        sessionId: payload.sessionId,
        toolName: payload.toolName,
        toolCallId: payload.toolCallId,
        startedAt: occurredAt,
        ingestedAt: now,
        endedAt: undefined,
        success: undefined,
      });
      return;
    }

    if (payload.sessionId !== undefined) {
      this.mergeUnresolvedToolStart(payload.sessionId, {
        sessionId: payload.sessionId,
        toolName: payload.toolName,
        toolCallId: payload.toolCallId,
        startedAt: occurredAt,
        ingestedAt: now,
        endedAt: undefined,
        success: undefined,
      });
    }
  }

  /**
   * Closes or records a tool call span for the matching workflow execution.
   * @param payload - `agent.tool.completed` event payload.
   */
  public onAgentToolCompleted(payload: AgentToolCompletedPayload): void {
    const now = this.options.now();
    const occurredAt = payload.occurredAt ?? now;
    const execution = this.resolveExecutionForSession(payload.sessionId);

    if (execution !== undefined) {
      const key = this.toolKey(payload.sessionId, payload.toolCallId);
      const existing = execution.pendingTools.get(key);
      if (existing !== undefined) {
        existing.toolName = payload.toolName;
        existing.endedAt = occurredAt;
        existing.success = payload.success;
        return;
      }

      this.bufferToolOnExecution(execution, {
        sessionId: payload.sessionId,
        toolName: payload.toolName,
        toolCallId: payload.toolCallId,
        startedAt: occurredAt,
        ingestedAt: now,
        endedAt: occurredAt,
        success: payload.success,
      });
      return;
    }

    if (payload.sessionId !== undefined) {
      const key = this.toolKey(payload.sessionId, payload.toolCallId);
      const sessionTools = this.unresolvedToolsBySession.get(payload.sessionId);
      const existing = sessionTools?.get(key);
      if (existing !== undefined) {
        existing.toolName = payload.toolName;
        existing.endedAt = occurredAt;
        existing.success = payload.success;
        return;
      }

      this.bufferUnresolvedTool(payload.sessionId, {
        sessionId: payload.sessionId,
        toolName: payload.toolName,
        toolCallId: payload.toolCallId,
        startedAt: occurredAt,
        ingestedAt: now,
        endedAt: occurredAt,
        success: payload.success,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Orphan sweep
  // ─────────────────────────────────────────────────────────────

  /**
   * Flush all open executions with error status.
   *
   * Called during service shutdown to ensure that spans from in-flight
   * executions are emitted rather than silently dropped. Each open execution
   * is terminated as failed with a `'Service shutdown'` error message.
   */
  public async flushAll(): Promise<void> {
    const executionIds = [...this.executions.keys()];
    for (const executionId of executionIds) {
      await this.onExecutionFailed({ executionId, error: 'Service shutdown' }, this.options.now());
    }
  }

  /**
   * Promotes stale execution-owned sessionless agent events to orphan spans.
   *
   * A sessionless event is stale when `now - ingestedAt >= orphanTimeoutMs`.
   * Orphan spans are stored in {@link emittedOrphans} and appended to the
   * execution's span batch when the execution eventually flushes.
   *
   * Sessioned events that have not yet received `frame.sessionLinked` remain
   * buffered until this same timeout expires. After that point the collector
   * discards them because no execution owner can be proven.
   */
  public async sweepOrphans(): Promise<void> {
    const now = this.options.now();
    const { orphanTimeoutMs } = this.options;

    if (orphanTimeoutMs === 0) {
      this.sweepUnresolvedSessionEvents(now, 0);
      return;
    }

    for (const execution of this.executions.values()) {
      const remaining: BufferedUsage[] = [];

      for (const usage of execution.pendingUsage) {
        const age = now - usage.ingestedAt;
        const isStale = age >= orphanTimeoutMs;
        const sessionResolved = usage.sessionId !== undefined && execution.sessionFrameMap.has(usage.sessionId);

        if (!isStale || sessionResolved) {
          remaining.push(usage);
          continue;
        }

        // Emit as orphan
        const orphanDraft = this.buildUsageSpan(execution, usage, undefined);
        const existing = this.emittedOrphans.get(execution.executionId) ?? [];
        existing.push(orphanDraft);
        this.emittedOrphans.set(execution.executionId, existing);
      }

      execution.pendingUsage.length = 0;
      execution.pendingUsage.push(...remaining);

      for (const [key, tool] of [...execution.pendingTools]) {
        const age = now - tool.ingestedAt;
        const sessionResolved = tool.sessionId !== undefined && execution.sessionFrameMap.has(tool.sessionId);
        if (!sessionResolved && age >= orphanTimeoutMs) {
          const existing = this.emittedOrphans.get(execution.executionId) ?? [];
          existing.push(this.buildToolSpan(execution, tool, undefined, now));
          this.emittedOrphans.set(execution.executionId, existing);
          execution.pendingTools.delete(key);
        }
      }
    }

    this.sweepUnresolvedSessionEvents(now, orphanTimeoutMs);
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Force-flushes an open execution with an error status and an eviction event,
   * then removes it from memory.
   *
   * Called when the open-execution cap is reached so that collected spans are
   * emitted rather than silently dropped.
   * @param executionId - Execution to evict.
   * @param reason - Reason attached to the eviction event.
   */
  private async evictExecution(executionId: string, reason: 'max_open_executions'): Promise<void> {
    const execution = this.executions.get(executionId);
    if (execution === undefined) {
      return;
    }

    const now = this.options.now();
    const drafts: SpanDraft[] = [];

    // Root execution span with error status and an eviction event
    const rootSpan = SpanBuilder.buildExecutionSpan({
      executionId: execution.executionId,
      workflowId: execution.workflowId,
      startedAt: execution.startedAt,
      endedAt: now,
      status: 'error',
    });
    drafts.push({
      ...rootSpan,
      events: [
        {
          name: 'evicted',
          time: now,
          attributes: { 'eviction.reason': reason },
        },
      ],
    });

    // Frame spans — close any open frames at the eviction timestamp
    for (const frame of execution.frames.values()) {
      drafts.push(
        SpanBuilder.buildFrameSpan({
          executionId: execution.executionId,
          frameId: frame.frameId,
          nodeId: frame.nodeId,
          nodeType: frame.nodeType,
          path: frame.path,
          parentFrameId: frame.parentFrameId,
          startedAt: frame.startedAt,
          endedAt: frame.endedAt ?? now,
          status: frame.status === 'unset' ? 'error' : frame.status,
        }),
      );
    }

    // Resolve pending usage events against their session→frame mappings
    for (const usage of execution.pendingUsage) {
      const frameId = usage.sessionId !== undefined ? execution.sessionFrameMap.get(usage.sessionId) : undefined;
      drafts.push(this.buildUsageSpan(execution, usage, frameId));
    }

    for (const tool of execution.pendingTools.values()) {
      const frameId = tool.sessionId !== undefined ? execution.sessionFrameMap.get(tool.sessionId) : undefined;
      drafts.push(this.buildToolSpan(execution, tool, frameId, now));
    }

    // Append any orphan spans emitted during sweepOrphans
    const orphans = this.emittedOrphans.get(executionId);
    if (orphans !== undefined) {
      drafts.push(...orphans);
    }

    // Clean up
    this.executions.delete(executionId);
    this.sessionIndex.evictExecution(executionId);
    this.emittedOrphans.delete(executionId);
    this.clearUnlinkedAgentEventsWhenIdle();

    await this.options.emit(drafts);
  }

  /**
   * Closes a frame record, setting its terminal status and end time.
   * @param executionId - Execution that owns the frame.
   * @param frameId - Frame to close.
   * @param nodeId - Node identifier from the terminal frame event.
   * @param endedAt - Wall-clock time in Unix milliseconds.
   * @param status - Terminal status to write.
   * @param duration - Optional wall-clock duration used to reconstruct missed starts.
   */
  private closeFrame(
    executionId: string,
    frameId: string,
    nodeId: string,
    endedAt: number,
    status: 'ok' | 'error',
    duration: number | undefined,
  ): void {
    const execution = this.executions.get(executionId);
    if (execution === undefined) {
      return;
    }

    const startedAt = endedAt - (duration ?? 0);
    const frame =
      execution.frames.get(frameId) ?? this.createPlaceholderFrame(execution, frameId, nodeId, startedAt, endedAt);

    frame.endedAt = endedAt;
    frame.status = status;
  }

  /**
   * Builds a {@link SpanDraft} for a single buffered usage event.
   *
   * When `frameId` is `undefined` the span is marked as orphaned.
   * @param execution - The execution this usage belongs to.
   * @param usage - Buffered usage event.
   * @param frameId - Resolved frame ID, or `undefined` for orphan spans.
   * @returns A fully-resolved {@link SpanDraft} for the LLM call.
   */
  private buildUsageSpan(execution: OpenExecution, usage: BufferedUsage, frameId: string | undefined): SpanDraft {
    const orphaned = frameId === undefined;
    const endedAt = usage.occurredAt ?? usage.ingestedAt;
    const startedAt = usage.duration !== undefined ? endedAt - usage.duration : endedAt;

    return SpanBuilder.buildLlmSpan({
      executionId: execution.executionId,
      sessionId: usage.sessionId ?? 'unknown',
      frameId,
      sequence: usage.sequence,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      inputCachedTokens: usage.inputCachedTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      cost: usage.cost,
      currency: usage.currency,
      duration: usage.duration,
      startedAt,
      endedAt,
      orphaned,
    });
  }

  /**
   * Builds a {@link SpanDraft} for a single buffered tool event pair.
   * @param execution - The execution this tool call belongs to.
   * @param tool - Buffered tool call event state.
   * @param frameId - Resolved frame ID, or `undefined` for orphan spans.
   * @param fallbackEndedAt - End timestamp for still-open tool calls.
   * @returns A fully-resolved {@link SpanDraft} for the tool call.
   */
  private buildToolSpan(
    execution: OpenExecution,
    tool: BufferedToolCall,
    frameId: string | undefined,
    fallbackEndedAt: number,
  ): SpanDraft {
    return SpanBuilder.buildToolSpan({
      executionId: execution.executionId,
      sessionId: tool.sessionId ?? 'unknown',
      frameId,
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      startedAt: tool.startedAt,
      endedAt: tool.endedAt ?? fallbackEndedAt,
      success: tool.success,
      orphaned: frameId === undefined,
    });
  }

  private createUnresolvedUsage(payload: AgentUsagePayload, ingestedAt: number): UnresolvedUsage {
    return {
      sessionId: payload.sessionId,
      provider: payload.provider,
      model: payload.model,
      inputTokens: payload.inputTokens,
      inputCachedTokens: payload.inputCachedTokens,
      cacheWriteTokens: payload.cacheWriteTokens,
      outputTokens: payload.outputTokens,
      reasoningTokens: payload.reasoningTokens,
      totalTokens: payload.totalTokens,
      costUnits: payload.costUnits,
      costUnitType: payload.costUnitType,
      cost: payload.cost,
      currency: payload.currency,
      duration: payload.duration,
      occurredAt: payload.occurredAt,
      ingestedAt,
    };
  }

  private resolveExecutionForSession(sessionId: string | undefined): OpenExecution | undefined {
    if (sessionId !== undefined) {
      const link = this.sessionIndex.lookup(sessionId);
      if (link !== undefined) {
        return this.executions.get(link.executionId);
      }
      return undefined;
    }

    if (this.executions.size === 1) {
      return [...this.executions.values()][0];
    }

    return undefined;
  }

  private bufferUsageOnExecution(execution: OpenExecution, usage: UnresolvedUsage): void {
    execution.pendingUsage.push({
      ...usage,
      sequence: execution.usageSequence++,
    });
  }

  private replayUnresolvedUsage(sessionId: string, execution: OpenExecution): void {
    const usages = this.unresolvedUsageBySession.get(sessionId);
    if (usages === undefined) {
      return;
    }

    for (const usage of usages) {
      this.bufferUsageOnExecution(execution, usage);
    }
    this.unresolvedUsageBySession.delete(sessionId);
  }

  private bufferToolOnExecution(execution: OpenExecution, tool: BufferedToolCall): void {
    execution.pendingTools.set(this.toolKey(tool.sessionId, tool.toolCallId), tool);
  }

  private mergeToolStartOnExecution(execution: OpenExecution, tool: BufferedToolCall): void {
    const key = this.toolKey(tool.sessionId, tool.toolCallId);
    const existing = execution.pendingTools.get(key);
    if (existing === undefined) {
      this.bufferToolOnExecution(execution, tool);
      return;
    }

    execution.pendingTools.set(key, {
      ...existing,
      toolName: tool.toolName,
      startedAt: tool.startedAt,
    });
  }

  private bufferUnresolvedTool(sessionId: string, tool: UnresolvedToolCall): void {
    const sessionTools = this.unresolvedToolsBySession.get(sessionId) ?? new Map<string, UnresolvedToolCall>();
    sessionTools.set(this.toolKey(sessionId, tool.toolCallId), tool);
    this.unresolvedToolsBySession.set(sessionId, sessionTools);
  }

  private mergeUnresolvedToolStart(sessionId: string, tool: UnresolvedToolCall): void {
    const sessionTools = this.unresolvedToolsBySession.get(sessionId);
    const key = this.toolKey(sessionId, tool.toolCallId);
    const existing = sessionTools?.get(key);
    if (sessionTools === undefined || existing === undefined) {
      this.bufferUnresolvedTool(sessionId, tool);
      return;
    }

    sessionTools.set(key, {
      ...existing,
      toolName: tool.toolName,
      startedAt: tool.startedAt,
    });
  }

  private replayUnresolvedTools(sessionId: string, execution: OpenExecution): void {
    const tools = this.unresolvedToolsBySession.get(sessionId);
    if (tools === undefined) {
      return;
    }

    for (const tool of tools.values()) {
      this.bufferToolOnExecution(execution, {
        sessionId,
        toolName: tool.toolName,
        toolCallId: tool.toolCallId,
        startedAt: tool.startedAt,
        ingestedAt: tool.ingestedAt,
        endedAt: tool.endedAt,
        success: tool.success,
      });
    }
    this.unresolvedToolsBySession.delete(sessionId);
  }

  private sweepUnresolvedSessionEvents(now: number, orphanTimeoutMs: number): void {
    for (const [sessionId, usages] of this.unresolvedUsageBySession) {
      const retained = usages.filter((usage) => now - usage.ingestedAt < orphanTimeoutMs);
      if (retained.length === 0) {
        this.unresolvedUsageBySession.delete(sessionId);
        continue;
      }
      if (retained.length !== usages.length) {
        this.unresolvedUsageBySession.set(sessionId, retained);
      }
    }

    for (const [sessionId, tools] of this.unresolvedToolsBySession) {
      for (const [key, tool] of tools) {
        if (now - tool.ingestedAt >= orphanTimeoutMs) {
          tools.delete(key);
        }
      }
      if (tools.size === 0) {
        this.unresolvedToolsBySession.delete(sessionId);
      }
    }
  }

  private clearUnlinkedAgentEventsWhenIdle(): void {
    if (this.executions.size !== 0) {
      return;
    }

    this.unresolvedUsageBySession.clear();
    this.unresolvedToolsBySession.clear();
  }

  private toolKey(sessionId: string | undefined, toolCallId: string): string {
    return `${sessionId ?? 'unknown'}:${toolCallId}`;
  }

  private createPlaceholderFrame(
    execution: OpenExecution,
    frameId: string,
    nodeId: string,
    startedAt: number,
    endedAt: number | undefined,
  ): FrameRecord {
    const frame: FrameRecord = {
      frameId,
      nodeId,
      nodeType: 'unknown',
      path: [frameId],
      parentFrameId: undefined,
      startedAt,
      endedAt,
      status: 'unset',
    };
    execution.frames.set(frameId, frame);
    return frame;
  }

  /**
   * Builds and emits all {@link SpanDraft} objects for a terminal execution,
   * then removes the execution from memory.
   *
   * Ordering: root execution span → frame spans → LLM/orphan spans.
   * @param executionId - Execution to flush.
   * @param endedAt - Terminal event timestamp in Unix milliseconds.
   * @param status - Terminal status (`'ok'` or `'error'`).
   */
  private async flushExecution(executionId: string, endedAt: number, status: 'ok' | 'error'): Promise<void> {
    const execution = this.executions.get(executionId);
    if (execution === undefined) {
      return;
    }

    const drafts: SpanDraft[] = [];

    // Root execution span
    drafts.push(
      SpanBuilder.buildExecutionSpan({
        executionId: execution.executionId,
        workflowId: execution.workflowId,
        startedAt: execution.startedAt,
        endedAt,
        status,
      }),
    );

    // Frame spans — use the endedAt from the frame record when available,
    // otherwise fall back to the execution terminal timestamp.
    for (const frame of execution.frames.values()) {
      drafts.push(
        SpanBuilder.buildFrameSpan({
          executionId: execution.executionId,
          frameId: frame.frameId,
          nodeId: frame.nodeId,
          nodeType: frame.nodeType,
          path: frame.path,
          parentFrameId: frame.parentFrameId,
          startedAt: frame.startedAt,
          endedAt: frame.endedAt ?? endedAt,
          status: frame.status === 'unset' ? status : frame.status,
        }),
      );
    }

    // Resolve pending usage events against their session→frame mappings
    for (const usage of execution.pendingUsage) {
      const frameId = usage.sessionId !== undefined ? execution.sessionFrameMap.get(usage.sessionId) : undefined;
      drafts.push(this.buildUsageSpan(execution, usage, frameId));
    }

    for (const tool of execution.pendingTools.values()) {
      const frameId = tool.sessionId !== undefined ? execution.sessionFrameMap.get(tool.sessionId) : undefined;
      drafts.push(this.buildToolSpan(execution, tool, frameId, endedAt));
    }

    // Append any orphan spans emitted during sweepOrphans
    const orphans = this.emittedOrphans.get(executionId);
    if (orphans !== undefined) {
      drafts.push(...orphans);
    }

    // Clean up
    this.executions.delete(executionId);
    this.sessionIndex.evictExecution(executionId);
    this.emittedOrphans.delete(executionId);
    this.clearUnlinkedAgentEventsWhenIdle();

    await this.options.emit(drafts);
  }
}
