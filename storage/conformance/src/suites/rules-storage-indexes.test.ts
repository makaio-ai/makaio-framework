import { defineReaction } from '@makaio/contracts';
import { RuleEvaluator } from '@makaio/services-core';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { contributions, enqueue, occasion, read, ruleFor } from './rules-evaluation-support.js';

describeStorageConformance('rule storage indexes', (config) => {
  // A small fixture otherwise favors a sequential scan in Postgres even with a usable index.
  const context = useSuiteDatabaseContext(config, { postgresSettings: { enable_seqscan: 'off' } });

  it('uses indexes for the evaluator’s occasion and part reads', async () => {
    const { db, executor, dialect } = context();
    const database = createHostDatabase(db);
    const input = occasion([ruleFor()]);
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Produce a persisted outcome',
        parameterSchema: z.object({}),
        keyed: false,
        async handler() {
          return { state: 'accepted' };
        },
      }),
    );
    await expect(enqueue(database, service, invoke, input)).resolves.toBe(true);
    await new RuleEvaluator(database, service, invoke, () => undefined).evaluate(input.id);
    const { rules } = await read(database, input.id);
    const [rule] = rules;
    if (!rule) throw new Error('Expected a persisted rule evaluation');
    expect(rule.state).toBe('accepted');

    const explain = dialect === 'postgres' ? sql`EXPLAIN` : sql`EXPLAIN QUERY PLAN`;
    const reads = [
      {
        query: sql`SELECT * FROM rule_evaluations WHERE cause_id = ${input.id}`,
        index: 'rule_evaluations_cause_idx',
      },
      {
        query: sql`SELECT * FROM rule_evaluation_parts
                   WHERE evaluation_id = ${rule.id} AND state = 'pending' ORDER BY position`,
        index: 'rule_evaluation_parts_order_idx',
      },
      {
        query: sql`SELECT state FROM rule_evaluation_parts WHERE evaluation_id = ${rule.id}`,
        index: 'rule_evaluation_parts_order_idx',
      },
    ];
    for (const { query, index } of reads) {
      expect.soft(JSON.stringify(await executor.all(sql`${explain} ${query}`))).toContain(index);
    }
  });
});
