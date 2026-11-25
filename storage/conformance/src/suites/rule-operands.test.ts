import { defineReaction, type JsonSchema } from '@makaio/contracts';
import type { ConditionTemplate } from '@makaio/contracts/rules';
import { RuleEvaluator } from '@makaio/services-core';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { contributions, enqueue, occasion, read, ruleFor } from './rules-evaluation-support.js';

const roots: Record<string, JsonSchema> = { score: { type: 'number' }, label: { type: 'string' } };
const bound = { lookup: 'rule-suite.bound', name: 'bound', args: {} };
const reactionKind = 'rule-suite.notify';
const rights = { listRights: () => [], canSubscribe: async () => true, canSend: async () => true };

/** @returns The live contribution registries for operand evaluation scenarios. */
function operandContributions() {
  const fixture = contributions(
    defineReaction({
      kind: reactionKind,
      description: 'Record the matched value',
      parameterSchema: z.object({ value: z.json() }),
      keyed: false,
      handler: async () => ({ state: 'accepted' }),
    }),
  );
  fixture.service.lookups.register('rule-suite', [
    {
      kind: bound.lookup,
      description: 'Return a bound with a union schema',
      args: z.object({}),
      answer: () => ({ anyOf: [{ type: 'boolean' }, { type: 'number' }] }),
      resolve: async () => 2,
    },
    {
      kind: 'rule-suite.rows',
      description: 'Return candidate rows for local filtering',
      args: z.object({}),
      answer: () => ({ type: 'array', items: { type: 'object', properties: roots } }),
      where: { roots: () => roots },
      resolve: async () => [
        { score: 1, label: 'excluded' },
        { score: 3, label: 'included-2' },
      ],
    },
  ]);
  return fixture;
}

describeStorageConformance('rule operands', (config) => {
  const context = useSuiteDatabaseContext(config);

  it.each<ConditionTemplate>([
    { field: 'label', operator: { $startsWith: { template: 'included-{{ $lookup.bound }}' } } },
    { field: 'score', operator: { $gt: { ref: '$lookup.bound' } } },
  ])('validates and evaluates the operand in %j', async (comparison) => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = operandContributions();
    const rule = ruleFor({
      lookups: [
        bound,
        {
          lookup: 'rule-suite.rows',
          name: 'rows',
          args: {},
          where: { $and: [comparison, { $expr: 'true' }] },
        },
      ],
      each: '$lookup.rows',
      reaction: { kind: reactionKind, params: { value: { ref: '$item.label' } } },
    });
    const findings = await service.validate(rights, { rules: [rule], groups: [] });
    expect(findings.filter(({ severity }) => severity === 'error')).toEqual([]);
    const input = occasion([rule]);
    await enqueue(db, service, invoke, input);
    await new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id);
    expect(await read(db, input.id)).toMatchObject({
      rules: [{ state: 'accepted' }],
      parts: [{ state: 'accepted', parameters: { value: 'included-2' } }],
    });
  });

  it.each([
    { parameter: { literal: 'fixed' }, expected: 'fixed' },
    { parameter: { template: '{{ $event.subject }}' }, expected: 'rule-suite.changed' },
  ])('validates and persists a parameter named literal ($expected)', async ({ parameter, expected }) => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = contributions(
      defineReaction({
        kind: reactionKind,
        description: 'Accept a named literal parameter',
        parameterSchema: z.object({ literal: z.string() }),
        keyed: false,
        handler: async () => ({ state: 'accepted' }),
      }),
    );
    const rule = ruleFor({ reaction: { kind: reactionKind, params: { literal: parameter } } });
    const findings = await service.validate(rights, { rules: [rule], groups: [] });
    expect(findings.filter(({ severity }) => severity === 'error')).toEqual([]);
    const input = occasion([rule]);
    await enqueue(db, service, invoke, input);
    await new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id);
    expect(await read(db, input.id)).toMatchObject({
      parts: [{ state: 'accepted', parameters: { literal: expected } }],
    });
  });

  it.each(['reaction', 'lookup'] as const)('validates mixed inputs for a %s with the live schema', async (kind) => {
    const db = createHostDatabase(context().db);
    const schema = z.object({ value: z.string(), enabled: z.boolean(), count: z.coerce.number() });
    const expected = { value: 'rule-suite.changed', enabled: true, count: 42 };
    const { service, invoke } = contributions(
      defineReaction({
        kind: reactionKind,
        description: 'Accept resolved parameters',
        parameterSchema: kind === 'reaction' ? schema : z.object({}),
        keyed: false,
        async handler(_call, args) {
          expect(args).toEqual(kind === 'reaction' ? expected : {});
          return { state: 'accepted' };
        },
      }),
    );
    service.lookups.register('rule-suite', [
      {
        kind: bound.lookup,
        description: 'Check the resolved lookup arguments',
        args: schema,
        answer: () => ({ type: 'boolean' }),
        async resolve(_call, args) {
          expect(args).toEqual(expected);
          return true;
        },
      },
    ]);
    const candidate = (enabled: boolean | string) => {
      const args = { value: { ref: '$event.subject' }, enabled, count: '42', note: 'extra' };
      return ruleFor(
        kind === 'reaction' ? { reaction: { kind: reactionKind, params: args } } : { lookups: [{ ...bound, args }] },
      );
    };
    const invalid = await service.validate(rights, { rules: [candidate('yes')], groups: [] });
    expect(invalid.filter(({ severity }) => severity === 'error')).toMatchObject([
      { code: 'params-invalid', path: `${kind === 'reaction' ? 'reaction.params' : 'lookups.0.args'}.enabled` },
    ]);
    const rule = candidate(true);
    const input = occasion([rule]);
    await enqueue(db, service, invoke, input);
    await new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id);
    expect(await read(db, input.id)).toMatchObject({ rules: [{ state: 'accepted' }], parts: [{ state: 'accepted' }] });
    const findings = await service.validate(rights, { rules: [rule], groups: [] });
    expect(findings.filter(({ severity }) => severity === 'error')).toEqual([]);
  });

  it('blocks malformed reserved operands while preserving an escaped value', async () => {
    const db = createHostDatabase(context().db);
    const { service, invoke } = operandContributions();
    const literal = { ref: 3 };
    const input = occasion([
      ruleFor({ id: 'argument', reaction: { kind: reactionKind, params: { value: literal } } }),
      ruleFor({
        id: 'condition',
        lookups: [
          {
            lookup: 'rule-suite.rows',
            name: 'rows',
            args: {},
            where: { field: 'label', operator: { $eq: { template: 3 } } },
          },
        ],
      }),
      ruleFor({ id: 'escaped', reaction: { kind: reactionKind, params: { value: { literal } } } }),
    ]);
    await enqueue(db, service, invoke, input);
    await new RuleEvaluator(db, service, invoke, () => undefined).evaluate(input.id);
    const stored = await read(db, input.id);
    expect(stored.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'argument', state: 'failed', reason: 'rule-invalid' }),
        expect.objectContaining({ ruleId: 'condition', state: 'failed', reason: 'rule-invalid' }),
        expect.objectContaining({ ruleId: 'escaped', state: 'accepted' }),
      ]),
    );
    expect(stored.parts).toMatchObject([{ state: 'accepted', parameters: { value: literal } }]);
  });
});
