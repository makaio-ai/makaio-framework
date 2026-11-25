import type { HostTransaction } from '@makaio/contracts';
import { getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import type { PreparedOccasion } from '../types.js';
import { ruleStorageSchema } from './schema.variants.js';

/** Store a prepared occasion and its evaluations in the caller's transaction.
 * @param tx - Transaction shared with the incoming reader commitment.
 * @param input - Pinned occasion and matched members.
 * @returns Whether this occasion was inserted.
 */
export async function storeRuleOccasion(tx: HostTransaction, input: PreparedOccasion): Promise<boolean> {
  const query = getTransactionQueryContext(tx);
  const tables = resolveSchema(query, ruleStorageSchema);
  const { occasion, rules, blockedRules, groups, blockedReason: reason } = input;
  const inserted = await query
    .insert(tables.ruleCauses)
    .values({
      id: occasion.id,
      snapshot: { id: occasion.id, event: occasion.event, snapshot: occasion.snapshot },
      groups: reason ? groups.map((group) => ({ ...group, reason })) : groups,
      state: groups.length || reason ? 'pending' : 'decided',
      reason,
    })
    .onConflictDoNothing({ target: tables.ruleCauses.id })
    .returning({ id: tables.ruleCauses.id });
  if (inserted.length === 0) return false;
  const updatedAt = Date.now();
  const evaluations = [
    ...rules.map((snapshot) => ({
      id: crypto.randomUUID(),
      causeId: occasion.id,
      ruleId: snapshot.rule.id,
      snapshot,
      state: 'pending' as const,
      reason,
      updatedAt,
    })),
    ...blockedRules.map((snapshot) => ({
      id: crypto.randomUUID(),
      causeId: occasion.id,
      ruleId: snapshot.ruleId,
      snapshot,
      state: 'failed' as const,
      reason: snapshot.reason,
      updatedAt,
    })),
  ];
  if (evaluations.length) await query.insert(tables.ruleEvaluations).values(evaluations);
  return true;
}
