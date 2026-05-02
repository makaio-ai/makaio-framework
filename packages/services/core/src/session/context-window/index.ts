/**
 * Context window tracking module.
 *
 * Provides per-session context window state aggregated across agents.
 * Uses "worst agent" strategy for session-level state.
 */

export type { AgentContextState, ContextWindowTrackerConfig, SessionContextWindowState } from './types.js';
export { ContextWindowTracker } from './context-window-tracker.js';
