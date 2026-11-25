import { createBusInstance } from '@makaio/bus-core';
import { ArtifactNamespace } from '@makaio/contracts/artifact';
import type { ReactionRule } from '@makaio/contracts/rules';
import { createBusNamespace } from '@makaio/core';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ReactionRegistry } from '../../reaction/reaction-registry.js';
import { allGroupStrategy } from '../../rule-contributions/builtins/all-group-strategy.js';
import { busMessageTrigger } from '../../rule-contributions/builtins/bus-message-trigger.js';
import { createSendBusRequestReaction } from '../../rule-contributions/builtins/send-bus-request-reaction.js';
import { RuleContributionsService } from '../../rule-contributions/rule-contributions-service.js';

const target = createBusNamespace('validation-test', {
  save: { request: z.object({ value: z.string().min(2), enabled: z.boolean() }), response: z.object({}) },
  preprocess: {
    request: z.object({ value: z.preprocess(Number, z.number()), label: z.string() }),
    response: z.object({}),
  },
});
const rights = { listRights: () => [], canSubscribe: async () => true, canSend: async () => true };

/** @returns The live validation service and a rule using a registered request. */
function fixture() {
  const bus = createBusInstance();
  bus.registerNamespace(target);
  bus.registerNamespace(ArtifactNamespace);
  const reactions = new ReactionRegistry(bus);
  const reaction = createSendBusRequestReaction(bus, async () => ({ granted: true }));
  reactions.register('makaio', [reaction]);
  const service = new RuleContributionsService(
    bus,
    () => reactions,
    () => true,
  );
  service.triggers.register('makaio', [busMessageTrigger]);
  service.groupStrategies.register('makaio', [allGroupStrategy]);
  const rule: ReactionRule = {
    id: 'save',
    description: 'Save a value',
    on: { kind: busMessageTrigger.kind, params: { subject: 'validation-test.changed' } },
    reaction: {
      kind: reaction.kind,
      params: { subject: 'validation-test.save', payload: { value: 'ok', enabled: true } },
    },
  };
  return { service, rule };
}

it('rejects duplicate group declarations even when the group is unused', async () => {
  const { service, rule } = fixture();
  const group = { group: 'save', strategy: allGroupStrategy.strategy };
  const findings = await service.validate(rights, {
    rules: [rule],
    groups: [group, { ...group, strategy: 'validation-test.other' }],
  });
  expect(findings.filter(({ severity }) => severity === 'error')).toMatchObject([
    { code: 'duplicate-group', path: 'groups.1.group' },
  ]);
});

it('accepts an empty group name with a matching declaration', async () => {
  const { service, rule } = fixture();
  const findings = await service.validate(rights, {
    rules: [{ ...rule, group: '', priority: 1 }],
    groups: [{ group: '', strategy: allGroupStrategy.strategy }],
  });
  expect(findings.filter(({ severity }) => severity === 'error')).toEqual([]);
});

it.each([
  ['invalid literal', 'validation-test.save', { value: 'x', enabled: true }, 'reaction.params.payload'],
  ['valid literal', 'validation-test.save', { value: 'ok', enabled: true }, undefined],
  [
    'mixed payload with an invalid literal field',
    'validation-test.save',
    { value: { ref: '$event.facts.payload.value' }, enabled: 'yes' },
    'reaction.params.payload.enabled',
  ],
  [
    'mixed payload with a stripped property',
    'artifact.query',
    { scope: { level: { ref: '$event.facts.payload.level' }, trace: 'x' } },
    undefined,
  ],
  [
    'mixed payload with a preprocessed property',
    'validation-test.preprocess',
    { value: '42', label: { ref: '$event.facts.payload.label' } },
    undefined,
  ],
] as const)('validates a %s against its request target', async (_label, subject, payload, path) => {
  const { service, rule } = fixture();
  const candidate: ReactionRule = {
    ...rule,
    reaction: { ...rule.reaction, params: { subject: { literal: subject }, payload } },
  };
  const findings = await service.validate(rights, { rules: [candidate], groups: [] });
  expect(findings.some((finding) => finding.path === 'reaction.params.subject')).toBe(false);
  expect(findings.filter(({ severity }) => severity === 'error')).toMatchObject(
    path ? [{ ruleId: rule.id, code: 'params-invalid', path }] : [],
  );
});
