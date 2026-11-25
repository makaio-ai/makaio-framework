import type { JsonValue } from '@makaio/contracts';
import type { EvaluationState } from '@makaio/contracts/rules';
import { defineDualTable } from '@makaio/storage-drizzle';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { index as pgIndex, uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import type { StoredDecisionGroup } from '../decision-failure.js';
import type { BlockedRule, PinnedRuleOccasion, PreparedRule } from '../types.js';

/** One immutable occasion and the durable envelope of its decisions. */
export const ruleCausesDual = defineDualTable('rule_causes', (c) => ({
  id: c.text('id').primaryKey(),
  snapshot: c.jsonCol<Omit<PinnedRuleOccasion, 'payload'>>('rule_snapshot').notNull(),
  groups: c.jsonCol<readonly StoredDecisionGroup[]>('groups').notNull(),
  state: c.text('state').$type<'pending' | 'decided'>().notNull(),
  reason: c.text('reason'),
  revision: c.int4('revision').notNull().default(0),
  notBefore: c.epochMs('not_before'),
}));

/** @param reason - Evaluation reason column.
 * @returns Index predicate preserving unique rule IDs except for audited duplicate source entries.
 */
function uniqueRuleIdentity(reason: SQLWrapper) {
  return sql`coalesce(${reason}, '') <> 'duplicate-rule-id'`;
}

/** One pinned evaluation or one blocked entry in the occasion's source snapshot. */
export const ruleEvaluationsDual = defineDualTable(
  'rule_evaluations',
  (c) => ({
    id: c.text('id').primaryKey(),
    causeId: c
      .text('cause_id')
      .notNull()
      .references(() => ruleCausesDual.columnPair('id'), { onDelete: 'cascade' }),
    ruleId: c.text('rule_id'),
    snapshot: c.jsonCol<PreparedRule | BlockedRule>('rule_snapshot').notNull(),
    state: c.text('state').$type<EvaluationState>().notNull(),
    reason: c.text('reason'),
    conditionPath: c.text('condition_path'),
    updatedAt: c.epochMs('updated_at').notNull(),
  }),
  {
    sqlite: (t) => [
      index('rule_evaluations_cause_idx').on(t.causeId),
      uniqueIndex('rule_evaluations_cause_rule_uq').on(t.causeId, t.ruleId).where(uniqueRuleIdentity(t.reason)),
    ],
    postgres: (t) => [
      pgIndex('rule_evaluations_cause_idx').on(t.causeId),
      pgUniqueIndex('rule_evaluations_cause_rule_uq').on(t.causeId, t.ruleId).where(uniqueRuleIdentity(t.reason)),
    ],
  },
);

/** Stable reaction inputs and state of each individual effect. */
export const ruleEvaluationPartsDual = defineDualTable(
  'rule_evaluation_parts',
  (c) => ({
    key: c.text('key').primaryKey(),
    evaluationId: c
      .text('evaluation_id')
      .notNull()
      .references(() => ruleEvaluationsDual.columnPair('id'), { onDelete: 'cascade' }),
    position: c.int4('position').notNull(),
    reaction: c.text('reaction').notNull(),
    parameters: c.jsonCol<Record<string, JsonValue>>('parameters').notNull(),
    item: c.jsonCol<JsonValue>('item'),
    keyed: c.bool('keyed').notNull(),
    state: c.text('state').$type<'pending' | 'accepted' | 'rejected' | 'failed'>().notNull(),
    reason: c.text('reason'),
    result: c.jsonCol<{ value: JsonValue }>('result'),
    code: c.text('code'),
    attempt: c.int4('attempt').notNull().default(0),
    notBefore: c.epochMs('not_before'),
    callStartedAt: c.epochMs('call_started_at'),
    callDeadline: c.epochMs('call_deadline'),
  }),
  {
    sqlite: (t) => [index('rule_evaluation_parts_order_idx').on(t.evaluationId, t.position)],
    postgres: (t) => [pgIndex('rule_evaluation_parts_order_idx').on(t.evaluationId, t.position)],
  },
);

/** Canonical causes schema. */
export const ruleCauses = ruleCausesDual.sqlite;
/** Canonical evaluations schema. */
export const ruleEvaluations = ruleEvaluationsDual.sqlite;
/** Canonical parts schema. */
export const ruleEvaluationParts = ruleEvaluationPartsDual.sqlite;

/** Selected cause. */
export type RuleCauseRow = typeof ruleCauses.$inferSelect;
/** Selected executable rule evaluation, with its resolved identity and trigger projection. */
export type RuleEvaluationRow = typeof ruleEvaluations.$inferSelect & { ruleId: string; snapshot: PreparedRule };
/** Selected reaction part. */
export type RulePartRow = typeof ruleEvaluationParts.$inferSelect;
