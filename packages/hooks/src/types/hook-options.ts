import type { SubjectDefinition } from '@makaio/core';
import type { StepType } from '@makaio/contracts';

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
export type SessionStartHookOptions = BaseHookOptions;
export type SessionEndHookOptions = BaseHookOptions;
