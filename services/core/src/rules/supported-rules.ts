import type { ValidateRulesInput } from '@makaio/contracts/rules';
import { ALL_GROUP_STRATEGY_KIND } from '../rule-contributions/builtins/all-group-strategy.js';

/** Find rules that use constructs outside the supported evaluation scope.
 * @param input - Effective rule set.
 * @returns Unsupported construct locations by rule.
 */
export function unsupportedRules(input: ValidateRulesInput): Map<string, string> {
  const members = new Map<string, number>();
  const groups = new Map(input.groups.map((group) => [group.group, group.strategy]));
  const unsupported = new Map<string, string>();
  for (const rule of input.rules) {
    if (rule.group !== undefined) members.set(rule.group, (members.get(rule.group) ?? 0) + 1);
  }
  for (const rule of input.rules) {
    if (rule.stop) unsupported.set(rule.id, 'stop');
    if (rule.group === undefined) continue;
    const strategy = groups.get(rule.group);
    if ((strategy !== undefined && strategy !== ALL_GROUP_STRATEGY_KIND) || (members.get(rule.group) ?? 0) > 1) {
      unsupported.set(rule.id, 'group');
    }
  }
  for (const item of input.excluded ?? []) unsupported.set(item.ruleId, 'excluded');
  return unsupported;
}
