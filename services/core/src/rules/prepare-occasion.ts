import { matchesSubscription } from '@makaio/bus-core';
import { isSubjectPattern } from '@makaio/core';
import { ConditionSchema, JsonRecordSchema } from '@makaio/contracts';
import type { GroupEvaluationView, ReactionRule, RuleGroup } from '@makaio/contracts/rules';
import type { RuleContributionsService } from '../rule-contributions/rule-contributions-service.js';
import { ALL_GROUP_STRATEGY_KIND } from '../rule-contributions/builtins/all-group-strategy.js';
import { pinRuleSource, pinStorageValue } from './pin-rule-source.js';
import { unsupportedRules } from './supported-rules.js';
import type {
  BlockedRule,
  PinnedRuleOccasion,
  PreparedRule,
  RuleOccasion,
  RuleOccasionPreparation,
  RuleSourceBlockReason,
} from './types.js';

/** Capture and check the source and trigger projections before the enqueue transaction.
 * @param service - Active contribution directory.
 * @param input - Incoming occasion supplied by the host.
 * @param source - Effective rule set returned by the live source.
 * @returns Work for the commit, no match, or an unavailable source.
 */
export async function prepareRuleOccasion(
  service: RuleContributionsService,
  input: Omit<RuleOccasion, 'snapshot'>,
  source: unknown,
): Promise<RuleOccasionPreparation> {
  const pinned = pinRuleSource(source);
  if (pinned.state !== 'pinned') return pinned;
  const { snapshot, entries } = pinned;
  const occasion = { ...structuredClone(input), snapshot };
  const entriesById = Map.groupBy(entries, ({ id }) => id);
  const groupsByName = Map.groupBy(snapshot.groups, ({ group }) => group);
  const rules: PreparedRule[] = [];
  const usableRules: ReactionRule[] = [];
  const blockedRules: BlockedRule[] = [];
  for (const [sourceIndex, { id, rule }] of entries.entries()) {
    let projection: PreparedRule | RuleSourceBlockReason | undefined;
    if (id !== null && (entriesById.get(id)?.length ?? 0) > 1) {
      projection = 'duplicate-rule-id';
    } else if (!rule) {
      projection = 'rule-invalid';
    } else if (!hasValidGroup(rule, groupsByName)) {
      projection = 'invalid-rule-set';
    } else {
      projection = await projectRule(service, occasion, rule);
    }
    if (typeof projection === 'string') {
      blockedRules.push({ sourceIndex, ruleId: id, reason: projection });
      continue;
    }
    if (rule) usableRules.push(rule);
    if (projection) rules.push(projection);
  }

  const unsupported =
    unsupportedRules({ ...snapshot, rules: usableRules }).size > 0 || 'message' in occasion.event.cause;
  const excludedMatches = await matchesExclusion(service, occasion);
  if (rules.length === 0 && blockedRules.length === 0 && !excludedMatches) return { state: 'no-match' };
  const blockedReason = unsupported ? 'not-implemented' : undefined;
  const groups = prepareGroups(rules, snapshot.groups);
  return { state: 'prepared', work: { occasion, rules, blockedRules, blockedReason, groups } };
}

/** @param rule - Structurally valid source rule.
 * @param groups - Group declarations indexed by name.
 * @returns Whether the rule has a valid group membership.
 */
function hasValidGroup(rule: ReactionRule, groups: ReadonlyMap<string, readonly RuleGroup[]>): boolean {
  if (rule.group === undefined) return true;
  return groups.get(rule.group)?.length === 1 && rule.priority !== undefined && !rule.mandatory;
}

/** @param service - Active trigger directory.
 * @param occasion - Pinned incoming occasion.
 * @returns Whether an excluded rule's trigger matches the occasion.
 */
async function matchesExclusion(service: RuleContributionsService, occasion: PinnedRuleOccasion): Promise<boolean> {
  for (const { rule } of occasion.snapshot.excluded) {
    if (!rule) continue;
    const projection = await projectRule(service, occasion, rule);
    if (projection && typeof projection !== 'string') return true;
  }
  return false;
}

/** @param service - Active trigger directory.
 * @param occasion - Pinned incoming occasion.
 * @param rule - Structurally valid rule to consider.
 * @returns A matching projection, a source block reason, or undefined for a nonmatching rule.
 */
async function projectRule(
  service: RuleContributionsService,
  occasion: PinnedRuleOccasion,
  rule: ReactionRule,
): Promise<PreparedRule | RuleSourceBlockReason | undefined> {
  const { kind, params } = rule.on;
  const trigger = service.trigger(kind);
  if (!trigger) return 'trigger-unavailable';
  try {
    const valid = trigger.params
      ? (await trigger.params.safeParseAsync(structuredClone(params))).success
      : params === undefined;
    if (!valid) return 'trigger-parameters-invalid';
    const patterns = trigger.subjects(structuredClone(params));
    if (!Array.isArray(patterns) || !patterns.length || !patterns.every(isSubjectPattern))
      return 'trigger-projection-invalid';
    const { subject } = occasion.event;
    if (!patterns.some((pattern) => matchesSubscription(subject, pattern))) return undefined;
    const projected = trigger.toFacts({ subject, payload: structuredClone(occasion.payload) });
    if (projected === null) return undefined;
    const facts = JsonRecordSchema.safeParse(pinStorageValue(projected));
    if (!facts.success) return 'trigger-projection-invalid';
    const event = { ...occasion.event, facts: facts.data };
    if (!trigger.expand || params === undefined) return { rule, event };
    const condition = ConditionSchema.safeParse(pinStorageValue(trigger.expand(structuredClone(params))));
    return condition.success ? { rule, event, triggerCondition: condition.data } : 'trigger-projection-invalid';
  } catch {
    return 'trigger-projection-invalid';
  }
}

/** @param rules - Rules whose triggers fired.
 * @param groups - Declared strategies by group.
 * @returns Group envelopes, with independent rules represented as single-member groups.
 */
function prepareGroups(
  rules: readonly PreparedRule[],
  groups: RuleOccasion['snapshot']['groups'],
): GroupEvaluationView[] {
  const envelopes: GroupEvaluationView[] = [];
  for (const { rule } of rules) {
    const group = rule.group ?? null;
    const member = { ruleId: rule.id, priority: rule.priority };
    const existing = group === null ? undefined : envelopes.find((entry) => entry.group === group);
    if (existing) {
      existing.members.push(member);
      continue;
    }
    const strategy = group === null ? ALL_GROUP_STRATEGY_KIND : groups.find((entry) => entry.group === group)?.strategy;
    if (!strategy) continue;
    envelopes.push({
      group,
      strategy,
      members: [member],
      state: 'pending',
      acting: [],
      stopped: [],
      notMatched: [],
    });
  }
  for (const envelope of envelopes) {
    envelope.members.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  }
  return envelopes;
}
