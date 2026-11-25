import type { HostDatabase } from '@makaio/contracts';
import { getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { journalStorageSchema } from '../../journal/storage/schema.variants.js';
import { retryDelay } from './decision-store.js';
import { ruleStorageSchema } from './schema.variants.js';

/**
 * Find the earliest outstanding decision or effect deadline. Only the oldest
 * outstanding occasion of each recorded order key is eligible.
 * @param database - Host database holding the occasions and their journal entries.
 * @returns The next occasion and its due time, or undefined when idle.
 */
export function nextRuleWork(database: HostDatabase): Promise<{ id: string; due: number } | undefined> {
  return database.transaction(async (tx) => {
    const q = getTransactionQueryContext(tx);
    const {
      ruleCauses: causes,
      ruleEvaluations: rules,
      ruleEvaluationParts: parts,
    } = resolveSchema(q, ruleStorageSchema);
    const { journalEntries: entries } = resolveSchema(q, journalStorageSchema);
    const work = q
      .select({
        id: causes.id,
        // Keep unsupported work in its order partition without scheduling an evaluation for it.
        due: sql`case when ${causes.reason} = 'not-implemented' then null else coalesce(${causes.notBefore}, 0) end`.as(
          'due',
        ),
      })
      .from(causes)
      .where(eq(causes.state, 'pending'))
      .unionAll(
        q
          .select({
            id: rules.causeId,
            due: sql`case when ${parts.notBefore} > coalesce(${parts.callDeadline}, 0)
              then ${parts.notBefore} else coalesce(${parts.callDeadline}, 0) end`,
          })
          .from(parts)
          .innerJoin(rules, eq(parts.evaluationId, rules.id))
          .where(eq(parts.state, 'pending')),
      )
      .as('rule_work');
    const ordered = q
      .select({
        id: work.id,
        due: sql<number>`min(${work.due})`.mapWith(Number).as('next_due'),
        rank: sql`row_number() over (
            partition by ${entries.orderKey}, case when ${entries.orderKey} is null then ${work.id} end
            order by ${entries.position}
          )`.as('order_rank'),
      })
      .from(work)
      .leftJoin(entries, eq(work.id, entries.entryId))
      .groupBy(work.id, entries.orderKey, entries.position)
      .as('ordered_rule_work');
    const [next] = await q
      .select({ id: ordered.id, due: ordered.due })
      .from(ordered)
      .where(and(sql`${ordered.rank} = 1`, isNotNull(ordered.due)))
      .orderBy(sql`${ordered.due}, ${ordered.id}`)
      .limit(1);
    return next;
  });
}

/**
 * Back off an occasion that threw without advancing its due work. Keep
 * existing future deadlines and start markers intact for concurrent runners.
 * @param database - Host database holding the selected work.
 * @param id - Occasion that could not be evaluated.
 * @param now - Time at which the runner observed the error.
 * @returns Completion of the retry schedule update.
 */
export function deferFailedRuleWork(database: HostDatabase, id: string, now: number): Promise<void> {
  return database.transaction(async (tx) => {
    const q = getTransactionQueryContext(tx);
    const {
      ruleCauses: causes,
      ruleEvaluations: rules,
      ruleEvaluationParts: parts,
    } = resolveSchema(q, ruleStorageSchema);
    const notBefore = now + retryDelay(1);
    await q
      .update(causes)
      .set({ notBefore })
      .where(
        and(eq(causes.id, id), eq(causes.state, 'pending'), or(isNull(causes.notBefore), lte(causes.notBefore, now))),
      );
    await q
      .update(parts)
      .set({ notBefore })
      .where(
        and(
          inArray(parts.evaluationId, q.select({ id: rules.id }).from(rules).where(eq(rules.causeId, id))),
          eq(parts.state, 'pending'),
          or(isNull(parts.notBefore), lte(parts.notBefore, now)),
          or(isNull(parts.callDeadline), lte(parts.callDeadline, now)),
        ),
      );
  });
}
