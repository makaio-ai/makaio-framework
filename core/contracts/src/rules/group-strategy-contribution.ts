import type { RuleId, StrategyKind } from './identifiers.js';

/**
 * Outcome of evaluating one member of a group: whether it matched, or that it
 * was already stopped by the rules named in `stopped` before it was evaluated.
 */
export type MemberResult =
  | { readonly matched: false }
  | { readonly matched: true }
  | { readonly stopped: readonly RuleId[] };

/**
 * Decision of a group's strategy over its members on one occasion.
 */
export interface GroupDecision {
  /** Members that act. */
  readonly acting: readonly RuleId[];
  /** Members stopped, not evaluated, with who caused the stop. */
  readonly stopped: ReadonlyArray<{ readonly ruleId: RuleId; readonly by: readonly RuleId[] }>;
  /** Members that did not match. */
  readonly notMatched: readonly RuleId[];
}

/**
 * A group's strategy as an extension contributes it; an open set.
 */
export interface GroupStrategyContribution {
  /** Kind of strategy. */
  readonly strategy: StrategyKind;
  /** Human-readable description of the strategy. */
  readonly description: string;
  /**
   * Decides over the members of a group on one occasion, descending by
   * priority. `evaluate` evaluates one member (lookups, condition) and
   * returns `stopped` for a member already stopped with reach `'group'` by an
   * earlier member. `decide` reads nothing except through `evaluate`.
   * @param members - Members of the group, with their priority.
   * @param evaluate - Evaluates one member by identifier.
   * @returns The decision over every member.
   */
  decide(
    members: ReadonlyArray<{ readonly ruleId: RuleId; readonly priority: number }>,
    evaluate: (ruleId: RuleId) => Promise<MemberResult>,
  ): Promise<GroupDecision>;
}
