import { createBusInstance } from '@makaio/bus-core';
import { defineReaction } from '@makaio/contracts/reaction';
import type { ConditionTemplate, ReactionRule } from '@makaio/contracts/rules';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ReactionRegistry } from '../../reaction/reaction-registry.js';
import { busMessageTrigger } from '../../rule-contributions/builtins/bus-message-trigger.js';
import { RuleContributionsService } from '../../rule-contributions/rule-contributions-service.js';

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
