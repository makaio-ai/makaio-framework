import { eq, and, isNull, lte, or } from 'drizzle-orm';
import type { HostDatabase } from '@makaio/contracts';
import { getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import type { decideGroups, EvaluationDecision } from '../decide-groups.js';
import { ruleStorageSchema } from './schema.variants.js';
import type { RuleCauseRow, RuleEvaluationRow } from './schema.js';

/** Delay the next attempt exponentially from one second to five minutes.
 * @param attempts - Attempts already made.
 * @returns Delay in milliseconds.
 */
export function retryDelay(attempts: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

/** Read an occasion and its evaluations in a short database transaction.
 * @param database - Evaluation database.
 * @param id - Stable occasion identifier.
 * @returns The pinned rows when the occasion exists.
 */
export function loadOccasion(database: HostDatabase, id: string) {
  return database.transaction(async (tx) => {
    const query = getTransactionQueryContext(tx);
    const { ruleCauses, ruleEvaluations } = resolveSchema(query, ruleStorageSchema);
    const [cause] = await query.select().from(ruleCauses).where(eq(ruleCauses.id, id));
    if (!cause) return undefined;
    const rules = await query.select().from(ruleEvaluations).where(eq(ruleEvaluations.causeId, id));
    const executable = rules.flatMap((row): RuleEvaluationRow[] => {
      const { ruleId, snapshot } = row;
      return ruleId !== null && 'rule' in snapshot ? [{ ...row, ruleId, snapshot }] : [];
    });
    return { cause, rules: executable };
  });
}

/** Conditionally reserve the pending decision for one runner.
 * @param database - Evaluation database.
 * @param cause - Occasion version observed by the caller.
 * @param now - Current time.
 * @param deadline - Time after which another runner may recover the read-only work.
 * @returns The version owned by this runner, when it was able to claim the occasion.
 */
export function claimDecision(database: HostDatabase, cause: RuleCauseRow, now: number, deadline: number) {
  return database.transaction(async (tx) => {
    const query = getTransactionQueryContext(tx);
    const { ruleCauses } = resolveSchema(query, ruleStorageSchema);
    const [claimed] = await query
      .update(ruleCauses)
      .set({ revision: cause.revision + 1, notBefore: deadline })
      .where(
        and(
          eq(ruleCauses.id, cause.id),
          eq(ruleCauses.revision, cause.revision),
          eq(ruleCauses.state, 'pending'),
          or(isNull(ruleCauses.notBefore), lte(ruleCauses.notBefore, now)),
        ),
      )
      .returning();
    return claimed;
  });
}

/** Commit a group's decisions and all resolved effect inputs before invoking any reaction.
 * @param database - Evaluation database.
 * @param cause - Previously read occasion, used to fence concurrent decision commits.
 * @param rules - Pinned member evaluations.
 * @param proposal - Groups and members evaluated outside the transaction.
 * @returns Completion of the fenced commit attempt.
 */
export function persistDecisions(
  database: HostDatabase,
  cause: RuleCauseRow,
  rules: readonly RuleEvaluationRow[],
  proposal: Awaited<ReturnType<typeof decideGroups>>,
): Promise<void> {
  return database.transaction(async (tx) => {
    const query = getTransactionQueryContext(tx);
    const { ruleCauses, ruleEvaluations, ruleEvaluationParts } = resolveSchema(query, ruleStorageSchema);
    const pending = proposal.groups.find((group) => group.state === 'pending');
    const reason = pending ? pending.reason : proposal.groups.find((group) => group.reason)?.reason;
    const now = Date.now();
    const updated = await query
      .update(ruleCauses)
      .set({
        groups: proposal.groups,
        state: pending ? 'pending' : 'decided',
        reason: reason ?? null,
        notBefore: pending ? now + retryDelay(cause.revision) : null,
      })
      .where(and(eq(ruleCauses.id, cause.id), eq(ruleCauses.revision, cause.revision), eq(ruleCauses.state, 'pending')))
      .returning({ id: ruleCauses.id });
    if (updated.length === 0) return;
    for (const decision of proposal.decisions) {
      const rule = rules.find(({ id }) => id === decision.id);
      if (!rule) throw new Error('Decided rule was not part of this occasion');
      const parts = materializeRows(cause, rule, decision);
      await query
        .update(ruleEvaluations)
        .set({
          state: decision.state,
          reason: decision.reason,
          conditionPath: decision.conditionPath,
          updatedAt: now,
        })
        .where(eq(ruleEvaluations.id, rule.id));
      if (parts.length > 0) await query.insert(ruleEvaluationParts).values(parts);
    }
  });
}

/** @param cause - Pinned occasion.
 * @param rule - Pinned rule.
 * @param decision - Effects chosen by the validated group strategy.
 * @returns Part rows whose keys are stable across retries and restart.
 */
function materializeRows(cause: RuleCauseRow, rule: RuleEvaluationRow, decision: EvaluationDecision) {
  return (decision.parts ?? []).map((part) => ({
    ...part,
    key: JSON.stringify([rule.ruleId, cause.id, part.position]),
    reaction: rule.snapshot.rule.reaction.kind,
    evaluationId: rule.id,
    state: part.reason ? ('failed' as const) : ('pending' as const),
    code: part.reason,
  }));
}
