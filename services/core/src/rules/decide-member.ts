import { JsonRecordSchema } from '@makaio/contracts';
import { readDotPath } from '@makaio/contracts/shared';
import { evaluate } from '@makaio/rules';
import type { RuleContributionsService } from '../rule-contributions/rule-contributions-service.js';
import { DecisionFailure, type DecisionFailureReason } from './decision-failure.js';
import { resolveParameters } from './parameter-tree.js';
import { LookupConditionError, resolveLookups, type DecisionDeadline, type RuleFacts } from './resolve-lookups.js';
import { ruleCall } from './rule-call.js';
import type { PreparedPart, PreparedRule } from './types.js';

/** A member can fail before the strategy makes a group decision. */
type MemberFailure =
  | Extract<DecisionFailureReason, 'lookup-args-invalid' | 'lookup-answer-invalid'>
  | 'condition-error';

/** Evaluation of a member, before the strategy decides whether it may act. */
export type MemberDecision =
  | { readonly state: 'not-matched' }
  | { readonly state: 'matched'; readonly facts: RuleFacts }
  | { readonly state: 'failed'; readonly reason: MemberFailure; readonly conditionPath?: string };

/** Evaluate a rule's lookups and combined guard against pinned trigger facts.
 * @param service - Active contribution directory.
 * @param input - Original rule and projected event.
 * @param deadline - Shared deadline for the decision and its lookups.
 * @returns Match, mismatch, or a permanent evaluation failure.
 */
export async function decideMember(
  service: RuleContributionsService,
  input: PreparedRule,
  deadline: DecisionDeadline,
): Promise<MemberDecision> {
  const { event, rule, triggerCondition } = input;
  const facts: RuleFacts = { $event: structuredClone(event), $lookup: {} };
  try {
    if (!(await resolveLookups(service, rule.lookups ?? [], facts, ruleCall(event), deadline))) {
      return { state: 'not-matched' };
    }
  } catch (error) {
    if (error instanceof LookupConditionError)
      return { state: 'failed', reason: 'condition-error', conditionPath: error.path };
    if (
      error instanceof DecisionFailure &&
      (error.reason === 'lookup-args-invalid' || error.reason === 'lookup-answer-invalid')
    )
      return { state: 'failed', reason: error.reason };
    throw error;
  }
  const conditions = [triggerCondition, rule.when].filter((condition) => condition !== undefined);
  const result = evaluate({ $and: conditions }, facts);
  if ('error' in result) return { state: 'failed', reason: 'condition-error', conditionPath: result.error.path };
  return result.matched ? { state: 'matched', facts } : { state: 'not-matched' };
}

/** Resolve the effect inputs for a member selected by the group.
 * @param service - Active contribution directory.
 * @param input - Original rule and projected event.
 * @param facts - Facts produced by its guard and lookups.
 * @returns Pinned parts or a permanent failure.
 */
export async function prepareParts(
  service: RuleContributionsService,
  input: PreparedRule,
  facts: RuleFacts,
): Promise<PreparedPart[] | { reason: string }> {
  const { rule } = input;
  const definition = service.reaction(rule.reaction.kind);
  if (!definition) throw new DecisionFailure('contribution-unavailable');
  const items = rule.each === undefined ? [undefined] : readDotPath(facts, rule.each);
  if (!Array.isArray(items)) return { reason: 'each-unresolved' };
  const parts: PreparedPart[] = [];
  for (const [position, item] of items.entries()) {
    const value = resolveParameters(rule.reaction.params ?? {}, { ...facts, $item: item }, 'record');
    const parameters = JsonRecordSchema.safeParse(value);
    const reason = !parameters.success
      ? 'parameters-unresolved'
      : (await definition.parameterSchema.safeParseAsync(parameters.data).then(
            (parsed) => parsed.success,
            () => false,
          ))
        ? undefined
        : 'params-invalid';
    parts.push({ position, item, parameters: parameters.data ?? {}, keyed: definition.keyed, reason });
  }
  return parts;
}
