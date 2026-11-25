import { and, asc, eq, isNull } from 'drizzle-orm';
import type { HostDatabase, ReactionOutcome } from '@makaio/contracts';
import { getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { retryDelay } from './decision-store.js';
import { ruleStorageSchema } from './schema.variants.js';
import type { RulePartRow } from './schema.js';

/** Read the outstanding effect inputs in item order.
 * @param database - Evaluation database.
 * @param evaluationId - Pinned rule evaluation.
 * @returns Current pending parts, including future retries.
 */
export function loadParts(database: HostDatabase, evaluationId: string): Promise<RulePartRow[]> {
  return database.transaction(async (tx) => {
    const query = getTransactionQueryContext(tx);
    const { ruleEvaluationParts: parts } = resolveSchema(query, ruleStorageSchema);
    return query
      .select()
      .from(parts)
      .where(and(eq(parts.evaluationId, evaluationId), eq(parts.state, 'pending')))
      .orderBy(asc(parts.position));
  });
}

/** Commit an attempt's start marker atomically before its handler can run.
 * @param database - Evaluation database.
 * @param part - Part version read by this runner.
 * @param now - Time of the proposed start.
 * @param deadline - Deadline for recognizing an uncertain call.
 * @returns The newly started attempt, if this runner won it.
 */
export function startPart(database: HostDatabase, part: RulePartRow, now: number, deadline: number) {
  return database.transaction(async (tx) => {
    const query = getTransactionQueryContext(tx);
    const { ruleEvaluationParts: parts } = resolveSchema(query, ruleStorageSchema);
    const [started] = await query
      .update(parts)
      .set({
        attempt: part.attempt + 1,
        callStartedAt: now,
        callDeadline: deadline,
        notBefore: null,
      })
      .where(
        and(
          eq(parts.key, part.key),
          eq(parts.attempt, part.attempt),
          eq(parts.state, 'pending'),
          isNull(parts.callDeadline),
        ),
      )
      .returning();
    return started;
  });
}

/** Record an outcome or its retry schedule, fencing stale responses from earlier attempts.
 * @param database - Evaluation database.
 * @param part - Attempt that produced the outcome.
 * @param outcome - Reaction response, or recovery's uncertain result.
 * @param now - Time the outcome was recorded.
 * @returns Completion of the outcome transaction.
 */
export function finishPart(
  database: HostDatabase,
  part: RulePartRow,
  outcome: ReactionOutcome,
  now: number,
): Promise<void> {
  return database.transaction(async (tx) => {
    const query = getTransactionQueryContext(tx);
    const { ruleEvaluationParts: parts, ruleEvaluations: rules } = resolveSchema(query, ruleStorageSchema);
    // Lock the parent first, serializing aggregation even when distinct parts settle concurrently.
    await query.update(rules).set({ updatedAt: now }).where(eq(rules.id, part.evaluationId));
    const updated = await query
      .update(parts)
      .set({
        ...outcomeValues(outcome, now, part.attempt),
        callDeadline: null,
      })
      .where(
        and(
          eq(parts.key, part.key),
          eq(parts.attempt, part.attempt),
          eq(parts.state, 'pending'),
          part.callDeadline === null ? isNull(parts.callDeadline) : eq(parts.callDeadline, part.callDeadline),
        ),
      )
      .returning({ key: parts.key });
    if (updated.length === 0) return;
    const states = await query
      .select({ state: parts.state })
      .from(parts)
      .where(eq(parts.evaluationId, part.evaluationId));
    const state = (['pending', 'failed', 'rejected', 'accepted'] as const).find((candidate) =>
      states.some((entry) => entry.state === candidate),
    );
    if (state !== 'pending' && state !== undefined) {
      await query.update(rules).set({ state, updatedAt: now }).where(eq(rules.id, part.evaluationId));
    }
  });
}

/** @param outcome - Handler or recovery outcome.
 * @param now - Recording time.
 * @param attempt - Attempt count.
 * @returns Fields updated for a completed attempt.
 */
function outcomeValues(outcome: ReactionOutcome, now: number, attempt: number) {
  switch (outcome.state) {
    case 'accepted':
      return {
        state: outcome.state,
        result: outcome.result === undefined ? null : { value: outcome.result },
        reason: null,
        code: null,
        notBefore: null,
      };
    case 'failed':
    case 'rejected':
      return { state: outcome.state, result: null, reason: outcome.reason, code: outcome.code, notBefore: null };
    case 'retry':
      return {
        state: 'pending' as const,
        result: null,
        reason: outcome.reason,
        code: null,
        notBefore: now + retryDelay(attempt),
      };
  }
}
