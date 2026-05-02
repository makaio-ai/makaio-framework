import type { IMakaioBus, InterceptorContext } from '@makaio/bus-core';
import type {
  IMakaioSession,
  JsonValue,
  SessionMessageBlock,
  SessionSubjects,
  StepFinished,
  StepType,
  Turn,
} from '@makaio/contracts';
import type { SessionSendMessageRequest } from '@makaio/contracts/session';
import type { ExtractSubjectPayload } from '@makaio/core';

/** Session-level turn.completed payload (distinct from agent-level TurnCompleted) */
type SessionTurnCompleted = ExtractSubjectPayload<typeof SessionSubjects.turn.completed>;

/**
 * Base context shared by all hooks.
 */
export interface BaseHookContext<P> extends InterceptorContext<P> {
  /** Hook event name */
  readonly hookEvent: string;
}

/**
 * Generic BusMessage context for escape hatch.
 * Simply an alias for InterceptorContext - no extra fields needed.
 */
export type BusMessageContext<P = unknown> = InterceptorContext<P>;

/**
 * Core context properties available to request-based hooks.
 * This is a subset of RequestContext that hooks care about.
 */
export interface RequestHookContext<P> {
  /** The request payload (readonly via getter, mutable via replacePayload) */
  readonly payload: P;
  /** Message identifier (optional - may not be present if not provided by caller) */
  readonly messageId?: string;
  /** Correlation identifier for tracing (optional) */
  readonly correlationId?: string;
  /**
   * Replace the payload with a new value.
   * Subsequent handlers in the middleware chain will receive the new payload.
   *
   * **Note:** Only `message` and `sessionContext` can be replaced. Routing fields
   * (`agentId`, `adapterId`, `sessionId`, `messageId`, `deliveryMode`) are
   * intentionally immutable to preserve message routing integrity.
   */
  replacePayload(newPayload: Partial<P>): void;
  /**
   * Continue to the next handler in the middleware chain.
   */
  next(): Promise<void>;
}

/**
 * Session enrichment props shared across session-aware hooks.
 *
 * Hooks that operate within a session context (PreUserMessage, PostTurn, etc.)
 * can extend this interface to get access to session and history data.
 *
 * Enrichment is optional - fields may be undefined if sessionId wasn't available
 * or if the lookup failed (graceful degradation).
 *
 * Host code augments this interface via declaration merging to add
 * host-owned fields (e.g., `project`, `worktree`) contributed by a
 * `SessionSubjects.enrichContext` handler.
 */
export interface SessionHookContext {
  /** Session object (populated when sessionId is available) */
  readonly session?: IMakaioSession;
  /** Recent turn history, oldest first (up to 10 turns) */
  readonly recentHistory: Turn[];
  /** Bus instance for making requests */
  readonly bus: IMakaioBus;
  /**
   * Arbitrary context extensions contributed by the host-registered
   * `SessionSubjects.enrichContext` handler. Framework spreads these onto
   * the context object at hook-call time. Empty object in OSS mode.
   */
  readonly contextExtensions: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Extended payload type for PreUserMessage context.
 * Includes SessionSendMessageRequest fields plus runner-specific fields.
 * Uses Partial because not all request fields are available in the runner context.
 *
 * Note: `cwd` is runner-injected from the connector's current working directory
 * (via `AgentTurnExecutor`) — it is NOT a wire-protocol field and is independent
 * of the `SessionSendMessageRequest` schema. It is always present when the hook
 * fires from the adapter layer.
 */
export type PreUserMessagePayload = Partial<SessionSendMessageRequest> & {
  /** Agent ID (runner-specific, not part of SessionSendMessageRequest) */
  agentId?: string;
  /** Adapter ID (runner-specific, not part of SessionSendMessageRequest) */
  adapterId?: string;
  /** Message content (always present) */
  message: SessionSendMessageRequest['message'];
  /**
   * Current working directory of the agent connector at the time the hook fires.
   * Injected by the adapter runner from connector state — not from the wire protocol.
   * Plugins use this to scope file-system operations to the agent's directory.
   */
  cwd?: string;
};

/**
 * PreUserMessage context with enriched session data.
 *
 * Intercepts: AgentSubjects.sendMessage RPC via request middleware
 *
 * When sessionId is present in SendMessageRequest, the context builder
 * queries the bus to populate session, recentHistory, and project fields.
 * Without sessionId, these fields remain undefined/empty (hooks may fire
 * before a session is established).
 */
export interface PreUserMessageContext extends RequestHookContext<PreUserMessagePayload>, SessionHookContext {
  readonly hookEvent: 'PreUserMessage';
  /**
   * Set turn context for downstream consumers.
   * Uses replacePayload() to add context to sessionContext.turnContext.
   * Value must be JSON-serializable.
   * @param key - Turn context key to write (e.g. 'guides', 'cwdChange')
   * @param value - JSON-serializable value to store under the key
   */
  setTurnContext(key: string, value: JsonValue): void;
  /**
   * Get turn context set by THIS hook instance.
   * Returns only context set via setTurnContext() in this handler.
   * Context from earlier hooks is merged separately after handler completes.
   * @returns Turn context values set by this hook instance only
   */
  getTurnContext(): Record<string, JsonValue>;
  /** Abort message processing. Throws HookAbortError. */
  abort(reason?: string): never;
}

/**
 * PostUserMessage context.
 *
 * Fires after a user message has been sent to the agent but before
 * the agent starts processing. Useful for detection and enforcement hooks.
 *
 * NOTE: No session enrichment in current implementation (SEAM for Phase 3).
 */
export interface PostUserMessageContext {
  readonly hookEvent: 'PostUserMessage';
  /** Session ID (may be undefined for sessionless messages) */
  readonly sessionId?: string;
  /** Message ID for correlation */
  readonly messageId?: string;
  /** Agent ID that received the message */
  readonly agentId: string;
  /** Adapter ID */
  readonly adapterId: string;
  /** Bus instance for making requests */
  readonly bus: IMakaioBus;
}

export interface PreTurnContext extends BaseHookContext<unknown> {
  readonly hookEvent: 'PreTurn';
}

/**
 * PostTurn context with turn completion data.
 *
 * Intercepts: SessionSubjects.turn.completed event
 *
 * Provides access to turn outcome (success/error) and identifiers.
 * Useful for semantic extraction, analytics, and post-processing.
 *
 * Extends SessionHookContext for optional session enrichment (session,
 * recentHistory, project) when available.
 */
export interface PostTurnContext extends SessionHookContext {
  readonly hookEvent: 'PostTurn';
  /** Session ID where turn completed */
  readonly sessionId: string;
  /** Turn identifier */
  readonly turnId: string;
  /** Whether all agents completed successfully */
  readonly success: boolean;
  /** Error message if any agent failed */
  readonly error?: string;
  /** Full turn.completed payload for advanced use */
  readonly payload: SessionTurnCompleted;
  /** Message identifier for correlation */
  readonly messageId: string;
  /** Correlation identifier for tracing */
  readonly correlationId?: string;
  /**
   * Continue to the next interceptor in the chain.
   */
  next(): Promise<void>;
  /**
   * Stop propagation of this event.
   * Subsequent interceptors and handlers will NOT be called.
   */
  stopPropagation(): void;
}

/**
 * PostStep context with step completion data.
 *
 * Intercepts: AgentSubjects.step.finished event
 *
 * Provides access to step type, metadata, and optional filtering.
 * Enriches with session, recentHistory, and project when available.
 *
 * Use stepType to filter for specific step types:
 * - 'reasoning': Thinking/reasoning blocks (extended thinking enabled)
 * - 'tool_use': Tool calls
 * - 'text': Regular text message blocks
 */
export interface PostStepContext extends SessionHookContext {
  readonly hookEvent: 'PostStep';
  /** Session ID where step completed */
  readonly sessionId?: string;
  /** Agent that completed the step */
  readonly agentId: string;
  /** Adapter instance */
  readonly adapterId: string;
  /** Adapter type name */
  readonly adapterName: string;
  /** Message ID being processed */
  readonly messageId?: string;
  /** Step type (reasoning, tool_use, text) */
  readonly stepType: StepType;
  /** Content block index */
  readonly blockIndex: number;
  /**
   * Step content block (if available).
   *
   * Fetched from message storage with retry logic. May be undefined if:
   * - messageId not available
   * - Message not yet persisted (timing window)
   * - Block index out of range
   *
   * Contains actual content: reasoning text, tool args, or message text.
   */
  readonly stepContent?: SessionMessageBlock;
  /** Full step.finished payload for advanced use */
  readonly payload: StepFinished;
  /** Correlation identifier for tracing */
  readonly correlationId?: string;
  /**
   * Continue to the next interceptor in the chain.
   */
  next(): Promise<void>;
  /**
   * Stop propagation of this event.
   */
  stopPropagation(): void;
}

export interface PreToolUseContext extends BaseHookContext<unknown> {
  readonly hookEvent: 'PreToolUse';
}

export interface PostToolUseContext extends BaseHookContext<unknown> {
  readonly hookEvent: 'PostToolUse';
}

export interface SessionStartContext extends BaseHookContext<unknown> {
  readonly hookEvent: 'SessionStart';
}

export interface SessionEndContext extends BaseHookContext<unknown> {
  readonly hookEvent: 'SessionEnd';
}
