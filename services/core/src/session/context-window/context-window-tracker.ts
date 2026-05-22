import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import type { SessionContextWindowState, AgentContextState, ContextWindowTrackerConfig } from './types.js';

const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Tracks context window state per session, aggregating across agents.
 *
 * Subscribes to AgentSubjects.contextWindow.updated and maintains
 * per-session state using "worst agent" aggregation strategy.
 * @example
 * ```typescript
 * const tracker = new ContextWindowTracker(MakaioBus);
 * tracker.start();
 *
 * // Later, query session state
 * const state = tracker.getSessionState('session-123');
 * if (state?.level === 'critical') {
 *   // Suggest compression
 * }
 *
 * // Cleanup on shutdown
 * tracker.stop();
 * ```
 */
export class ContextWindowTracker {
  private readonly agentStates = new Map<string, AgentContextState>();
  private readonly sessionStates = new Map<string, SessionContextWindowState>();
  private unsubscribe?: () => void;
  private readonly staleThresholdMs: number;

  public constructor(
    private readonly bus: IMakaioBus,
    config?: ContextWindowTrackerConfig,
  ) {
    this.staleThresholdMs = config?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  }

  /**
   * Start tracking context window updates.
   * Idempotent - calling multiple times is safe.
   */
  public start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = this.bus.on(AgentSubjects.contextWindow.updated, (ctx) => {
      const { agentId, sessionId, currentTokens, maxTokens, percentage, level, cachedTokens } = ctx.payload;

      if (!sessionId) return; // Skip if no session association

      // Update agent state
      const agentState: AgentContextState = {
        agentId,
        sessionId,
        currentTokens,
        maxTokens,
        percentage,
        level,
        cachedTokens,
        updatedAt: Date.now(),
      };
      this.agentStates.set(agentId, agentState);

      // Recompute session state (worst agent)
      this.recomputeSessionState(sessionId);
    });
  }

  /**
   * Stop tracking and clear all state.
   */
  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.agentStates.clear();
    this.sessionStates.clear();
  }

  /**
   * Get aggregated context state for a session.
   *
   * State persists until explicitly cleared via clearSession().
   * Clear is called by MakaioSessionService on:
   * - session.close (session closed)
   * - session.compressed (context compression)
   *
   * Even if we haven't heard from agents recently, the context window
   * is still full - the state remains valid.
   * @param sessionId - The session to get state for
   * @returns The aggregated context window state, or undefined if no data
   */
  public getSessionState(sessionId: string): SessionContextWindowState | undefined {
    return this.sessionStates.get(sessionId);
  }

  /**
   * Clear state for a specific session (e.g., on session close).
   * Removes both the session state and all agent states for that session.
   * @param sessionId - The session to clear
   */
  public clearSession(sessionId: string): void {
    this.sessionStates.delete(sessionId);
    // Remove agent states for this session
    for (const [agentId, state] of this.agentStates) {
      if (state.sessionId === sessionId) {
        this.agentStates.delete(agentId);
      }
    }
  }

  /**
   * Recompute session state from all agents in that session.
   * Uses "worst agent" strategy - highest percentage wins.
   *
   * Stale agent entries are pruned for memory management, but session
   * state is preserved - context window is still full even if agent
   * hasn't reported recently.
   * @param sessionId - The session to recompute
   */
  private recomputeSessionState(sessionId: string): void {
    const now = Date.now();
    let worstState: AgentContextState | undefined;

    for (const [agentId, state] of this.agentStates) {
      // Prune stale agent entries for memory management
      if (now - state.updatedAt > this.staleThresholdMs) {
        this.agentStates.delete(agentId);
        continue;
      }
      if (state.sessionId !== sessionId) continue;

      if (!worstState || state.percentage > worstState.percentage) {
        worstState = state;
      }
    }

    // Only update session state if we have fresh agent data
    // If all agents are stale, preserve last known state (context is still full)
    if (worstState) {
      this.sessionStates.set(sessionId, {
        currentTokens: worstState.currentTokens,
        maxTokens: worstState.maxTokens,
        percentage: worstState.percentage,
        level: worstState.level,
        worstAgentId: worstState.agentId,
        lastUpdatedAt: worstState.updatedAt,
      });
    }
    // Note: We intentionally do NOT delete session state when agents go stale.
    // The context window is still full - state remains valid until explicit clear.
  }
}
