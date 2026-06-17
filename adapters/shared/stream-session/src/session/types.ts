import type { ScopedBus } from '@makaio/bus-core';
import type {
  AIReasoningLevel,
  MessageHandle,
  MessageResult,
  AgentStartedEvent,
  ErrorEvent,
} from '@makaio/ai-adapters-core';

/**
 * Union of SDK event types emitted directly by the base stream session.
 *
 * Adapter configs use a broader union (`SdkEventMessage`) that includes all
 * adapter-specific events. Since `AgentStartedEvent` and `ErrorEvent` are
 * members of every adapter's `SdkEventMessage` union, a function accepting
 * the broader union satisfies this narrower parameter type via contravariance.
 */
export type BaseSessionEmitEvent = AgentStartedEvent | ErrorEvent;

/**
 * Minimal typed envelope for the `message_complete` SDK event returned
 * from `bus.once()` inside the base stream session.
 *
 * Both adapter namespaces wrap their SDK events in an envelope with the same
 * shape (event, agentId?, adapterId?, ...). The base session only
 * needs `event.eventType` for dispatch and passes the full payload to
 * `applyMessageComplete` which is implemented by each adapter subclass.
 */
export interface StreamSdkEventEnvelope {
  /** Inner SDK event discriminated by `eventType`. */
  event: { eventType: string } & Record<string, unknown>;
  /** Agent ID from the envelope for bus filter matching. */
  agentId?: string;
  /** Adapter ID from the envelope for bus filter matching. */
  adapterId?: string;
  /** Adapter name from the envelope. */
  adapterName?: string;
  /** Session ID from the envelope. */
  sessionId?: string;
  /** Adapter-local session ID from the envelope for turn correlation. */
  adapterSessionId?: string;
}

/**
 * Shared configuration interface for stream-based connector sessions.
 *
 * Contains all fields common to the Anthropic SDK and OpenAI Node session
 * configurations. SDK-specific fields (`client`, tool-list types) remain
 * in each adapter's own config type which extends this interface.
 * @typeParam TBus - Scoped bus type for the adapter namespace
 */
export interface StreamSessionConfig<TBus extends ScopedBus<string> = ScopedBus<string>> {
  /** Scoped bus for the adapter namespace. */
  bus: TBus;
  /** Stable adapter instance identifier. */
  adapterId: string;
  /** Human-readable adapter name used in log messages and bus events. */
  adapterName: string;
  /** Agent ID for tool execution attribution and bus subject filtering. */
  agentId: string;
  /** Makaio session ID for tool execution context. Stable across turns. */
  sessionId?: string;
  /** Provider-assigned session identifier forwarded to tool execution context. */
  adapterSessionId?: string;
  /** Working directory for tool execution context. */
  cwd: string;
  /** Initial model identifier; mutable per turn via `updateModel()`. */
  model: string;
  /** Reasoning effort level for reasoning-capable models. */
  reasoningEffort?: AIReasoningLevel;
  /**
   * Timeout in milliseconds before the streaming API call is considered
   * failed. A single retry is attempted before the error propagates.
   */
  streamStartTimeoutMs?: number;
  /** Environment variables forwarded to tool execution. */
  env: Record<string, string>;
  /** Resolved system prompt string prepended to the message array. */
  systemPrompt?: string;
  /**
   * Emit a typed SDK lifecycle event to the connector bus.
   * Adapter configs narrow this to their full `SdkEventMessage` union.
   * The base session only emits `agent_started` and `error` events,
   * both of which are members of every adapter's `SdkEventMessage` union.
   */
  emitSdkEvent: (event: BaseSessionEmitEvent) => Promise<void>;
  /** Handle a connector-level error. */
  handleError: (error: Error, rethrow: boolean) => void;
  /** Called synchronously when a new turn is about to start. */
  onTurnStart?: (handle: MessageHandle) => void;
  /** Called when a turn reaches a terminal state (completed or error). */
  onTurnComplete?: (handle: MessageHandle, result: MessageResult) => void;
  /** Optional low-level event logger for adapter observability. */
  logLowLevelEvent?: (event: unknown) => void;
  /**
   * Directory restrictions for file-system tool execution.
   * Forwarded as `constraints.allowedDirectories` in every tool call.
   * - `undefined`: no directory restriction
   * - `[]`: deny all filesystem paths
   * - non-empty array: allow-list to these directories
   */
  allowedDirectories?: string[];
  /**
   * Record one mcp_call invocation in the session tool ledger.
   *
   * When present, the session forwards this to `HandleToolCallsCallbacks` so
   * the shared `handleToolCalls` function can record mcp_call invocations.
   * The connector binds it as a closure over its ledger and current turn number,
   * so no turn-number threading is needed at the session level.
   * @param toolFullName - The namespaced target tool name from the mcp_call args
   */
  recordMcpCall?: (toolFullName: string) => void;
}
