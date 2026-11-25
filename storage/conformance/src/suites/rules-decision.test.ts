import type { LookupContribution } from '@makaio/contracts/rules';
import { allGroupStrategy, RuleEvaluator } from '@makaio/services-core';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { contributions, enqueue, occasion, read, ruleFor } from './rules-evaluation-support.js';

const lookupKind = 'rule-suite.find';
const lookupCall = {
  lookup: lookupKind,
  name: 'rows',
  args: { value: { ref: '$event.facts.payload.entries' } },
  where: { $expr: 'true' },
};

describeStorageConformance('rule decision failures', (config) => {
  const context = useSuiteDatabaseContext(config);

  it.each([
    ['lookup-args-invalid', z.object({ value: z.number() })],
    ['lookup-answer-invalid', z.object({ value: z.array(z.string()) })],
  ])('persists %s as a failed rule and never retries it', async (reason, args) => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = contributions();
    const resolve = vi.fn<LookupContribution['resolve']>().mockResolvedValue({ wrong: 'shape' });
    service.lookups.register('rule-suite', [
      {
        kind: lookupKind,
        description: 'Return an invalid answer',
        args,
        answer: () => ({ type: 'array' }),
        where: { roots: () => ({}) },
        resolve,
      },
    ]);
    const input = occasion([ruleFor({ lookups: [lookupCall] })]);
    await enqueue(db, service, invoke, input);
    const evaluator = new RuleEvaluator(db, service, invoke, () => undefined);
    await evaluator.evaluate(input.id);
    await evaluator.evaluate(input.id);
    expect(await read(db, input.id)).toMatchObject({
      cause: { state: 'decided', revision: 1, notBefore: null },
      rules: [{ state: 'failed', reason, snapshot: { rule: input.snapshot.rules[0] } }],
      parts: [],
    });
    expect(resolve).toHaveBeenCalledTimes(reason === 'lookup-args-invalid' ? 0 : 1);
  });

  it.each([
    { reason: 'strategy-failed', decide: vi.fn().mockRejectedValue(new Error('Cannot decide')) },
    {
      reason: 'strategy-invalid',
      decide: vi.fn().mockResolvedValue({ acting: ['unknown'], stopped: [], notMatched: [] }),
    },
  ])('persists $reason as a final decision', async ({ reason, decide }) => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = contributions();
    service.groupStrategies.register('makaio', [{ ...allGroupStrategy, decide }]);
    const input = occasion([ruleFor()]);
    await enqueue(db, service, invoke, input);
    const evaluator = new RuleEvaluator(db, service, invoke, () => undefined);
    await evaluator.evaluate(input.id);
    await evaluator.evaluate(input.id);
    expect(await read(db, input.id)).toMatchObject({
      cause: { state: 'decided', revision: 1, reason, notBefore: null, groups: [{ state: 'decided', reason }] },
      rules: [{ state: 'failed', reason, snapshot: { rule: input.snapshot.rules[0] } }],
      parts: [],
    });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('retries an unavailable contribution and clears the reason after it returns', async () => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = contributions();
    const input = occasion([ruleFor({ lookups: [lookupCall] })]);
    await enqueue(db, service, invoke, input);
    const evaluator = new RuleEvaluator(db, service, invoke, () => undefined);
    await evaluator.evaluate(input.id);
    const first = await read(db, input.id);
    expect(first).toMatchObject({
      cause: { state: 'pending', reason: 'contribution-unavailable', notBefore: expect.any(Number) },
      rules: [{ state: 'pending' }],
    });
    service.lookups.register('rule-suite', [
      {
        kind: lookupKind,
        description: 'Answer after becoming available',
        args: z.object({ value: z.array(z.string()) }),
        answer: () => ({ type: 'array' }),
        where: { roots: () => ({}) },
        resolve: async () => null,
      },
    ]);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => first.cause?.notBefore ?? 0);
    try {
      await evaluator.evaluate(input.id);
    } finally {
      clock.mockRestore();
    }
    expect(await read(db, input.id)).toMatchObject({
      cause: { state: 'decided', reason: null, revision: 2, notBefore: null },
      rules: [{ state: 'not-matched' }],
      parts: [],
    });
  });

  it('bounds strategy timeouts across fresh evaluator instances', async () => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = contributions();
    const decide = vi.fn<typeof allGroupStrategy.decide>().mockImplementation(() => new Promise(() => {}));
    service.groupStrategies.register('makaio', [{ ...allGroupStrategy, decide }]);
    const input = occasion([ruleFor()]);
    await enqueue(db, service, invoke, input);

    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (const attempt of [1, 2, 3]) {
        await new RuleEvaluator(db, service, invoke, () => undefined, 100).evaluate(input.id);
        const { cause } = await read(db, input.id);
        expect(cause).toMatchObject({
          revision: attempt,
          state: attempt < 3 ? 'pending' : 'decided',
          reason: 'decision-timeout',
          groups: [{ state: attempt < 3 ? 'pending' : 'decided', reason: 'decision-timeout' }],
        });
        now = cause?.notBefore ?? now;
      }
      await new RuleEvaluator(db, service, invoke, () => undefined, 100).evaluate(input.id);
      expect(decide).toHaveBeenCalledTimes(3);
      expect(await read(db, input.id)).toMatchObject({
        cause: { notBefore: null },
        rules: [{ state: 'failed', reason: 'decision-timeout', snapshot: { rule: input.snapshot.rules[0] } }],
        parts: [],
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('passes a schema-accepted null argument to the lookup', async () => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = contributions();
    const resolve = vi.fn<LookupContribution['resolve']>().mockResolvedValue(null);
    service.lookups.register('rule-suite', [
      {
        kind: lookupKind,
        description: 'Accept an explicit null argument',
        args: z.object({ value: z.null() }),
        answer: () => ({ type: 'string' }),
        resolve,
      },
    ]);
    const input = occasion([ruleFor({ lookups: [{ lookup: lookupKind, name: 'row', args: { value: null } }] })]);
    await enqueue(db, service, invoke, input);
    await new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id);
    expect(resolve.mock.calls.map(([, args]) => args)).toEqual([{ value: null }]);
    expect(await read(db, input.id)).toMatchObject({
      cause: { state: 'decided' },
      rules: [{ state: 'not-matched' }],
    });
  });

  it('aborts in-flight lookup work when the decision deadline expires', async () => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = contributions();
    const aborted: AbortSignal[] = [];
    const resolve = vi.fn<LookupContribution['resolve']>().mockImplementation(
      async (_call, _args, _where, _deadline, signal?: AbortSignal) =>
        new Promise<string>((finish) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted.push(signal);
              finish('late answer');
            },
            { once: true },
          );
        }),
    );
    service.lookups.register('rule-suite', [
      {
        kind: lookupKind,
        description: 'Wait until the decision deadline',
        args: z.object({}),
        answer: () => ({ type: 'string' }),
        resolve,
      },
    ]);
    const lookups = [
      { lookup: lookupKind, name: 'slow', args: {} },
      { lookup: lookupKind, name: 'next', args: {} },
    ];
    const input = occasion([ruleFor({ lookups })]);
    await enqueue(db, service, invoke, input);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await new RuleEvaluator(db, service, invoke, () => undefined, 100).evaluate(input.id);
    } finally {
      clock.mockRestore();
    }
    expect(aborted).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await read(db, input.id)).toMatchObject({
      cause: { state: 'pending', reason: 'decision-timeout' },
      rules: [{ state: 'pending' }],
      parts: [],
    });
  });
});
