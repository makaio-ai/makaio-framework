/**
 * Pure trace assembly for terminal workflow executions.
 * @packageDocumentation
 */

import type { SpanDraft, SpanEventDraft, SpanDraftStatus } from '../contracts/types.js';
import { SpanBuilder } from './span-builder.js';
import type { BufferedToolCall, BufferedUsage, OpenExecution } from './types.js';

/** Input for {@link buildExecutionTrace}. */
export interface ExecutionTraceInput {
  /** Execution state captured by the collector. */
  readonly execution: OpenExecution;
  /** Terminal execution timestamp in Unix milliseconds. */
  readonly endedAt: number;
  /** Terminal status applied to unfinished frames. */
  readonly status: Extract<SpanDraftStatus, 'ok' | 'error'>;
  /** Optional events attached to the root execution span. */
  readonly rootEvents?: readonly SpanEventDraft[];
  /** Orphan spans already promoted for this execution. */
  readonly orphans?: readonly SpanDraft[];
}

/**
 * Keep a parent frame only when its span will be present in the same trace.
 * @param execution - Execution whose frames will be emitted.
 * @param frameId - Candidate direct or session-derived frame identifier.
 * @returns The known frame identifier, or `undefined` for orphan handling.
 */
function resolveKnownFrameId(execution: OpenExecution, frameId: string | undefined): string | undefined {
  return frameId !== undefined && execution.frames.has(frameId) ? frameId : undefined;
}

/**
 * Build a single LLM span from buffered usage.
 * @param execution - Execution that owns the usage.
 * @param usage - Buffered provider usage event.
 * @param frameId - Resolved parent frame, when known.
 * @returns Fully resolved LLM span draft.
 */
export function buildExecutionUsageSpan(
  execution: OpenExecution,
  usage: BufferedUsage,
  frameId: string | undefined,
): SpanDraft {
  const endedAt = usage.occurredAt ?? usage.ingestedAt;
  const startedAt = usage.duration === undefined ? endedAt : endedAt - usage.duration;

  return SpanBuilder.buildLlmSpan({
    granularity: usage.granularity,
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
    orphaned: frameId === undefined,
  });
}

/**
 * Build a single tool span from buffered lifecycle state.
 * @param execution - Execution that owns the tool call.
 * @param tool - Buffered tool lifecycle state.
 * @param frameId - Resolved parent frame, when known.
 * @param fallbackEndedAt - End timestamp for an unfinished tool call.
 * @returns Fully resolved tool span draft.
 */
export function buildExecutionToolSpan(
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

/**
 * Assemble a terminal execution trace in root, frame, usage, tool, orphan order.
 * @param input - Execution state and terminal metadata.
 * @returns Ordered span drafts for one execution.
 */
export function buildExecutionTrace(input: ExecutionTraceInput): SpanDraft[] {
  const { execution, endedAt, status } = input;
  const root = SpanBuilder.buildExecutionSpan({
    executionId: execution.executionId,
    workflowId: execution.workflowId,
    startedAt: execution.startedAt,
    endedAt,
    status,
  });
  const drafts: SpanDraft[] = [input.rootEvents === undefined ? root : { ...root, events: input.rootEvents }];

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

  for (const usage of execution.pendingUsage) {
    const candidateFrameId =
      usage.frameId ?? (usage.sessionId === undefined ? undefined : execution.sessionFrameMap.get(usage.sessionId));
    const frameId = resolveKnownFrameId(execution, candidateFrameId);
    drafts.push(buildExecutionUsageSpan(execution, usage, frameId));
  }
  for (const tool of execution.pendingTools.values()) {
    const candidateFrameId = tool.sessionId === undefined ? undefined : execution.sessionFrameMap.get(tool.sessionId);
    const frameId = resolveKnownFrameId(execution, candidateFrameId);
    drafts.push(buildExecutionToolSpan(execution, tool, frameId, endedAt));
  }
  if (input.orphans !== undefined) drafts.push(...input.orphans);
  return drafts;
}
