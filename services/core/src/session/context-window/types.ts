/**
 * Context window tracking types for per-session aggregation.
 *
 * The tracker monitors AgentSubjects.contextWindow.updated events
 * and maintains per-session state using "worst agent" aggregation.
 */

/**
 * Per-session context window state, aggregated across agents.
 *
 * Uses "worst agent" strategy: reports the state of whichever
 * agent has the highest usage percentage.
 */
export interface SessionContextWindowState {
  /** Current token count (worst across agents) */
  currentTokens: number;
  /** Max tokens for the model with lowest headroom */
  maxTokens: number;
  /** Percentage used (0-100) */
  percentage: number;
  /** Warning level based on percentage */
  level: 'ok' | 'warn' | 'critical';
  /** Agent ID with the highest usage */
  worstAgentId?: string;
  /** Timestamp of last update */
  lastUpdatedAt: number;
}

/**
 * Per-agent context state (internal tracking).
 *
 * Stored by the tracker to enable per-session aggregation
 * when multiple agents are attached to the same session.
 */
export interface AgentContextState {
  agentId: string;
  sessionId: string;
  currentTokens: number;
  maxTokens: number;
  percentage: number;
  level: 'ok' | 'warn' | 'critical';
  cachedTokens?: number;
  updatedAt: number;
}

/**
 * Tracker configuration options.
 */
export interface ContextWindowTrackerConfig {
  /** How long to keep stale agent entries (ms). Default: 1 hour */
  staleThresholdMs?: number;
}
