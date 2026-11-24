import type { GroupDecision, GroupStrategyContribution, RuleId } from '@makaio/contracts/rules';

/** Canonical kind of the core's "every matched member acts" group strategy. */
export const ALL_GROUP_STRATEGY_KIND = 'makaio.all';

/**
 * The core's "all" group strategy: every member of the group is evaluated,
 * descending by priority, and every member that matches acts.
 *
 * `decide` only routes what `evaluate` reports for each member into the
 * matching list of the {@link GroupDecision} — it never withholds a member
 * from evaluation and never invents a stop of its own. A member a caller's
 * `evaluate` already reports as `stopped` (because an earlier, higher-priority
 * member in the same group declared `stop: 'group'` and matched) is carried
 * through to `stopped` unchanged, so the completeness invariant every member
 * in exactly one list holds for every shape `evaluate` can return, not only
 * for the no-stop case.
 */
export const allGroupStrategy: GroupStrategyContribution = {
  strategy: ALL_GROUP_STRATEGY_KIND,
  description: 'Evaluates every member of the group; every member that matches acts.',

  async decide(members, evaluate): Promise<GroupDecision> {
    const acting: RuleId[] = [];
    const stopped: Array<{ ruleId: RuleId; by: readonly RuleId[] }> = [];
    const notMatched: RuleId[] = [];

    for (const member of members) {
      const result = await evaluate(member.ruleId);
      if ('stopped' in result) {
        stopped.push({ ruleId: member.ruleId, by: result.stopped });
      } else if (result.matched) {
        acting.push(member.ruleId);
      } else {
        notMatched.push(member.ruleId);
      }
    }

    return { acting, stopped, notMatched };
  },
};
