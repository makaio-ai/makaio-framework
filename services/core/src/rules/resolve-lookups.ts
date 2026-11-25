import { JsonRecordSchema, type Condition, type JsonValue } from '@makaio/contracts';
import type { EventFacts, LookupCall, LookupContribution } from '@makaio/contracts/rules';
import { defineOwnValue } from '@makaio/contracts/shared';
import type { CallContext } from '@makaio/core';
import type { RuleContributionsService } from '../rule-contributions/rule-contributions-service.js';
import { DecisionFailure } from './decision-failure.js';
import { bindLookupWhere, filterLookupAnswer, lookupPushdown, type WhereResult } from './lookup-where.js';
import { resolveParameters } from './parameter-tree.js';

/** Facts visible to conditions and argument expansion. */
export interface RuleFacts {
  /** Pinned trigger facts and authority. */
  readonly $event: EventFacts;
  /** Lookup answers obtained in declaration order. */
  readonly $lookup: Record<string, JsonValue>;
}

/** Shared deadline for the strategy and every lookup it starts. */
export interface DecisionDeadline {
  /** Deadline in epoch milliseconds. */
  readonly at: number;
  /** Cancels active reads if the decision window closes. */
  readonly signal: AbortSignal;
}

/** Condition error while completing an expression-bearing lookup filter. */
export class LookupConditionError extends Error {
  /** @param path - Location of the failed expression in the declaring rule.
   * @param message - Parser or evaluation error.
   */
  public constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/** Await read-only work by its deadline without holding a transaction.
 * @param work - In-flight contribution.
 * @param deadline - Deadline in epoch milliseconds.
 * @param cancellation - Cancels any reads still in flight when the work fails or times out.
 * @returns The contribution's result.
 */
export async function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number,
  cancellation?: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DecisionFailure('decision-timeout')), Math.max(0, deadline - Date.now()));
    });
    return await Promise.race([work, timeout]);
  } catch (error) {
    cancellation?.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve lookup arguments in the order they were declared.
 * @param service - Active lookup directory.
 * @param lookups - Calls in their evaluation order.
 * @param facts - Current facts, including the answer accumulator.
 * @param call - Witnessed evaluation authority.
 * @param deadline - Decision deadline with cancellation for active lookups.
 * @returns Whether every lookup supplied an answer.
 */
export async function resolveLookups(
  service: RuleContributionsService,
  lookups: readonly LookupCall[],
  facts: RuleFacts,
  call: CallContext,
  deadline: DecisionDeadline,
): Promise<boolean> {
  for (const [index, lookupCall] of lookups.entries()) {
    const lookup = service.lookup(lookupCall.lookup);
    if (!lookup) throw new DecisionFailure('contribution-unavailable');
    const value = await resolveLookup(lookup, lookupCall, facts, call, deadline, index);
    if (value === null) return false;
    defineOwnValue(facts.$lookup, lookupCall.name, value);
  }
  return true;
}

/** @param lookup - Active contribution.
 * @param input - Lookup's declaring rule fields.
 * @param facts - Facts available before the lookup.
 * @param call - Witnessed evaluation authority.
 * @param deadline - Decision deadline with cancellation for active lookups.
 * @param index - Position of the lookup in the rule.
 * @returns JSON answer or null when a value is missing.
 */
async function resolveLookup(
  lookup: LookupContribution,
  input: LookupCall,
  facts: RuleFacts,
  call: CallContext,
  deadline: DecisionDeadline,
  index: number,
): Promise<JsonValue | null> {
  const args = resolveParameters(input.args, facts, 'record');
  if (args === undefined) return null;
  const record = JsonRecordSchema.safeParse(args);
  if (!record.success) throw new DecisionFailure('lookup-args-invalid');
  const resolvedArgs = await parseLookupArgs(lookup, record.data);
  const where = input.where && bindLookupWhere(input.where, (operand) => resolveParameters(operand, facts));
  if (input.where && !where) return null;
  const pushdown = where && lookupPushdown(where);
  const answer = await callLookup(lookup, call, resolvedArgs, pushdown?.condition, deadline);
  deadline.signal.throwIfAborted();
  if (answer === null || (!where && !lookup.where)) return answer;
  if (!Array.isArray(answer)) throw new DecisionFailure('lookup-answer-invalid');
  if (!where || !pushdown?.inMemory) return answer;
  return requireWhereResult(filterLookupAnswer(where, answer), index);
}

/** @param lookup - Active contribution to invoke.
 * @param call - Witnessed evaluation authority.
 * @param args - Schema-checked lookup arguments.
 * @param where - Filter to apply at the contribution boundary.
 * @param deadline - Shared decision deadline.
 * @returns Lookup answer or the missing-value sentinel.
 */
async function callLookup(
  lookup: LookupContribution,
  call: CallContext,
  args: Record<string, JsonValue>,
  where: Condition | undefined,
  deadline: DecisionDeadline,
): Promise<JsonValue | null> {
  deadline.signal.throwIfAborted();
  if (Date.now() >= deadline.at) throw new DecisionFailure('decision-timeout');
  try {
    return await lookup.resolve(call, args, where, new Date(deadline.at).toISOString(), deadline.signal);
  } catch {
    deadline.signal.throwIfAborted();
    throw new DecisionFailure('contribution-unavailable');
  }
}

/** @param lookup - Contribution describing the argument contract.
 * @param args - Arguments expanded from rule facts.
 * @returns Schema-checked JSON arguments.
 */
async function parseLookupArgs(lookup: LookupContribution, args: Record<string, JsonValue>) {
  try {
    return JsonRecordSchema.parse(await lookup.args.parseAsync(args));
  } catch {
    throw new DecisionFailure('lookup-args-invalid');
  }
}

/** @param result - Filtered response or condition error.
 * @param index - Lookup position.
 * @returns Filtered values.
 */
function requireWhereResult(result: WhereResult, index: number): JsonValue[] {
  if ('error' in result) {
    const path = result.error.path ? '.' + result.error.path : '';
    throw new LookupConditionError('lookups[' + index + '].where' + path, result.error.message);
  }
  return result.values;
}
