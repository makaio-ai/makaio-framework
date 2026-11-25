import type { EvaluationState, GroupDecision, RuleId } from '@makaio/contracts/rules';
import type { RuleContributionsService } from '../rule-contributions/rule-contributions-service.js';
import { beforeDeadline, type DecisionDeadline } from './resolve-lookups.js';
import { DecisionFailure, type StoredDecisionGroup } from './decision-failure.js';
import { decideMember, prepareParts, type MemberDecision } from './decide-member.js';
import type { RuleCauseRow, RuleEvaluationRow } from './storage/schema.js';
import type { PreparedPart } from './types.js';

/** Expired decision attempts allowed before a group is left in a terminal state. */
const MAX_DECISION_TIMEOUT_ATTEMPTS = 3;

/** Durable decision for one rule and its resolved parts. */
export interface EvaluationDecision {
  /** Evaluation being decided. */
  readonly id: string;
  /** Evaluation state following the decision, before invoking effects. */
  readonly state: EvaluationState;
  /** Why the decision could not produce effects. */
  readonly reason?: string;
  /** Condition failure path, if one occurred. */
  readonly conditionPath?: string;
  /** Fully resolved effect inputs. */
  readonly parts?: readonly PreparedPart[];
}

type DecidedGroup = { group: StoredDecisionGroup; decisions: EvaluationDecision[] };

/** Evaluate all groups without opening a database transaction.
 * @param service - Active contribution directory.
 * @param cause - Pinned occasion and groups.
 * @param rules - Pinned member evaluations.
 * @param deadline - Absolute deadline for this decision attempt in epoch milliseconds.
 * @returns Proposed decisions, ready for a conditional commit.
 */
export async function decideGroups(
  service: RuleContributionsService,
  cause: RuleCauseRow,
  rules: readonly RuleEvaluationRow[],
  deadline: number,
) {
  const members = new Map(rules.map((rule) => [rule.ruleId, rule]));
  const groups: StoredDecisionGroup[] = [];
  const decisions: EvaluationDecision[] = [];
  for (const group of cause.groups) {
    if (group.state === 'decided' || Date.now() >= deadline) {
      groups.push(group);
      continue;
    }
    const decided = await decideGroup(service, group, members, deadline).catch((error: unknown) =>
      failedGroup(group, members, error),
    );
    groups.push(decided.group);
    decisions.push(...decided.decisions);
  }
  return { groups, decisions };
}

/** @param group - The group being decided.
 * @param members - Rows pinned for this occasion.
 * @param error - Failure at a contribution boundary.
 * @returns A failed decision or a pending group eligible for retry.
 */
function failedGroup(
  group: StoredDecisionGroup,
  members: ReadonlyMap<RuleId, RuleEvaluationRow>,
  error: unknown,
): DecidedGroup {
  const reason = error instanceof DecisionFailure ? error.reason : 'strategy-failed';
  const timeoutAttempts = (group.timeoutAttempts ?? 0) + Number(reason === 'decision-timeout');
  if (
    reason === 'contribution-unavailable' ||
    (reason === 'decision-timeout' && timeoutAttempts < MAX_DECISION_TIMEOUT_ATTEMPTS)
  ) {
    return { group: { ...group, reason, timeoutAttempts }, decisions: [] };
  }
  return {
    group: { ...group, state: 'decided', reason, timeoutAttempts },
    decisions: group.members.map(({ ruleId }) => ({ id: requireMember(members, ruleId).id, state: 'failed', reason })),
  };
}

/** @param members - Rows pinned for this occasion.
 * @param id - Rule named in a persisted group.
 * @returns Its pinned row.
 */
function requireMember(members: ReadonlyMap<RuleId, RuleEvaluationRow>, id: RuleId): RuleEvaluationRow {
  const member = members.get(id);
  if (!member) throw new Error('Decided member is missing');
  return member;
}

/** @param decision - Strategy output.
 * @param recorded - Results actually observed by the strategy.
 * @param members - Declared ordered group members.
 * @returns Whether the decision exhaustively and faithfully classifies the members.
 */
function validDecision(
  decision: GroupDecision,
  recorded: ReadonlyMap<RuleId, MemberDecision>,
  members: StoredDecisionGroup['members'],
): boolean {
  if (!Array.isArray(decision?.acting) || !Array.isArray(decision.stopped) || !Array.isArray(decision.notMatched))
    return false;
  const classified = [...decision.acting, ...decision.notMatched];
  return (
    decision.stopped.length === 0 &&
    new Set(classified).size === members.length &&
    classified.length === members.length &&
    members.every(({ ruleId }) => classified.includes(ruleId)) &&
    decision.acting.every((id) => recorded.get(id)?.state === 'matched') &&
    decision.notMatched.every((id) => recorded.has(id) && recorded.get(id)?.state !== 'matched')
  );
}

/** @param service - Active contribution directory.
 * @param group - Pinned group and its members.
 * @param members - Pinned rule lookup.
 * @param deadline - Shared deadline for strategy and lookup calls in epoch milliseconds.
 * @returns Shape-checked group and member decisions.
 */
async function decideGroup(
  service: RuleContributionsService,
  group: StoredDecisionGroup,
  members: ReadonlyMap<RuleId, RuleEvaluationRow>,
  deadline: number,
): Promise<DecidedGroup> {
  const strategy = service.strategy(group.strategy);
  if (!strategy) throw new DecisionFailure('contribution-unavailable');
  const calls = new Map<RuleId, Promise<MemberDecision>>();
  const recorded = new Map<RuleId, MemberDecision>();
  const order = group.members.map(({ ruleId, priority }) => ({ ruleId, priority: priority ?? 0 }));
  let unknownMember = false;
  const decision = await runStrategy(async (window) => {
    const proposed = await strategy.decide(order, async (id) => {
      const member = members.get(id);
      if (!member || !order.some(({ ruleId }) => ruleId === id)) {
        unknownMember = true;
        return { matched: false };
      }
      window.signal.throwIfAborted();
      let work = calls.get(id);
      if (!work) {
        work = decideMember(service, member.snapshot, window).catch((error: unknown): MemberDecision => {
          if (error instanceof DecisionFailure) throw error;
          return { state: 'failed', reason: 'condition-error' };
        });
        calls.set(id, work);
      }
      const result = await work;
      recorded.set(id, result);
      return { matched: result.state === 'matched' };
    });
    if (unknownMember || !validDecision(proposed, recorded, group.members)) {
      throw new DecisionFailure('strategy-invalid');
    }
    return proposed;
  }, deadline);

  const decisions = await beforeDeadline(
    Promise.all(
      group.members.map(async ({ ruleId }) => {
        const member = requireMember(members, ruleId);
        const result = recorded.get(ruleId);
        if (!result) throw new Error('Decided member has no observed result');
        return materialize(service, member, result);
      }),
    ),
    deadline,
  );
  return {
    group: {
      ...group,
      state: 'decided',
      reason: undefined,
      timeoutAttempts: undefined,
      acting: [...decision.acting],
      notMatched: [...decision.notMatched],
    },
    decisions,
  };
}

/** @param decide - Invokes the contributed strategy.
 * @param deadline - Absolute decision deadline in epoch milliseconds.
 * @returns The proposed group decision.
 */
async function runStrategy(
  decide: (deadline: DecisionDeadline) => Promise<GroupDecision>,
  deadline: number,
): Promise<GroupDecision> {
  const cancellation = new AbortController();
  try {
    return await beforeDeadline(decide({ at: deadline, signal: cancellation.signal }), deadline, cancellation);
  } catch (error) {
    if (error instanceof DecisionFailure) throw error;
    throw new DecisionFailure('strategy-failed');
  }
}

/** @param service - Active reaction directory.
 * @param member - Pinned rule.
 * @param result - Validated strategy observation.
 * @returns Effect inputs or a final member outcome.
 */
async function materialize(
  service: RuleContributionsService,
  member: RuleEvaluationRow,
  result: MemberDecision,
): Promise<EvaluationDecision> {
  if (result.state !== 'matched') return { id: member.id, ...result };
  const parts = await prepareParts(service, member.snapshot, result.facts).catch((error: unknown) => {
    if (error instanceof DecisionFailure) throw error;
    return { reason: 'params-invalid' };
  });
  if (!Array.isArray(parts)) return { id: member.id, state: 'failed', reason: parts.reason };
  const failed = parts.find((part) => part.reason);
  const state = parts.some((part) => !part.reason) ? 'pending' : failed ? 'failed' : 'accepted';
  return { id: member.id, state, reason: state === 'failed' ? failed?.reason : undefined, parts };
}
