/**
 * Branch kind type guard utilities.
 *
 * Runtime type checking for branch kinds to determine behavior.
 *
 * ## Canonical Branch Semantics
 *
 * | kind          | in-view | navigates | mergeable | meaning                                      |
 * |---------------|---------|-----------|-----------|----------------------------------------------|
 * | `branch`      | yes     | no        | yes       | parallel work that can merge back            |
 * | `subagent`    | yes     | no        | yes       | spawned worker within current context        |
 * | `fork`        | no      | yes       | no        | independent exploration lineage              |
 * | `compress`    | no      | yes       | no        | context-reset continuation lineage           |
 * | `rewrite`     | no      | yes       | no        | edited history navigating to rewritten ver.  |
 * | `coordinator` | yes     | no        | no        | orchestration/session-management node        |
 * | `aside`       | yes     | no        | no        | ephemeral Q&A, excluded from AI context      |
 */

import type { BranchKind } from '../schemas/primitives.js';

/**
 * Descriptor object that fully characterises a branch kind's behaviour.
 *
 * Use {@link getBranchBehavior} to obtain an instance for a given kind.
 */
export interface BranchBehavior {
  /** Whether the branch stays visible in the parent session's branch tab list. */
  staysInView: boolean;
  /** Whether opening this branch navigates the UI away from the parent session. */
  navigatesToChild: boolean;
  /** Whether this branch can be merged back into the parent session. */
  canMergeBack: boolean;
  /** The branch kind this descriptor was derived from. */
  label: BranchKind;
}

/**
 * Exhaustive map of every {@link BranchKind} to its {@link BranchBehavior}.
 *
 * Typed as `Record<BranchKind, BranchBehavior>` so that TypeScript will
 * produce a compile-time error when a new kind is added to `BranchKindSchema`
 * but not added here.
 */
const BRANCH_BEHAVIORS: Record<BranchKind, BranchBehavior> = {
  branch: {
    label: 'branch',
    staysInView: true,
    navigatesToChild: false,
    canMergeBack: true,
  },
  subagent: {
    label: 'subagent',
    staysInView: true,
    navigatesToChild: false,
    canMergeBack: true,
  },
  fork: {
    label: 'fork',
    staysInView: false,
    navigatesToChild: true,
    canMergeBack: false,
  },
  compress: {
    label: 'compress',
    staysInView: false,
    navigatesToChild: true,
    canMergeBack: false,
  },
  rewrite: {
    label: 'rewrite',
    staysInView: false,
    navigatesToChild: true,
    canMergeBack: false,
  },
  coordinator: {
    label: 'coordinator',
    staysInView: true,
    navigatesToChild: false,
    canMergeBack: false,
  },
  aside: {
    label: 'aside',
    /**
     * True because aside renders inline in the parent chat (via forksByMessageId).
     * Note: aside is excluded from the branch context switcher separately
     * (see useBranchContexts filter) since it is not a navigable branch.
     */
    staysInView: true,
    navigatesToChild: false,
    canMergeBack: false,
  },
};

/**
 * Branches that stay in view (don't navigate away).
 * - `branch`: Parallel work that may merge back
 * - `subagent`: Spawned worker within current context
 * - `coordinator`: Orchestration/session-management node
 * - `aside`: Ephemeral Q&A rendered inline in parent
 *
 * `null` and `undefined` represent legacy sessions without a branch kind;
 * use the individual predicates directly for those cases rather than
 * {@link getBranchBehavior}.
 * @param kind - Branch kind to check
 * @returns True if the branch stays visible in the parent session view
 */
export function isInViewBranch(kind: BranchKind | null | undefined): boolean {
  return kind != null && BRANCH_BEHAVIORS[kind].staysInView;
}

/**
 * Branches that navigate away from parent.
 * - `fork`: Independent exploration (navigates to new session)
 * - `compress`: Context-reset continuation (navigates to compressed session)
 * - `rewrite`: Edited history navigating to the rewritten version
 * - `null` / `undefined`: Legacy behavior (pre-branchKind era)
 * @param kind - Branch kind to check
 * @returns True if opening the branch navigates away from the parent session
 */
export function isNavigatingBranch(kind: BranchKind | null | undefined): boolean {
  return kind == null || BRANCH_BEHAVIORS[kind].navigatesToChild;
}

/**
 * Branches that can be merged back to parent.
 * - `branch`: Parallel work that can merge back
 * - `subagent`: Spawned worker within current context
 *
 * `fork`, `compress`, `rewrite`, `coordinator`, and `aside` are NOT mergeable.
 * `fork` and `rewrite` are independent/edited lineages; `compress` is a
 * context-reset continuation; `coordinator` is an orchestration node;
 * `aside` is an ephemeral Q&A session that cannot contribute back to parent history.
 *
 * `null` and `undefined` represent legacy sessions without a branch kind;
 * use the individual predicates directly for those cases rather than
 * {@link getBranchBehavior}.
 * @param kind - Branch kind to check
 * @returns True if the branch supports merging back into the parent session
 */
export function isMergeable(kind: BranchKind | null | undefined): boolean {
  return kind != null && BRANCH_BEHAVIORS[kind].canMergeBack;
}

/**
 * Returns the full {@link BranchBehavior} descriptor for the given branch kind.
 *
 * This is the preferred API when more than one behavioural dimension is needed,
 * as it avoids querying multiple individual predicates.
 *
 * `null` and `undefined` represent legacy sessions without a branch kind and
 * are intentionally excluded from this API — use the individual predicates
 * ({@link isInViewBranch}, {@link isNavigatingBranch}, {@link isMergeable})
 * directly when the kind may be absent.
 * @param kind - The branch kind to describe
 * @returns A {@link BranchBehavior} descriptor with all behavioural flags set
 */
export function getBranchBehavior(kind: BranchKind): BranchBehavior {
  return BRANCH_BEHAVIORS[kind];
}
