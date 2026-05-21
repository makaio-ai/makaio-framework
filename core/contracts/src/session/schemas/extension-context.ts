import type { Message } from '../../shared/index.js';

/**
 * Options for forking a session.
 */
export interface ForkOptions {
  /** Why this fork was created (for audit) */
  reason: string;
  /** Which agent should handle the child session */
  targetAgentId?: string;
  /** Initial message for child session */
  initialMessage?: Message;
  /** Whether to copy parent's context to child (default: true) */
  inheritContext?: boolean;
}

/**
 * Context window state for threshold checking.
 */
export interface ContextWindowState {
  currentTokens: number;
  maxTokens: number;
  percentage: number;
  level: 'ok' | 'warn' | 'critical';
}

/**
 * Session-specific context provided to extensions during lifecycle events.
 * All actions route through SessionOrchestrator.
 *
 * Note: This is separate from PluginContext (extensions/core) which is for initialize().
 */
export interface SessionExtensionContext {
  // --- Read-Only Info ---

  /** Current session ID */
  readonly sessionId: string;

  /** Current turn ID (if in a turn) */
  readonly turnId?: string;

  /** Parent session ID (if this is a forked session) */
  readonly parentSessionId?: string;

  /** Extension's own ID (for audit trail) */
  readonly extensionId: string;

  // --- Message Actions ---

  /**
   * Send a message to an agent.
   * Routes through SessionOrchestrator, not directly to agent.
   */
  sendToAgent(agentId: string, message: Message): Promise<void>;

  // --- Context Contribution ---

  /**
   * Contribute context for the next turn.
   * Added to SessionContext.context via declaration-merge pattern.
   */
  contributeContext(key: string, value: unknown): void;

  // --- Session Lifecycle ---

  /**
   * Fork the current session into a child session.
   * @returns Child session ID
   */
  fork(options: ForkOptions): Promise<string>;

  /**
   * Merge a child session back into this session.
   */
  merge(childSessionId: string, summary?: string): Promise<void>;

  /**
   * Abandon a child session without merging.
   */
  abandon(childSessionId: string): Promise<void>;

  // --- Compression ---

  /**
   * Request compression of the current session.
   */
  requestCompression(reason: string): Promise<void>;

  // --- Query ---

  /**
   * Get current context window state.
   */
  getContextWindowState(): Promise<ContextWindowState>;

  /**
   * Get child sessions of current session.
   */
  getChildSessions(): Promise<string[]>;
}

/**
 * Factory function type for creating SessionExtensionContext instances.
 */
export type SessionExtensionContextFactory = (
  sessionId: string,
  extensionId: string,
  turnId?: string,
) => SessionExtensionContext;
