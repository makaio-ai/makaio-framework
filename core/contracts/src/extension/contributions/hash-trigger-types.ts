import type { MakaioBusLike } from '@makaio/core';

/** Pipeline stage a hash trigger participates in. */
export type HashTriggerStage = 'gather' | 'transform' | 'action';

/** Single suggestion entry returned by a hash trigger's suggest call. */
export interface HashSuggestion {
  /** Display label shown in the completion UI. */
  label: string;
  /** Human-readable explanation of the suggestion. */
  description: string;
  /** Whether this suggestion is a leaf (directly usable) or a group (opens sub-list). */
  kind: 'leaf' | 'group';
  /** Text inserted into the input when the suggestion is accepted. */
  insertText: string;
  /** Underlying value passed to execute when the suggestion is used. */
  value: string;
  /** Optional icon identifier for the suggestion entry. */
  icon?: string;
  /** Pipeline stage override for this particular suggestion. */
  stage?: HashTriggerStage;
}

/** A single entry gathered by a gather-stage hash trigger. */
export interface GatheredEntry {
  /** Gathered content string. */
  content: string;
  /** Prefix token that matched this entry. */
  prefix: string;
  /** Argument portion of the matched hash value. */
  argument: string;
  /** Optional arbitrary metadata from the gatherer. */
  metadata?: Record<string, unknown>;
}

/** Snapshot of all entries gathered by gather-stage triggers in this pipeline run. */
export interface GatheredContext {
  /** Immutable map of prefix → entry. */
  entries: ReadonlyMap<string, GatheredEntry>;
}

/**
 * Context passed to a hash trigger's suggest and execute methods.
 * @typeParam TBus - Host bus shape supplied by the runtime.
 */
export interface HashTriggerContext<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Active session identifier, if any. */
  sessionId?: string;
  /** Active project identifier, if any. */
  projectId?: string;
  /** Current message text. */
  message?: string;
  /** Bus instance for trigger operations. */
  bus: TBus;
  /** Optional abort signal for cancellable operations. */
  signal?: AbortSignal;
  /** Entries gathered by earlier gather-stage triggers. */
  gathered?: GatheredContext;
}

/** Static descriptor for a registered hash trigger. */
export interface HashTriggerMetadata {
  /** Prefix token this trigger responds to (e.g. `'@'`, `'#'`). */
  prefix: string;
  /** Human-readable explanation of what this trigger does. */
  description: string;
  /** Semantic version of this trigger. */
  version: string;
  /** Pipeline stage this trigger participates in. */
  stage?: HashTriggerStage;
  /** Names of triggers that must run before this one. */
  runAfter?: string[];
}

/** Return value from a hash trigger's suggest call. */
export interface HashTriggerSuggestResult {
  /** Suggested completions. */
  suggestions: HashSuggestion[];
  /** Optional metadata about the result set. */
  metadata?: {
    /** Whether the result set was truncated due to size limits. */
    truncated?: boolean;
  };
}

/**
 * A registered hash trigger that can suggest completions and execute values.
 *
 * Implement this interface and return instances from
 * `MakaioExtension.hashTriggers.createHashTriggers` so the runtime registers them
 * with the HashTriggerService.
 * @typeParam TBus - Host bus shape supplied by the runtime.
 */
export interface HashTrigger<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Static descriptor used for registration and pipeline ordering. */
  metadata: HashTriggerMetadata;
  /**
   * Return completion suggestions for the current query.
   * @param query - Text typed after the prefix token.
   * @param context - Runtime context for this suggestion request.
   * @returns Suggestion list with optional pagination metadata.
   */
  suggest(query: string, context: HashTriggerContext<TBus>): Promise<HashTriggerSuggestResult>;
  /**
   * Execute the selected value (optional).
   *
   * Called when the user accepts a suggestion whose `kind` is `'leaf'`.
   * @param value - The accepted suggestion's `value` field.
   * @param context - Runtime context for this execution.
   * @returns Resolved content string inserted into the message.
   */
  execute?(value: string, context: HashTriggerContext<TBus>): Promise<string>;
}
