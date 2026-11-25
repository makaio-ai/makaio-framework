import { createBusInstance } from '@makaio/bus-core';
import { defineReaction } from '@makaio/contracts/reaction';
import type { ConditionTemplate, ReactionRule, RuleFinding } from '@makaio/contracts/rules';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ReactionRegistry } from '../../reaction/reaction-registry.js';
import { busMessageTrigger } from '../../rule-contributions/builtins/bus-message-trigger.js';
import { RuleContributionsService } from '../../rule-contributions/rule-contributions-service.js';
import { checkParameterSchema } from '../validate-rule-inputs.js';

it('checks each comparison against every admitted type of a referenced fact', async () => {
  const bus = createBusInstance();
  const reactions = new ReactionRegistry(bus);
  reactions.register('union-test', [
    defineReaction({
      kind: 'union-test.notify',
      description: 'Accept the matching rule',
      parameterSchema: z.object({}),
      keyed: false,
      handler: async () => ({ state: 'accepted' }),
    }),
  ]);
  const service = new RuleContributionsService(
    bus,
    () => reactions,
    () => true,
  );
  service.triggers.register('makaio', [busMessageTrigger]);
  const numericOrBoolean = { anyOf: [{ type: 'boolean' }, { type: 'number' }] };
  service.lookups.register('union-test', [
    {
      kind: 'union-test.bound',
      description: 'Provide a bound with two admitted types',
      args: z.object({}),
      answer: () => numericOrBoolean,
      resolve: async () => 2,
    },
    {
      kind: 'union-test.rows',
      description: 'Return rows',
      args: z.object({}),
      answer: () => ({ type: 'array' }),
      where: {
        roots: () => ({ score: { type: 'number' }, enabled: { type: 'boolean' }, label: { type: 'string' } }),
      },
      resolve: async () => [{ score: 2, enabled: true }],
    },
  ]);

  const ref = { ref: '$lookup.bound' };
  const candidate = (id: string, where: ConditionTemplate): ReactionRule => ({
    id,
    description: 'Compare against a fact with more than one type',
    on: { kind: busMessageTrigger.kind, params: { subject: 'union-test.changed' } },
    reaction: { kind: 'union-test.notify' },
    lookups: [
      { name: 'bound', lookup: 'union-test.bound', args: {} },
      { name: 'rows', lookup: 'union-test.rows', args: {}, where },
    ],
  });
  const valid: ReactionRule = {
    ...candidate('valid', {
      $or: [
        { field: 'score', operator: { $gt: ref } },
        { field: 'score', operator: { $eq: ref } },
        { field: 'enabled', operator: { $eq: ref } },
      ],
    }),
    when: { field: '$lookup.bound', operator: { $ne: 1 } },
  };
  const invalid = candidate('invalid', { field: 'score', operator: { $startsWith: ref } });
  const incompatible = candidate('incompatible', { field: 'label', operator: { $eq: ref } });

  const rights = { listRights: () => [], canSubscribe: async () => true, canSend: async () => true };
  const findings = await service.validate(rights, { rules: [valid, invalid, incompatible], groups: [] });
  expect(findings.filter(({ severity }) => severity === 'error')).toMatchObject([
    { ruleId: 'invalid', code: 'params-invalid', path: 'lookups.1.where' },
    { ruleId: 'incompatible', code: 'type-mismatch', path: 'lookups.1.where.operator' },
  ]);
});

it('checks definite key errors in mixed inputs and accepts optional or defaulted fields', async () => {
  const schema = z.strictObject({
    value: z.string(),
    required: z.number(),
    fallback: z.string().default('default'),
    optional: z.string().optional(),
  });
  const findings: RuleFinding[] = [];
  const value = { ref: '$event.facts.payload' };
  await checkParameterSchema({ value, extra: true }, schema, 'params', findings, 'record');
  expect(findings).toMatchObject([
    { code: 'params-invalid', path: 'params.required' },
    { code: 'params-invalid', path: 'params.extra' },
  ]);
  const valid: RuleFinding[] = [];
  await checkParameterSchema({ value, required: 1 }, schema, 'params', valid, 'record');
  expect(valid).toEqual([]);
});

it('reports a missing required unknown field alongside a reference', async () => {
  const schema = z.strictObject({ value: z.string(), required: z.unknown() });
  const value = { ref: '$event.facts.payload' };
  const findings: RuleFinding[] = [];
  await checkParameterSchema({ value }, schema, 'params', findings, 'record');
  expect(findings).toMatchObject([{ code: 'params-invalid', path: 'params.required' }]);
  expect(schema.safeParse({ value: 'resolved' }).success).toBe(false);
  const valid: RuleFinding[] = [];
  await checkParameterSchema({ value, required: null }, schema, 'params', valid, 'record');
  expect(valid).toEqual([]);
});
