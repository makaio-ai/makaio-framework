/**
 * Pure static helpers for constructing {@link SpanDraft} objects.
 *
 * All ID schemes and attribute mappings are centralised here so the collector
 * and tests share a single source of truth. No state is held — every method is
 * a pure function of its arguments.
 * @packageDocumentation
 */

import type { SpanDraft, SpanDraftStatus } from '../contracts/types.js';

/** Input bag for {@link SpanBuilder.buildExecutionSpan}. */
export interface BuildExecutionSpanInput {
  /** Workflow execution identifier. */
  readonly executionId: string;
  /** Workflow definition identifier. */
  readonly workflowId: string;
  /** Span start time in Unix milliseconds. */
  readonly startedAt: number;
  /** Span end time in Unix milliseconds. */
  readonly endedAt: number;
  /** Terminal status to write on the root span. */
  readonly status: SpanDraftStatus;
}

/** Input bag for {@link SpanBuilder.buildFrameSpan}. */
export interface BuildFrameSpanInput {
  /** Workflow execution identifier. */
  readonly executionId: string;
  /** Frame identifier within the execution. */
  readonly frameId: string;
  /** Node identifier from the workflow definition. */
  readonly nodeId: string;
  /** Node type discriminant (e.g. `'station'`). */
  readonly nodeType: string;
  /** Ordered path of frame IDs from root to this frame. */
  readonly path: readonly string[];
  /** Parent frame ID when present (absent for the root frame). */
  readonly parentFrameId: string | undefined;
  /** Span start time in Unix milliseconds. */
  readonly startedAt: number;
  /** Span end time in Unix milliseconds. */
  readonly endedAt: number;
  /** Terminal status to write on the frame span. */
  readonly status: SpanDraftStatus;
}

/** Input bag for {@link SpanBuilder.buildLlmSpan}. */
export interface BuildLlmSpanInput {
  /** Workflow execution identifier. */
  readonly executionId: string;
  /** Agent session identifier. */
  readonly sessionId: string;
  /**
   * Frame identifier this LLM call belongs to.
   *
   * `undefined` for orphan spans that could not be linked to a frame.
   */
  readonly frameId: string | undefined;
  /** Zero-based sequence number within the execution (used in the span ID). */
  readonly sequence: number;
  /** LLM provider name. */
  readonly provider: string;
  /** Model identifier. */
  readonly model: string;
  /** Input token count. */
  readonly inputTokens: number;
  /** Cached input token count. */
  readonly inputCachedTokens: number;
  /** Prompt-cache write token count when reported by the provider. */
  readonly cacheWriteTokens?: number;
  /** Output token count. */
  readonly outputTokens: number;
  /** Reasoning token count. */
  readonly reasoningTokens: number;
  /** Total token count. */
  readonly totalTokens: number;
  /** Optional estimated monetary cost. */
  readonly cost?: number;
  /** Optional currency for {@link cost}. */
  readonly currency?: string;
  /** Optional API call latency in milliseconds. */
  readonly duration?: number;
  /** Span start time in Unix milliseconds. */
  readonly startedAt: number;
  /** Span end time in Unix milliseconds. */
  readonly endedAt: number;
  /** Whether this span could not be correlated to a frame. */
  readonly orphaned: boolean;
}

/** Input bag for {@link SpanBuilder.buildToolSpan}. */
export interface BuildToolSpanInput {
  /** Workflow execution identifier. */
  readonly executionId: string;
  /** Agent session identifier. */
  readonly sessionId: string;
  /** Frame identifier this tool call belongs to, or `undefined` for orphans. */
  readonly frameId: string | undefined;
  /** Tool call identifier from the agent event. */
  readonly toolCallId: string;
  /** Tool name from the agent event. */
  readonly toolName: string;
  /** Span start time in Unix milliseconds. */
  readonly startedAt: number;
  /** Span end time in Unix milliseconds. */
  readonly endedAt: number;
  /** Tool success flag when known. */
  readonly success?: boolean;
  /** Whether this span could not be correlated to a frame. */
  readonly orphaned: boolean;
}

/**
 * Stateless factory for {@link SpanDraft} construction.
 *
 * All public methods are `static` so callers do not need an instance.
 */
export class SpanBuilder {
  /**
   * Returns the stable span ID for a workflow execution root span.
   * @param executionId - Workflow execution identifier.
   * @returns Stable string span ID of the form `execution:<executionId>`.
   */
  public static executionSpanId(executionId: string): string {
    return `execution:${executionId}`;
  }

  /**
   * Returns the stable span ID for a workflow frame span.
   * @param executionId - Workflow execution identifier.
   * @param frameId - Frame identifier within the execution.
   * @returns Stable string span ID of the form `frame:<executionId>:<frameId>`.
   */
  public static frameSpanId(executionId: string, frameId: string): string {
    return `frame:${executionId}:${frameId}`;
  }

  /**
   * Returns the stable span ID for an LLM call span.
   * @param executionId - Workflow execution identifier.
   * @param sessionId - Agent session identifier.
   * @param sequence - Zero-based sequence number within the execution.
   * @returns Stable string span ID of the form `llm:<executionId>:<sessionId>:<sequence>`.
   */
  public static llmSpanId(executionId: string, sessionId: string, sequence: number): string {
    return `llm:${executionId}:${sessionId}:${sequence}`;
  }

  /**
   * Returns the stable span ID for a tool call span.
   * @param executionId - Workflow execution identifier.
   * @param sessionId - Agent session identifier.
   * @param toolCallId - Tool call identifier from the agent event.
   * @returns Stable string span ID of the form `tool:<executionId>:<sessionId>:<toolCallId>`.
   */
  public static toolSpanId(executionId: string, sessionId: string, toolCallId: string): string {
    return `tool:${executionId}:${sessionId}:${toolCallId}`;
  }

  /**
   * Builds the root execution span for a workflow execution.
   * @param input - Resolved execution metadata and timing.
   * @returns A fully-resolved {@link SpanDraft} for the execution root span.
   */
  public static buildExecutionSpan(input: BuildExecutionSpanInput): SpanDraft {
    return {
      spanId: SpanBuilder.executionSpanId(input.executionId),
      executionId: input.executionId,
      namespace: 'workflow',
      subject: 'execution',
      name: `Workflow ${input.executionId}`,
      kind: 'internal',
      status: input.status,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      attributes: {
        'makaio.execution.id': input.executionId,
        'makaio.workflow.id': input.workflowId,
      },
      links: [],
      events: [],
    };
  }

  /**
   * Builds a frame span representing a single workflow node execution.
   *
   * The span is parented to its workflow parent frame when one is known,
   * otherwise to the execution root span.
   * @param input - Resolved frame metadata and timing.
   * @returns A fully-resolved {@link SpanDraft} for the frame span.
   */
  public static buildFrameSpan(input: BuildFrameSpanInput): SpanDraft {
    const parentSpanId =
      input.parentFrameId !== undefined
        ? SpanBuilder.frameSpanId(input.executionId, input.parentFrameId)
        : SpanBuilder.executionSpanId(input.executionId);

    return {
      spanId: SpanBuilder.frameSpanId(input.executionId, input.frameId),
      parentSpanId,
      executionId: input.executionId,
      frameId: input.frameId,
      namespace: 'workflow',
      subject: 'frame',
      name: `Frame ${input.nodeId}`,
      kind: isDelegateNodeType(input.nodeType) ? 'client' : 'internal',
      status: input.status,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      attributes: {
        'makaio.frame.id': input.frameId,
        'makaio.frame.node_id': input.nodeId,
        'makaio.frame.node_type': input.nodeType,
        'makaio.frame.path': [...input.path],
      },
      links: [],
      events: [],
    };
  }

  /**
   * Builds an LLM call span from a resolved agent usage event.
   *
   * When `input.frameId` is defined the span is parented to the frame span;
   * otherwise no parent is set and `correlation.orphaned` is added to the
   * attributes.
   * @param input - Resolved LLM call metadata, timing, and orphan flag.
   * @returns A fully-resolved {@link SpanDraft} for the LLM call span.
   */
  public static buildLlmSpan(input: BuildLlmSpanInput): SpanDraft {
    const parentSpanId =
      input.frameId !== undefined ? SpanBuilder.frameSpanId(input.executionId, input.frameId) : undefined;

    const attributes: Record<string, string | number | boolean | null> = {
      'llm.provider': input.provider,
      'llm.model': input.model,
      'llm.tokens.input': input.inputTokens,
      'llm.tokens.cached_input': input.inputCachedTokens,
      'llm.tokens.output': input.outputTokens,
      'llm.tokens.reasoning': input.reasoningTokens,
      'llm.tokens.total': input.totalTokens,
    };

    if (input.cacheWriteTokens !== undefined) {
      attributes['llm.tokens.cache_write'] = input.cacheWriteTokens;
    }
    if (input.cost !== undefined) {
      attributes['llm.cost.estimated'] = input.cost;
    }
    if (input.currency !== undefined) {
      attributes['llm.cost.currency'] = input.currency;
    }
    if (input.duration !== undefined) {
      attributes['llm.duration_ms'] = input.duration;
    }

    if (input.orphaned) {
      attributes['correlation.orphaned'] = true;
    }

    return {
      spanId: SpanBuilder.llmSpanId(input.executionId, input.sessionId, input.sequence),
      parentSpanId,
      executionId: input.executionId,
      sessionId: input.sessionId,
      namespace: 'agent',
      subject: 'usage',
      name: `LLM call ${input.model}`,
      kind: 'client',
      status: 'ok',
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      attributes,
      links: [],
      events: [],
    };
  }

  /**
   * Builds a tool call span from resolved agent tool lifecycle events.
   * @param input - Resolved tool call metadata, timing, and orphan flag.
   * @returns A fully-resolved {@link SpanDraft} for the tool call.
   */
  public static buildToolSpan(input: BuildToolSpanInput): SpanDraft {
    const parentSpanId =
      input.frameId !== undefined ? SpanBuilder.frameSpanId(input.executionId, input.frameId) : undefined;
    const attributes: Record<string, string | number | boolean | null> = {
      'tool.name': input.toolName,
      'tool.call_id': input.toolCallId,
    };

    if (input.success !== undefined) {
      attributes['tool.success'] = input.success;
    }
    if (input.orphaned) {
      attributes['correlation.orphaned'] = true;
    }

    return {
      spanId: SpanBuilder.toolSpanId(input.executionId, input.sessionId, input.toolCallId),
      parentSpanId,
      executionId: input.executionId,
      sessionId: input.sessionId,
      namespace: 'agent',
      subject: 'tool',
      name: `Tool ${input.toolName}`,
      kind: 'internal',
      status: input.success === undefined ? 'unset' : input.success ? 'ok' : 'error',
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      attributes,
      links: [],
      events: [],
    };
  }
}

/**
 * Determine whether a workflow node type represents a delegated agent call.
 * @param nodeType - Workflow node type discriminant.
 * @returns `true` when the frame should be represented as an OTel client span.
 */
function isDelegateNodeType(nodeType: string): boolean {
  return nodeType === 'delegate-agent' || nodeType === 'delegate-role';
}
