/**
 * Public result types for {@link ClaudeCodeClientSettings} methods.
 *
 * Kept in a separate file so consuming code can import only the types without
 * pulling in the runtime class and its dependencies.
 * @packageDocumentation
 */

import type {
  ClaudeCodeScope,
  ClaudeCodeStatuslineValue,
  ClaudeCodeHookMatcherGroup,
  ClaudeCodePluginEntry,
} from '../schemas/config.js';

/**
 * Result of listing the status-line configuration across all available scopes.
 */
export interface StatuslineListResult {
  /**
   * The resolved status-line value after last-scope-wins override, or `null`
   * when no scope defines one.
   */
  effective: ClaudeCodeStatuslineValue | null;
  /**
   * Per-scope breakdown in resolution order (broadest → narrowest).
   */
  perScope: Array<{
    scope: ClaudeCodeScope;
    path: string;
    value: ClaudeCodeStatuslineValue | null;
  }>;
}

/**
 * Result of writing a status-line value to a scope.
 */
export interface StatuslineSetResult {
  /** Previous value at the target scope before the write, or `null`. */
  previous: ClaudeCodeStatuslineValue | null;
  /** The value that was actually persisted. */
  applied: ClaudeCodeStatuslineValue;
}

/**
 * Result of removing the status-line entry from a scope.
 */
export interface StatuslineRemoveResult {
  /** The value that was removed, or `null` when no entry existed. */
  previous: ClaudeCodeStatuslineValue | null;
  /** `true` when an entry was removed; `false` when none was present. */
  removed: boolean;
}

/**
 * Result of listing hooks across all available scopes.
 */
export interface HooksListResult {
  /**
   * Additively merged hook map across all scopes, keyed by event name.
   * Every scope's groups are concatenated in resolution order.
   */
  effective: Record<string, ClaudeCodeHookMatcherGroup[]>;
  /**
   * Per-scope breakdown so callers can distinguish which scope contributed
   * each hook.
   */
  perScope: Array<{
    scope: ClaudeCodeScope;
    path: string;
    events: Record<string, ClaudeCodeHookMatcherGroup[]>;
  }>;
}

/**
 * Result of adding a hook to a scope.
 */
export interface HookAddResult {
  /**
   * `true` when the hook was appended; `false` when an identical entry already
   * existed and no write was performed.
   */
  added: boolean;
}

/**
 * Result of removing hooks from a scope.
 */
export interface HookRemoveResult {
  /** Number of hook definitions that were removed. */
  removed: number;
}

/**
 * Result of listing effective extensions across all available scopes.
 */
export interface PluginsListResult {
  /** Effective plugin entries after last-scope-wins override per plugin name. */
  plugins: ClaudeCodePluginEntry[];
}
