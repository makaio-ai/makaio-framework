import { z } from 'zod';
import type { GitFileChange, GitChangeStats } from './query.js';

// =============================================================================
// Commit Message Strategy - SEAM for commit message generation
// =============================================================================

/**
 * Built-in commit message strategy identifiers.
 *
 * - 'conventional': Conventional Commits format (type(scope): description)
 * - 'descriptive': Detailed multi-line description of changes
 * - 'minimal': Short one-line summary only
 * - 'custom': User-provided template with variable interpolation
 */
export const CommitMessageStrategyIdSchema = z.enum(['conventional', 'descriptive', 'minimal', 'custom']);
export type CommitMessageStrategyId = z.infer<typeof CommitMessageStrategyIdSchema>;

/**
 * Context provided to commit message strategies for message generation.
 *
 * Contains all information a strategy might need to compose a commit message.
 * The `files` and `stats` fields provide structured change data, while `diff`
 * provides the raw unified diff for strategies that analyze content.
 */
export interface CommitMessageContext {
  /** Files staged for commit */
  readonly files: readonly GitFileChange[];
  /** Aggregate change statistics */
  readonly stats: GitChangeStats;
  /** Current branch name */
  readonly branch: string;
  /** Unified diff of staged changes (optional, for content-analyzing strategies) */
  readonly diff?: string;
  /** Repository path */
  readonly repoPath?: string;
}

/**
 * Result from a commit message strategy.
 *
 * Follows git commit message conventions: a subject line (first line)
 * and an optional body (subsequent lines after a blank separator).
 */
export interface CommitMessageResult {
  /** The generated subject line (first line of commit message) */
  readonly subject: string;
  /** Optional body (lines after the subject, separated by blank line) */
  readonly body?: string;
}

/**
 * Strategy interface for generating commit messages.
 *
 * Implementations generate commit messages based on the current staged changes
 * and repository context. Register custom strategies via the bus to extend
 * the built-in set.
 *
 * Strategies may be synchronous (template-based) or asynchronous (AI-powered).
 *
 * SEAM: Plugins can register their own strategies (e.g., AI-generated messages,
 * ticket-based templates, team conventions).
 * @example
 * ```typescript
 * const conventionalStrategy: ICommitMessageStrategy = {
 *   id: 'conventional',
 *   name: 'Conventional Commits',
 *   description: 'Generates messages in type(scope): description format',
 *   generate: (context) => ({
 *     subject: `feat(${inferScope(context)}): ${inferDescription(context)}`,
 *   }),
 * };
 * ```
 */
export interface ICommitMessageStrategy {
  /** Unique strategy identifier */
  readonly id: string;
  /** Human-readable strategy name */
  readonly name: string;
  /** Description of what this strategy does */
  readonly description: string;
  /**
   * Generate a commit message from the given context.
   * @param context - Repository and staging context for message generation
   * @returns Generated commit message (sync or async)
   */
  generate(context: CommitMessageContext): CommitMessageResult | Promise<CommitMessageResult>;
}

// =============================================================================
// Merge Strategy - SEAM for merge operation configuration
// =============================================================================

/**
 * Built-in merge strategy identifiers.
 *
 * - 'merge-commit': Standard merge with merge commit (default)
 * - 'squash': Squash all commits into one before merging
 * - 'rebase': Rebase commits onto target instead of merging
 * - 'fast-forward': Only allow fast-forward merges
 */
export const MergeStrategyIdSchema = z.enum(['merge-commit', 'squash', 'rebase', 'fast-forward']);
export type MergeStrategyId = z.infer<typeof MergeStrategyIdSchema>;

/**
 * Context provided to merge strategies.
 */
export interface MergeContext {
  /** Source branch or ref being merged */
  readonly source: string;
  /** Target branch (current branch) */
  readonly target: string;
  /** Repository path */
  readonly repoPath: string;
}

/**
 * Hook that runs before or after a merge operation.
 *
 * Pre-merge hooks can abort the merge by throwing an error.
 * Post-merge hooks run after successful merge completion.
 */
export interface IMergeHook {
  /** Unique hook identifier */
  readonly id: string;
  /** Human-readable hook name */
  readonly name: string;
  /**
   * Execute the hook.
   * @param context - Merge context
   * @throws Error to abort (pre-merge) or report failure (post-merge)
   */
  execute(context: MergeContext): Promise<void>;
}

/**
 * Strategy interface for merge operations.
 *
 * Encapsulates how a merge should be performed, including the merge approach
 * and any pre/post hooks.
 *
 * SEAM: Plugins can register custom merge strategies with team-specific
 * workflows (e.g., auto-stash before merge, run tests after merge).
 * @example
 * ```typescript
 * const squashStrategy: IMergeStrategy = {
 *   id: 'squash',
 *   name: 'Squash Merge',
 *   description: 'Squash all commits into a single commit',
 *   preHooks: [autoStashHook],
 *   postHooks: [notifyHook],
 *   getMergeApproach: () => 'squash',
 * };
 * ```
 */
export interface IMergeStrategy {
  /** Unique strategy identifier */
  readonly id: string;
  /** Human-readable strategy name */
  readonly name: string;
  /** Description of what this strategy does */
  readonly description: string;
  /** Hooks to run before the merge operation */
  readonly preHooks: readonly IMergeHook[];
  /** Hooks to run after successful merge */
  readonly postHooks: readonly IMergeHook[];
  /**
   * Determine the merge approach for the given context.
   * @param context - Merge context
   * @returns The merge approach to use
   */
  getMergeApproach(context: MergeContext): 'merge' | 'squash' | 'fast-forward-only' | 'rebase';
}
