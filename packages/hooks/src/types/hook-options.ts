import type { SubjectDefinition } from '@makaio/core';
import type { StartMode, StepType } from '@makaio/contracts';

/**
 * Base options shared by all hooks.
 */
export interface BaseHookOptions {
  /** Handler priority. Higher runs first. Default: 0 */
  priority?: number;
}

/**
 * Options for BusMessage hook (generic escape hatch).
 */
export interface BusMessageHookOptions<S extends SubjectDefinition = SubjectDefinition> extends BaseHookOptions {
  /** Subject to intercept (required) */
  subject: S;
}

// Placeholder options for named hooks (Phase 3 will add enrichment options)
export interface PreUserMessageHookOptions extends BaseHookOptions {
  /** Hook name for error attribution (default: 'anonymous') */
  name?: string;
  /** Number of recent turns to include (default: 5) */
  historyDepth?: number;
}

// PostUserMessage hook options with name field
export interface PostUserMessageHookOptions extends BaseHookOptions {
  /** Hook name for error attribution (default: 'anonymous') */
  name?: string;
}
export type PreTurnHookOptions = BaseHookOptions;

/**
 * Options for PostTurn hook.
 */
export interface PostTurnHookOptions extends BaseHookOptions {
  /** Hook name for error attribution (default: 'anonymous') */
  name?: string;
  /**
   * When true, the handler also runs for turns ingested from historical
   * imports (`session.turn.completed` with ingestionMarker `'backfill'`).
   * Default false: backfill emissions are filtered so LLM-driven consumers do
   * not stampede over historical imports. Live turns (marker `'live'` or
   * absent) always run.
   */
  includeBackfill?: boolean;
}

/**
 * Options for PostStep hook.
 *
 * Allows filtering by step type to only process specific step types.
 */
export interface PostStepHookOptions extends BaseHookOptions {
  /** Hook name for error attribution (default: 'anonymous') */
  name?: string;
  /**
   * Filter by step types. If specified, handler only called for these types.
   * When using createHook, defaults to ['reasoning'] if not specified.
   */
  stepTypes?: StepType[];
}

export type PreToolUseHookOptions = BaseHookOptions;
export type PostToolUseHookOptions = BaseHookOptions;

/**
 * Options for SessionStart hook.
 *
 * SessionStart hooks fire on `agent.started` events filtered by
 * {@link startModes}. The default filter is `['fresh', 'fork']` so that
 * hooks behave as session-initialisation hooks rather than per-turn hooks.
 */
export interface SessionStartHookOptions extends BaseHookOptions {
  /**
   * Start modes that trigger this hook.
   *
   * - `['fresh']` — only brand-new sessions (e.g. content injectors)
   * - `['fresh', 'fork']` — new sessions and forks (default)
   * - `START_MODES` — all modes (e.g. provider-lifecycle telemetry)
   * Defaults to `['fresh', 'fork']`.
   */
  startModes?: readonly StartMode[];
}

export type SessionEndHookOptions = BaseHookOptions;
