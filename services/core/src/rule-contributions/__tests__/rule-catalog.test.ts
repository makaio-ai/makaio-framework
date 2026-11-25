import { createBusInstance } from '@makaio/bus-core';
import {
  LookupCatalogResponseSchema,
  ReactionCatalogResponseSchema,
  RulesNamespace,
  RulesSubjects,
  TriggerCatalogResponseSchema,
  type LookupContribution,
  type TriggerContribution,
} from '@makaio/contracts/rules';
import { createTestCall } from '@makaio/test-utils';
import { expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { busMessageTrigger } from '../builtins/bus-message-trigger.js';
import { RuleContributionsService } from '../rule-contributions-service.js';

/**
 * Starts the real catalogs on an isolated bus.
 * @returns The catalogs and their bus.
 */
async function startCatalogs() {
  const bus = createBusInstance();
  const catalogs = new RuleContributionsService(
    bus,
    () => undefined,
    (extension) => extension !== 'inactive',
  );
  onTestFinished(() => catalogs.destroy());
  await catalogs.init();
  return { bus, catalogs };
}

/** @throws Always fails while projecting a contribution. */
function brokenProjection(): never {
  throw new Error('Cannot derive a schema');
}

it('returns healthy trigger entries alongside findings for throwing contributions', async () => {
  const { bus, catalogs } = await startCatalogs();
  const healthy: TriggerContribution = {
    kind: 'healthy.trigger',
    description: 'Projects a message',
    subjects: () => ['test.occurred'],
    facts: (_params, context) => ({ description: String(context) }),
    toFacts: () => ({}),
  };
  catalogs.triggers.register('broken', [
    { ...healthy, kind: 'broken.facts', facts: brokenProjection },
    { ...healthy, kind: 'broken.subjects', subjects: brokenProjection },
  ]);
  catalogs.triggers.register('healthy', [healthy]);
  catalogs.triggers.register('inactive', [{ ...healthy, kind: 'inactive.trigger', facts: brokenProjection }]);

  const response = await bus.request(createTestCall(), RulesSubjects.triggers, { catalogContext: 'context' });
  expect(TriggerCatalogResponseSchema.parse(response)).toEqual({
    entries: [expect.objectContaining({ kind: healthy.kind, facts: { description: 'context' } })],
    findings: ['broken.facts', 'broken.subjects'].map((kind) =>
      expect.objectContaining({ code: 'catalog-contribution-failed', extension: 'broken', kind }),
    ),
  });
});

it('returns healthy lookup entries alongside findings for throwing contributions', async () => {
  const { bus, catalogs } = await startCatalogs();
  const healthy: LookupContribution = {
    kind: 'healthy.lookup',
    description: 'Reads a value',
    args: z.object({ key: z.string() }),
    answer: (args, context) => {
      if (args !== undefined) throw new Error('Catalog reads must omit lookup arguments');
      return { description: String(context.catalogContext) };
    },
    resolve: async () => 'value',
  };
  catalogs.lookups.register('broken', [{ ...healthy, kind: 'broken.answer', answer: brokenProjection }]);
  catalogs.lookups.register('healthy', [healthy]);

  const response = await bus.request(createTestCall(), RulesSubjects.lookups, { catalogContext: 'context' });
  expect(LookupCatalogResponseSchema.parse(response)).toEqual({
    entries: [expect.objectContaining({ kind: healthy.kind, answer: { description: 'context' } })],
    findings: [
      expect.objectContaining({ code: 'catalog-contribution-failed', extension: 'broken', kind: 'broken.answer' }),
    ],
  });
});

it('returns the reaction catalog in its published response envelope', async () => {
  const { bus } = await startCatalogs();
  const response = await bus.request(createTestCall(), RulesSubjects.reactions, {});

  expect(ReactionCatalogResponseSchema.parse(response)).toEqual({ entries: [], findings: [] });
});

it('detaches trigger facts and subjects before returning them to extensions', async () => {
  const { bus, catalogs } = await startCatalogs();
  const subjects = ['test.occurred'];
  const facts = { properties: { subject: { type: 'string' } } };
  catalogs.triggers.register('makaio', [{ ...busMessageTrigger, facts: () => facts, subjects: () => subjects }]);
  const call = createTestCall();

  const first = catalogs.extensionServiceView().listTriggers();
  const entry = first.entries[0]!;
  expect(entry.facts['properties']).not.toBe(facts.properties);
  entry.facts['properties'] = null;
  entry.subjects.push('test.other');

  const second = await bus.request(call, RulesSubjects.triggers, {});
  expect(second.entries[0]).toMatchObject({ facts, subjects: ['test.occurred'] });
  expect(subjects).toEqual(['test.occurred']);
});

it('isolates malformed entries before bus response validation', async () => {
  const { bus, catalogs } = await startCatalogs();
  bus.registerNamespace(RulesNamespace);
  const malformed: unknown = null;
  catalogs.triggers.register('makaio', [busMessageTrigger]);
  catalogs.triggers.register('broken', [
    {
      ...busMessageTrigger,
      kind: 'broken.facts',
      facts: () => malformed as ReturnType<TriggerContribution['facts']>,
    },
  ]);

  const response = await bus.request(createTestCall(), RulesSubjects.triggers, {});
  expect(response.entries.map(({ kind }) => kind)).toEqual([busMessageTrigger.kind]);
  expect(response.findings).toEqual([
    expect.objectContaining({ code: 'catalog-contribution-failed', extension: 'broken', kind: 'broken.facts' }),
  ]);
});

it('rejects malformed reaction catalog requests when bus validation is disabled', async () => {
  const { bus } = await startCatalogs();
  bus.registerNamespace({ ...RulesNamespace, options: { busValidationMode: 'skip' } });

  await expect(
    bus.request(createTestCall(), RulesSubjects.reactions, { unexpected: true } as never),
  ).rejects.toMatchObject({
    cause: expect.any(z.ZodError),
  });
});

it('describes the input shapes of transformed parameters and defaulted arguments', async () => {
  const { bus, catalogs } = await startCatalogs();
  catalogs.triggers.register('makaio', [
    { ...busMessageTrigger, params: z.object({ count: z.string().transform(Number) }) },
  ]);
  catalogs.lookups.register('test', [
    {
      kind: 'test.lookup',
      description: 'Reads a value',
      args: z.object({ count: z.number().default(1) }),
      answer: () => ({ type: 'string' }),
      resolve: async () => 'value',
    },
  ]);
  const call = createTestCall();

  const triggers = await bus.request(call, RulesSubjects.triggers, {});
  const lookups = await bus.request(call, RulesSubjects.lookups, {});
  expect.soft(triggers.entries[0]?.params).toMatchObject({
    properties: { count: { type: 'string' } },
    required: ['count'],
  });
  expect(lookups.entries[0]?.args).toMatchObject({
    properties: { count: { type: 'number', default: 1 } },
  });
  expect(lookups.entries[0]?.args).not.toHaveProperty('required');
});
