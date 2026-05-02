import type { FocusContext } from './focus-context.js';

/**
 * Describes a UI side effect that an action handler intends to produce.
 *
 * Action handlers return an `ActionIntent` rather than executing effects directly.
 * The framework's intent executor interprets and dispatches each kind.
 *
 * SEAM: New intent kinds are added here. The executor in `web/framework` gains a
 * corresponding case. Platform services return intents without depending on execution.
 * @example
 * ```typescript
 * const intent: ActionIntent = { kind: 'clipboard', text: commit.hash };
 * const compound: ActionIntent = {
 *   kind: 'compound',
 *   intents: [
 *     { kind: 'clipboard', text: commit.hash },
 *     { kind: 'feedback', message: 'Hash copied', variant: 'success' },
 *   ],
 * };
 * ```
 */
export type ActionIntent =
  | { readonly kind: 'noop' }
  | { readonly kind: 'clipboard'; readonly text: string; readonly feedback?: string }
  | { readonly kind: 'navigate'; readonly target: FocusContext }
  | { readonly kind: 'openEditor'; readonly filePath: string; readonly line?: number; readonly column?: number }
  | { readonly kind: 'openPage'; readonly pageId: string; readonly internalRoute?: string }
  | { readonly kind: 'busRequest'; readonly subject: string; readonly payload?: Record<string, unknown> }
  | { readonly kind: 'feedback'; readonly message: string; readonly variant?: 'info' | 'success' | 'warning' | 'error' }
  | {
      readonly kind: 'confirm';
      readonly title: string;
      readonly message: string;
      readonly onConfirmIntent: ActionIntent;
    }
  | { readonly kind: 'compound'; readonly intents: readonly ActionIntent[] }
  /**
   * Open a diff view for a file.
   *
   * - `commitId` is `null` for working-tree diffs (right side is read from disk).
   * - `status` is the git file status character (A/M/D/R/…) for commit contexts.
   * - `parentCount` drives empty-tree handling for root commits.
   * - `originalPath` carries the rename origin when the file was renamed.
   * - `variant` is the working-tree section ('staged' | 'unstaged' | 'untracked' | 'conflicted').
   */
  | {
      readonly kind: 'viewDiff';
      readonly filePath: string;
      readonly commitId: string | null;
      readonly status?: string;
      readonly parentCount?: number;
      readonly originalPath?: string;
      readonly variant?: string;
    }
  /**
   * Show file content at a specific commit in the inline file viewer panel.
   * Only valid for commit-context files.
   */
  | { readonly kind: 'viewAtCommit'; readonly filePath: string; readonly commitId: string }
  /**
   * Show blame annotations for a file at a specific commit in the inline blame panel.
   * Only valid for commit-context files.
   */
  | { readonly kind: 'viewBlame'; readonly filePath: string; readonly commitId: string }
  /**
   * Compare a file across revisions using the diff viewer.
   *
   * Equivalent to `viewDiff` but with `useEmptyTreeForRoot = true` — root commits
   * are shown as full-add diffs against the empty tree. For working-tree contexts,
   * untracked files are silently skipped.
   *
   * - `commitId` is `null` for working-tree compare.
   * - `status`, `parentCount`, `originalPath`, `variant` carry the same semantics as `viewDiff`.
   */
  | {
      readonly kind: 'compareVersions';
      readonly filePath: string;
      readonly commitId: string | null;
      readonly status?: string;
      readonly parentCount?: number;
      readonly originalPath?: string;
      readonly variant?: string;
    };
