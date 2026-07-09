/**
 * Internal types for the telemetry-otel collector layer.
 *
 * These types describe the mutable state held while an execution is in-flight.
 * They are collector-private; consumers interact with the output {@link SpanDraft}
 * contract defined in `../contracts/types.ts`.
 * @packageDocumentation
 */

import type { SpanDraftStatus } from '../contracts/types.js';

/** Subset of `agent.usage` consumed by the collector. */
export interface AgentUsagePayload {
  readonly llmCallId?: string;
  readonly executionId?: string;
  readonly frameId?: string;
  readonly agentId?: string;
  readonly adapterId?: string;
  readonly adapterName?: string;
  readonly sessionId?: string;
  readonly adapterSessionId?: string;
  readonly messageId?: string;
  readonly turnId?: string;
  readonly clientId?: string;
  readonly providerConfigId?: string;
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
  readonly costProvenance?: 'provider-reported' | 'client-reported' | 'estimated';
  readonly duration?: number;
  readonly occurredAt?: number;
}

/**
 * Metadata captured from a `workflow.frame.started` event and retained for the
 * duration of the frame.
 *
 * `frame.completed` and `frame.failed` do not carry `nodeType` or `path`, so
 * the collector keeps this snapshot to fill those fields on the output span.
 */
export interface FrameRecord {
  /** Unique frame identifier within the execution. */
  readonly frameId: string;
  /** Node ID from the workflow definition. */
  nodeId: string;
  /** Node type discriminant preserved from `frame.started`. */
  nodeType: string;
  /** Ordered path of frame IDs from root to this frame (inclusive). */
  path: readonly string[];
  /** Parent frame ID when present (absent for the root frame). */
  parentFrameId: string | undefined;
  /** Wall-clock start time in Unix milliseconds. */
  startedAt: number;
  /**
   * Wall-clock end time in Unix milliseconds.
   *
   * `undefined` while the frame is still open; set when `frame.completed` or
   * `frame.failed` arrives.
   */
  endedAt: number | undefined;
  /** Terminal status resolved from the frame lifecycle event. */
  status: SpanDraftStatus;
}

/**
 * A single `agent.usage` event held in the buffer while the collector
 * waits for the matching `frame.sessionLinked` event.
 */
export interface BufferedUsage {
  /** Runtime-generated identifier for one concrete provider API request. */
  readonly llmCallId: string | undefined;
  /** Authoritative workflow execution supplied by the provider request context. */
  readonly executionId: string | undefined;
  /** Workflow frame supplied directly by the provider request context. */
  readonly frameId: string | undefined;
  /** Agent identifier from the usage event. */
  readonly agentId: string | undefined;
  /** Adapter instance identifier from the usage event. */
  readonly adapterId: string | undefined;
  /** Adapter type/name from the usage event. */
  readonly adapterName: string | undefined;
  /**
   * Session identifier from the usage event.
   *
   * `undefined` when the adapter did not populate `sessionId`; the event will
   * be promoted to an orphan span on the next orphan sweep.
   */
  readonly sessionId: string | undefined;
  /** Provider-native session identifier when known. */
  readonly adapterSessionId: string | undefined;
  /** User message identifier when known. */
  readonly messageId: string | undefined;
  /** Turn identifier when known. */
  readonly turnId: string | undefined;
  /** Owning client/CLI identifier when known. */
  readonly clientId: string | undefined;
  /** Resolved provider configuration identifier when known. */
  readonly providerConfigId: string | undefined;
  /** LLM provider name (e.g. `'openai'`, `'anthropic'`). */
  readonly provider: string;
  /** Model identifier (e.g. `'gpt-5.4'`). */
  readonly model: string;
  /** Input token count for this API call. */
  readonly inputTokens: number;
  /** Cached input token count for this API call. */
  readonly inputCachedTokens: number;
  /** Prompt-cache write token count for this API call, when reported. */
  readonly cacheWriteTokens: number | undefined;
  /** Output token count for this API call. */
  readonly outputTokens: number;
  /** Reasoning token count for this API call. */
  readonly reasoningTokens: number;
  /** Total token count for this API call. */
  readonly totalTokens: number;
  /** Cost quantity in the unit specified by {@link costUnitType}. */
  readonly costUnits: number;
  /** Unit type for {@link costUnits}. */
  readonly costUnitType: 'requests' | 'tokens';
  /** Optional estimated monetary cost for this API call. */
  readonly cost: number | undefined;
  /** Optional ISO-style currency code for {@link cost}. */
  readonly currency: string | undefined;
  /** Provenance of the optional monetary cost. */
  readonly costProvenance: 'provider-reported' | 'client-reported' | 'estimated' | undefined;
  /**
   * Optional API call latency in milliseconds.
   *
   * When present the usage event timestamp is treated as the call end time and
   * the span start is computed by subtracting this duration.
   */
  readonly duration: number | undefined;
  /** Event occurrence timestamp in epoch milliseconds when known. */
  readonly occurredAt: number | undefined;
  /** Collector clock value when this event was ingested (Unix ms). */
  readonly ingestedAt: number;
  /** Zero-based sequence number within the execution, used for span ID generation. */
  readonly sequence: number;
}

/**
 * Usage event buffered before the collector knows which execution owns the
 * session. The event is replayed into an execution when `frame.sessionLinked`
 * arrives for the same session.
 */
export type UnresolvedUsage = Omit<BufferedUsage, 'sequence'>;

/**
 * State held for a tool call span while the owning execution is open.
 */
export interface BufferedToolCall {
  /** Session identifier from the agent tool event. */
  readonly sessionId: string | undefined;
  /** Tool name shown in trace UIs and attributes. */
  toolName: string;
  /** Tool call identifier used for correlation. */
  readonly toolCallId: string;
  /** Tool span start time in Unix milliseconds. */
  startedAt: number;
  /** Collector clock value when the first tool event was observed (Unix ms). */
  readonly ingestedAt: number;
  /** Tool span end time in Unix milliseconds when completion was observed. */
  endedAt: number | undefined;
  /** Tool success flag when supplied by `agent.tool.completed`. */
  success: boolean | undefined;
}

/**
 * Tool call buffered before the collector knows which execution owns the
 * session. Sessionless calls use the sole-open-execution fallback and later
 * export as orphan spans.
 */
export type UnresolvedToolCall = Omit<BufferedToolCall, 'startedAt' | 'ingestedAt' | 'endedAt'> & {
  /** Source event start time for the tool call span. */
  readonly startedAt: number;
  /** Collector clock value when the first tool event was observed. */
  readonly ingestedAt: number;
  /** Completion time if `agent.tool.completed` has arrived. */
  endedAt: number | undefined;
};

/**
 * State held for a single workflow execution while it is open.
 *
 * Created on `workflow.execution.started` and flushed (and removed) on any
 * terminal execution event (`completed`, `failed`, or `cancelled`).
 */
export interface OpenExecution {
  /** Execution identifier. */
  readonly executionId: string;
  /** Workflow definition identifier. */
  readonly workflowId: string;
  /** Wall-clock start time of the execution in Unix milliseconds. */
  readonly startedAt: number;
  /** Frames observed for this execution, keyed by frameId. */
  readonly frames: Map<string, FrameRecord>;
  /**
   * Usage events that have not yet been linked to a frame.
   *
   * Events in this list already belong to this execution. A later
   * `frame.sessionLinked` event may still provide the frame reference before
   * terminal flush.
   */
  readonly pendingUsage: BufferedUsage[];
  /** Tool calls observed for sessions associated with this execution. */
  readonly pendingTools: Map<string, BufferedToolCall>;
  /**
   * Session-to-frame mappings resolved via `frame.sessionLinked`.
   *
   * Key: sessionId. Value: frameId within this execution.
   */
  readonly sessionFrameMap: Map<string, string>;
  /** Next sequence counter for LLM span IDs within this execution. */
  usageSequence: number;
}

/**
 * Configuration options for the {@link SpanCollector}.
 */
export interface CollectorOptions {
  /**
   * Clock function returning the current wall-clock time in Unix milliseconds.
   *
   * Injected to allow deterministic time in tests.
   */
  readonly now: () => number;
  /**
   * Time in milliseconds after which execution-owned sessionless events are
   * promoted to orphan spans and unlinked sessioned events are exported as
   * standalone trace segments.
   *
   * The timeout remains a late-correlation window for `frame.sessionLinked`.
   * When set to `0`, unresolved sessioned events remain buffered until a link
   * arrives or the service flushes during shutdown.
   */
  readonly orphanTimeoutMs: number;
  /**
   * Maximum number of concurrently open executions before the oldest is evicted.
   */
  readonly maxOpenExecutions: number;
  /**
   * Callback invoked once per terminal execution event with the fully-built
   * {@link SpanDraft} array for that execution.
   * @param drafts - Ordered list of span drafts: root → frames → LLM/tool spans.
   */
  readonly emit: (drafts: import('../contracts/types.js').SpanDraft[]) => Promise<void>;
}
