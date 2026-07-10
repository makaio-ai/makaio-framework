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
 *    events to execution orphans and exports unlinked sessioned events as
 *    standalone trace segments without terminating still-active executions.
 * @packageDocumentation
 */

import type { SpanDraft } from '../contracts/types.js';
import { SpanBuilder } from './span-builder.js';
import { SessionIndex } from './session-index.js';
import { buildStandaloneSessionTrace } from './standalone-session-traces.js';
import {
  createUnresolvedUsage,
  groupUsageBySession,
  partitionStaleSessionEvents,
  partitionUsageForExecution,
} from './unresolved-events.js';
import type {
  AgentUsagePayload,
  BufferedToolCall,
  BufferedUsage,
  CollectorOptions,
  FrameRecord,
  OpenExecution,
  UnresolvedToolCall,
  UnresolvedUsage,
} from './types.js';

export type { AgentUsagePayload } from './types.js';

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
  private readonly unresolvedUsageByExecution = new Map<string, UnresolvedUsage[]>();
  private readonly unresolvedToolsBySession = new Map<string, Map<string, UnresolvedToolCall>>();
  /** Reuses span IDs when a failed standalone export is retried. */
  private readonly standaloneRetrySegmentBySession = new Map<string, number>();
  /** Reuses span IDs for usage whose claimed execution never opened. */
  private readonly standaloneRetrySegmentsByExecution = new Map<string, Map<string, number>>();
  private standaloneSegmentSequence = 0;
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

    const execution: OpenExecution = {
      executionId: payload.executionId,
      workflowId: payload.workflowId,
      startedAt,
      frames: new Map(),
      pendingUsage: [],
      pendingTools: new Map(),
      sessionFrameMap: new Map(),
      usageSequence: 0,
    };
    this.executions.set(payload.executionId, execution);
    this.replayUnresolvedUsageForExecution(execution);

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
    this.standaloneRetrySegmentBySession.delete(payload.sessionId);
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
    const unresolved = createUnresolvedUsage(payload, now);
    const execution =
      payload.executionId !== undefined
        ? this.executions.get(payload.executionId)
        : this.resolveExecutionForSession(payload.sessionId);

    if (execution !== undefined) {
      this.bufferUsageOnExecution(execution, unresolved);
      return;
    }

    if (payload.executionId !== undefined) {
      const existing = this.unresolvedUsageByExecution.get(payload.executionId) ?? [];
      existing.push(unresolved);
      this.unresolvedUsageByExecution.set(payload.executionId, existing);
    } else if (payload.sessionId !== undefined) {
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
    await this.flushStaleStandaloneSessions(this.options.now(), 0);
    await this.flushStaleUnopenedExecutions(this.options.now(), 0);
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
   * exports them as standalone session trace segments.
   */
  public async sweepOrphans(): Promise<void> {
    const now = this.options.now();
    const { orphanTimeoutMs } = this.options;

    if (orphanTimeoutMs === 0) {
      return;
    }

    for (const execution of this.executions.values()) {
      const remaining: BufferedUsage[] = [];

      for (const usage of execution.pendingUsage) {
        const age = now - usage.ingestedAt;
        const isStale = age >= orphanTimeoutMs;
        const frameResolved =
          usage.frameId !== undefined ||
          (usage.sessionId !== undefined && execution.sessionFrameMap.has(usage.sessionId));

        if (!isStale || frameResolved) {
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

    await this.flushStaleStandaloneSessions(now, orphanTimeoutMs);
    await this.flushStaleUnopenedExecutions(now, orphanTimeoutMs);
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
      const frameId =
        usage.frameId ?? (usage.sessionId !== undefined ? execution.sessionFrameMap.get(usage.sessionId) : undefined);
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
      agentId: usage.agentId,
      adapterId: usage.adapterId,
      adapterName: usage.adapterName,
      adapterSessionId: usage.adapterSessionId,
      messageId: usage.messageId,
      turnId: usage.turnId,
      clientId: usage.clientId,
      providerConfigId: usage.providerConfigId,
      llmCallId: usage.llmCallId,
      costUnits: usage.costUnits,
      costUnitType: usage.costUnitType,
      cost: usage.cost,
      currency: usage.currency,
      costProvenance: usage.costProvenance,
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

    const { matched, retained } = partitionUsageForExecution(usages, execution.executionId, true);
    for (const usage of matched) {
      this.bufferUsageOnExecution(execution, usage);
    }
    if (retained.length === 0) this.unresolvedUsageBySession.delete(sessionId);
    else this.unresolvedUsageBySession.set(sessionId, retained);
  }

  private replayUnresolvedUsageForExecution(execution: OpenExecution): void {
    const usages = this.unresolvedUsageByExecution.get(execution.executionId) ?? [];
    for (const usage of usages) this.bufferUsageOnExecution(execution, usage);
    this.unresolvedUsageByExecution.delete(execution.executionId);
    this.standaloneRetrySegmentsByExecution.delete(execution.executionId);
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

  private async flushStaleStandaloneSessions(now: number, timeoutMs: number): Promise<void> {
    const sessionIds = new Set([...this.unresolvedUsageBySession.keys(), ...this.unresolvedToolsBySession.keys()]);
    for (const sessionId of sessionIds) {
      const usages = this.unresolvedUsageBySession.get(sessionId) ?? [];
      const tools = this.unresolvedToolsBySession.get(sessionId) ?? new Map();
      const { expiredUsages, retainedUsages, expiredTools, retainedTools } = partitionStaleSessionEvents(
        usages,
        tools,
        now,
        timeoutMs,
      );
      if (retainedUsages.length === 0) this.unresolvedUsageBySession.delete(sessionId);
      else this.unresolvedUsageBySession.set(sessionId, retainedUsages);
      if (retainedTools.size === 0) this.unresolvedToolsBySession.delete(sessionId);
      else this.unresolvedToolsBySession.set(sessionId, retainedTools);
      if (expiredUsages.length === 0 && expiredTools.length === 0) continue;
      const segment = this.standaloneRetrySegmentBySession.get(sessionId) ?? this.standaloneSegmentSequence++;
      try {
        await this.flushStandaloneSession(sessionId, segment, expiredUsages, expiredTools, now);
        this.standaloneRetrySegmentBySession.delete(sessionId);
      } catch (error) {
        this.standaloneRetrySegmentBySession.set(sessionId, segment);
        const currentUsages = this.unresolvedUsageBySession.get(sessionId) ?? [];
        this.unresolvedUsageBySession.set(sessionId, [...expiredUsages, ...currentUsages]);
        const currentTools = this.unresolvedToolsBySession.get(sessionId) ?? new Map();
        this.unresolvedToolsBySession.set(sessionId, currentTools);
        for (const tool of expiredTools) this.mergeUnresolvedToolStart(sessionId, tool);
        throw error;
      }
    }
  }

  private async flushStandaloneSession(
    sessionId: string,
    segment: number,
    usages: readonly UnresolvedUsage[],
    tools: readonly UnresolvedToolCall[],
    fallbackEndedAt: number,
  ): Promise<void> {
    if (usages.length === 0 && tools.length === 0) {
      return;
    }

    await this.options.emit(buildStandaloneSessionTrace({ sessionId, segment, usages, tools, fallbackEndedAt }));
  }

  private async flushStaleUnopenedExecutions(now: number, timeoutMs: number): Promise<void> {
    for (const [executionId, usages] of this.unresolvedUsageByExecution) {
      const { expiredUsages, retainedUsages } = partitionStaleSessionEvents(usages, new Map(), now, timeoutMs);
      if (retainedUsages.length === 0) this.unresolvedUsageByExecution.delete(executionId);
      else this.unresolvedUsageByExecution.set(executionId, retainedUsages);
      const groups = [...groupUsageBySession(expiredUsages, executionId)];
      for (const [index, [sessionId, grouped]] of groups.entries()) {
        const retrySegments = this.standaloneRetrySegmentsByExecution.get(executionId) ?? new Map<string, number>();
        const segment = retrySegments.get(sessionId) ?? this.standaloneSegmentSequence++;
        retrySegments.set(sessionId, segment);
        this.standaloneRetrySegmentsByExecution.set(executionId, retrySegments);
        try {
          await this.flushStandaloneSession(sessionId, segment, grouped, [], now);
          retrySegments.delete(sessionId);
          if (retrySegments.size === 0) this.standaloneRetrySegmentsByExecution.delete(executionId);
        } catch (error) {
          const unexported = groups.slice(index).flatMap(([, pending]) => pending);
          const current = this.unresolvedUsageByExecution.get(executionId) ?? [];
          this.unresolvedUsageByExecution.set(executionId, [...unexported, ...current]);
          throw error;
        }
      }
    }
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
      const frameId =
        usage.frameId ?? (usage.sessionId !== undefined ? execution.sessionFrameMap.get(usage.sessionId) : undefined);
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
    await this.options.emit(drafts);
  }
}
