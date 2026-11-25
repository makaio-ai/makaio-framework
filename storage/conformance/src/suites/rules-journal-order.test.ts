import { defineReaction, type HostDatabase } from '@makaio/contracts';
import { RuleEvaluator, startRuleJournalEvaluation, type RuleOccasion } from '@makaio/services-core';
import { createHostDatabase, getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { appendEntries } from '../../../../services/core/src/journal/storage/append-entries.js';
import { loadOccasion, persistDecisions } from '../../../../services/core/src/rules/storage/decision-store.js';
import { nextRuleWork } from '../../../../services/core/src/rules/storage/next-rule-work.js';
import { ruleStorageSchema } from '../../../../services/core/src/rules/storage/schema.variants.js';
import type { SiblingClient } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { contributions, enqueue, occasion, read, ruleFor, subject } from './rules-evaluation-support.js';

/** @param db - Host journal database.
 * @param inputs - Occasions to record; the first two share an order key.
 * @returns Committed entries in journal order.
 */
function recordOrderedWork(db: HostDatabase, inputs: readonly RuleOccasion[]) {
  return db.transaction((tx) =>
    appendEntries(getTransactionQueryContext(tx), {
      tx,
      extension: 'rule-suite',
      subjects: {
        resolve: () => ({ recorded: true, owner: 'rule-suite', schemaVersion: '1', payloadSchema: z.unknown() }),
      },
      entries: inputs.map(({ id: key, event: { origin }, payload }, index) => ({
        key,
        subject,
        origin,
        payload,
        orderKey: index < 2 ? 'ordered' : 'independent',
      })),
    }),
  );
}

describeStorageConformance('rule journal ordering', (config) => {
  const context = useSuiteDatabaseContext(config);

  it('blocks later work of the same order key until an unsupported occasion is terminal', async () => {
    const db = createHostDatabase(context().db);
    const unsupported = occasion([
      ruleFor({ group: 'alerts', priority: 10 }),
      ruleFor({ id: 'fallback', group: 'alerts', priority: 0 }),
    ]);
    const later = occasion([ruleFor()]);
    const independent = occasion([ruleFor()]);
    const inputs: RuleOccasion[] = [
      {
        ...unsupported,
        snapshot: { ...unsupported.snapshot, groups: [{ group: 'alerts', strategy: 'makaio.all' }] },
      },
      later,
      independent,
    ];
    const recorded = await recordOrderedWork(db, inputs);
    const received: string[] = [];
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Record effects in the order they ran',
        parameterSchema: z.object({}),
        keyed: true,
        async handler(_call, _parameters, { cause }) {
          if ('entryId' in cause.event.cause) received.push(cause.event.cause.entryId);
          return { state: 'accepted' };
        },
      }),
    );
    for (const [index, { row }] of recorded.entries()) {
      const input = inputs[index]!;
      const { entryId, position, origin } = row;
      await enqueue(db, service, invoke, {
        ...input,
        id: entryId,
        event: { ...input.event, origin, cause: { entryId, position } },
      });
    }
    const [first, second, third] = recorded.map(({ row }) => row.entryId);
    if (!first || !second || !third) throw new Error('The fixture did not record all entries.');
    const evaluator = new RuleEvaluator(db, service, invoke, () => undefined);
    expect((await read(db, first)).cause).toMatchObject({ state: 'pending', reason: 'not-implemented' });
    expect(await nextRuleWork(db)).toEqual({ id: third, due: 0 });
    await evaluator.evaluate(third);
    expect(await nextRuleWork(db)).toBeUndefined();
    expect(received).toEqual([third]);
    expect((await read(db, second)).cause?.state).toBe('pending');

    // Book a terminal resolution through the same store used by the evaluator.
    const loaded = await loadOccasion(db, first);
    if (!loaded) throw new Error('The pending occasion was not stored.');
    await persistDecisions(db, loaded.cause, loaded.rules, {
      groups: loaded.cause.groups.map((group) => ({ ...group, state: 'decided' })),
      decisions: loaded.rules.map(({ id }) => ({ id, state: 'failed', reason: 'not-implemented' })),
    });
    expect(await nextRuleWork(db)).toEqual({ id: second, due: 0 });
    await evaluator.evaluate(second);
    expect(received).toEqual([third, second]);
    expect(await nextRuleWork(db)).toBeUndefined();
  });
});

describeStorageConformance('evaluation failure backoff', (config) => {
  const context = useSuiteDatabaseContext(config);

  it('defers a throwing occasion while a different order key proceeds', async () => {
    const db = createHostDatabase(context().db);
    const inputs = Array.from({ length: 3 }, () => occasion([ruleFor()]));
    const recorded = await recordOrderedWork(db, inputs);
    const { service, invoke } = contributions();
    const [first, second, third] = recorded.map(({ row }) => row.entryId);
    if (!first || !second || !third) throw new Error('The fixture did not record all entries.');
    for (const [
      index,
      {
        row: { entryId, position, origin },
      },
    ] of recorded.entries()) {
      const input = inputs[index]!;
      await enqueue(db, service, invoke, {
        ...input,
        id: entryId,
        event: { ...input.event, origin, cause: { entryId, position } },
      });
    }
    // Make the independent occasion due but sort it after the first one.
    await db.transaction(async (tx) => {
      const q = getTransactionQueryContext(tx);
      const { ruleCauses } = resolveSchema(q, ruleStorageSchema);
      await q.update(ruleCauses).set({ notBefore: 1 }).where(eq(ruleCauses.id, third));
    });
    const processed = Promise.withResolvers<string>();
    const evaluator = new RuleEvaluator(db, service, invoke, () => undefined);
    let failureAt = 0;
    const stop = startRuleJournalEvaluation(db, {
      async evaluate(id, signal) {
        if (id === first) {
          failureAt = Date.now();
          throw new Error('Evaluation failed before moving the deadline');
        }
        await evaluator.evaluate(id, signal);
        processed.resolve(id);
      },
    });
    try {
      expect(await processed.promise).toBe(third);
      expect(failureAt).toBeGreaterThan(0);
      expect((await read(db, first)).cause?.notBefore).toBeGreaterThan(failureAt);
      expect((await read(db, second)).cause).toMatchObject({ state: 'pending', revision: 0 });
    } finally {
      await stop();
    }
  });
});

describeStorageConformance('concurrent rule effects', (config) => {
  const context = useSuiteDatabaseContext(config);
  let peer: SiblingClient;

  beforeAll(async () => {
    peer = await context().createSiblingClient();
  });

  it('starts one unkeyed invocation per attempt with two active hosts', async () => {
    const db = createHostDatabase(context().db);
    const sibling = createHostDatabase(peer.db);
    const input = occasion([ruleFor()]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let starts = 0;
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Keep an unkeyed effect open while another host scans',
        parameterSchema: z.object({}),
        keyed: false,
        async handler() {
          starts += 1;
          entered.resolve();
          await release.promise;
          return { state: 'accepted' };
        },
      }),
    );
    await enqueue(db, service, invoke, input);
    const running = new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id);
    try {
      await Promise.race([entered.promise, running]);
      expect(starts).toBe(1);
      expect((await read(sibling, input.id)).parts[0]).toMatchObject({
        state: 'pending',
        attempt: 1,
        callStartedAt: expect.any(Number),
      });
      await new RuleEvaluator(sibling, service, invoke, () => undefined).evaluate(input.id);
      expect(starts).toBe(1);
    } finally {
      release.resolve();
      await running;
    }
    expect((await read(sibling, input.id)).parts[0]).toMatchObject({ state: 'accepted', attempt: 1 });
  });
});
