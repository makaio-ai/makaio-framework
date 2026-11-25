import { defineReaction } from '@makaio/contracts';
import { allGroupStrategy, RuleEvaluator } from '@makaio/services-core';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { contributions, enqueue, occasion, read, ruleFor } from './rules-evaluation-support.js';

describeStorageConformance('independent rule groups', (config) => {
  const context = useSuiteDatabaseContext(config);

  it('settles a throwing reaction parameter schema without blocking a later group', async () => {
    const db = createHostDatabase(context().db);
    const invoked: string[] = [];
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Validate notification parameters before recording the sender',
        parameterSchema: z.object({
          value: z.string().transform((value) => {
            if (value === 'invalid') throw new Error('Cannot transform the parameter');
            return value;
          }),
        }),
        keyed: false,
        async handler(_call, _parameters, { cause }) {
          invoked.push(cause.ruleId);
          return { state: 'accepted' };
        },
      }),
    );
    const groups = ['invalid', 'ready'].map((group) => ({ group, strategy: allGroupStrategy.strategy }));
    const input = occasion(
      groups.map(({ group }) =>
        ruleFor({ id: group, group, priority: 0, reaction: { kind: 'rule-suite.notify', params: { value: group } } }),
      ),
    );
    await enqueue(db, service, invoke, { ...input, snapshot: { ...input.snapshot, groups } });

    const evaluator = new RuleEvaluator(db, service, invoke, () => undefined);
    await evaluator.evaluate(input.id);
    const settled = await read(db, input.id);
    expect(settled.cause).toMatchObject({
      state: 'decided',
      revision: 1,
      notBefore: null,
      groups: [
        { group: 'invalid', state: 'decided' },
        { group: 'ready', state: 'decided' },
      ],
    });
    expect(settled.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'invalid', state: 'failed', reason: 'params-invalid' }),
        expect.objectContaining({ ruleId: 'ready', state: 'accepted' }),
      ]),
    );
    expect(settled.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'failed', code: 'params-invalid', attempt: 0 }),
        expect.objectContaining({ state: 'accepted', attempt: 1 }),
      ]),
    );
    await evaluator.evaluate(input.id);
    expect(await read(db, input.id)).toEqual(settled);
    expect(invoked).toEqual(['ready']);
  });

  it('dispatches each group once even while another group awaits a contribution', async () => {
    const db = createHostDatabase(context().db);
    const invoked: string[] = [];
    const { service, invoke } = contributions(
      defineReaction({
        kind: 'rule-suite.notify',
        description: 'Record the rule that sent a notification',
        parameterSchema: z.object({}),
        keyed: false,
        async handler(_call, _parameters, { cause }) {
          invoked.push(cause.ruleId);
          return { state: 'accepted' };
        },
      }),
    );
    const input = occasion([
      ruleFor({ id: 'ready', group: 'ready', priority: 0 }),
      ruleFor({
        id: 'delayed',
        group: 'delayed',
        priority: 0,
        lookups: [{ lookup: 'rule-suite.delayed', name: 'answer', args: {} }],
      }),
    ]);
    const groups = ['ready', 'delayed'].map((group) => ({ group, strategy: allGroupStrategy.strategy }));
    await enqueue(db, service, invoke, { ...input, snapshot: { ...input.snapshot, groups } });

    const evaluator = new RuleEvaluator(db, service, invoke, () => undefined);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      for (const revision of [1, 2]) {
        await evaluator.evaluate(input.id);
        await evaluator.evaluate(input.id);
        expect(invoked).toEqual(['ready']);
        const { cause, parts } = await read(db, input.id);
        expect(cause).toMatchObject({ state: 'pending', revision, reason: 'contribution-unavailable' });
        expect(parts).toMatchObject([{ state: 'accepted', attempt: 1 }]);
        if (cause?.notBefore == null) throw new Error('Pending decision did not schedule a retry');
        expect(cause.notBefore).toBeGreaterThan(Date.now());
        clock.mockReturnValue(cause.notBefore);
      }

      service.lookups.register('rule-suite', [
        {
          kind: 'rule-suite.delayed',
          description: 'Supply the formerly unavailable answer',
          args: z.object({}),
          answer: () => ({ type: 'boolean' }),
          resolve: async () => true,
        },
      ]);
      await evaluator.evaluate(input.id);
      await evaluator.evaluate(input.id);
      expect(invoked).toEqual(['ready', 'delayed']);
      const { cause, parts } = await read(db, input.id);
      expect(cause).toMatchObject({ state: 'decided', revision: 3, notBefore: null, reason: null });
      expect(parts).toMatchObject([
        { state: 'accepted', attempt: 1 },
        { state: 'accepted', attempt: 1 },
      ]);
    } finally {
      clock.mockRestore();
    }
  });
});
