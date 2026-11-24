import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { defineReaction, dep, extensionToken } from '@makaio/contracts';
import { AccessSubjects, CoreDenialPlace, type AccessDenied } from '@makaio/contracts/access';
import {
  RulesSubjects,
  type RuleSourceContribution,
  type RulesCapability,
  type RulesTriggerReader,
} from '@makaio/contracts/rules';
import type { RightSourceQuestion } from '@makaio/contracts/rights';
import { createBusNamespace, MAKAIO_RULES_PARTY_KIND } from '@makaio/core';
import type { KernelMakaioExtension } from '@makaio/kernel';
import {
  type ReactionRegistry,
  ReactionRegistryToken,
  type RuleContributionsService,
  RuleContributionsToken,
  type RuleContributionsView,
  allGroupStrategy,
} from '@makaio/services-core';
import { createTestCall } from '@makaio/test-utils';
import { bootMakaioRuntime } from '../boot.js';
import { ExplicitDescriptorDiscovery } from '../extension-discovery.js';

/**
 * Boot the real Node host with an isolated home and discover in-process manifests.
 * @param packages - Extensions to load.
 * @returns The running host.
 */
async function bootRuleHost(packages: readonly KernelMakaioExtension[]) {
  const home = await mkdtemp(join(tmpdir(), 'makaio-rules-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const runtime = await bootMakaioRuntime({
    httpServer: server,
    makaioHome: home,
    frameworkVersion: '3.0.0',
    discovery: new ExplicitDescriptorDiscovery(
      packages.map((pkg) => ({
        descriptor: {
          name: pkg.name,
          displayName: pkg.displayName,
          version: pkg.version,
          makaio: { framework: '>=1.0.0' },
          entrypoints: { server: true },
        },
        extensionPath: home,
        source: 'local',
        preloadedModule: { default: pkg },
      })),
    ),
  });
  onTestFinished(() => runtime.shutdown());
  return runtime;
}

/**
 * Builds a source and a publishing handle for a test extension.
 * @returns The declared source, upstream listeners and a publisher.
 */
function ruleFeed() {
  const listeners = new Set<() => void>();
  let triggers: ReturnType<RuleSourceContribution['ruleTriggers']> = [];
  const source: RuleSourceContribution = {
    rulesFor: async () => ({ set: { id: 'set', digest: 'digest' }, rules: [], groups: [], excluded: [] }),
    ruleTriggers: () => triggers,
    onTriggersChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listeners,
    publish(next: typeof triggers) {
      triggers = next;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * Adds identity fields to a test manifest.
 * @param name - Extension identity.
 * @param contributions - Manifest fields for this scenario.
 * @returns A loadable extension.
 */
function extension(name: string, contributions: Partial<KernelMakaioExtension>): KernelMakaioExtension {
  return { name, version: '1.0.0', displayName: name, ...contributions };
}

const trigger = {
  kind: 'rule-consumer.test',
  description: 'Projects test payloads',
  subjects: () => ['rule-consumer.changed'],
  facts: (_params: unknown, catalogContext: unknown) => ({ description: String(catalogContext) }),
  toFacts: () => ({}),
} satisfies NonNullable<KernelMakaioExtension['triggers']>[number];

it('exposes frozen rule discovery and checks to an extension while registering contributions on activation', async () => {
  let view: RuleContributionsView | undefined;
  const finding = { severity: 'warning', code: 'test', path: '$', message: 'Review the block' } as const;
  const { coordinator } = await bootRuleHost([
    extension('rule-consumer', {
      triggers: [trigger],
      ruleBlock: { schema: z.object({}), validate: () => [finding] },
    }),
    extension('rule-observer', {
      dependencies: [dep(RuleContributionsToken.name)],
      create(ctx) {
        view = ctx.getService(RuleContributionsToken);
        return {};
      },
    }),
  ]);
  expect(view).toBeDefined();
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.keys(view ?? {}).sort()).toEqual(['listLookups', 'listTriggers', 'validateRuleContributions']);
  expect(view?.listTriggers().entries).toContainEqual(expect.objectContaining({ kind: trigger.kind }));
  expect(view?.listLookups().entries).toContainEqual(expect.objectContaining({ kind: 'makaio.has-right' }));
  await expect(
    view?.validateRuleContributions(
      {
        id: 'test',
        description: 'Checks the contributed block',
        on: { kind: trigger.kind },
        reaction: { kind: 'rule-consumer.run' },
        extensions: { 'rule-consumer': {} },
      },
      { roots: {} },
    ),
  ).resolves.toEqual([{ ...finding, ruleId: 'test', contribution: { kind: 'rule-block', name: 'rule-consumer' } }]);
  await expect(coordinator.applyExtensionTransition('rule-consumer', false)).resolves.toBe('applied');
  expect(view?.listTriggers().entries).not.toContainEqual(expect.objectContaining({ kind: trigger.kind }));
  await expect(coordinator.applyExtensionTransition('rule-consumer', true)).resolves.toBe('applied');
  expect(view?.listTriggers().entries).toContainEqual(expect.objectContaining({ kind: trigger.kind }));
});

it('boots rule contributions, serves live catalogs and releases readers and source on unload', async () => {
  const feed = ruleFeed();
  const snapshots: Array<ReturnType<RulesTriggerReader['current']>> = [];
  let reader: RulesTriggerReader | undefined;
  let rules: RulesCapability | undefined;
  const runtime = await bootRuleHost([
    extension('rule-source', { ruleSource: feed.source }),
    extension('rule-consumer', {
      triggers: [trigger],
      reactions: {
        createReactions: () => [
          defineReaction({
            kind: 'rule-consumer.run',
            description: 'Runs a test reaction',
            parameterSchema: z.object({}),
            resultSchema: z.string(),
            keyed: true,
            handler: async () => ({ state: 'accepted', result: 'done' }),
          }),
        ],
      },
      lookups: [
        {
          kind: 'rule-consumer.find',
          description: 'Finds the test value',
          args: z.object({}),
          answer: (_args, ctx) => ({ description: String(ctx.catalogContext) }),
          resolve: async () => 'found',
        },
      ],
      groupStrategies: [{ ...allGroupStrategy, strategy: 'rule-consumer.all' }],
      ruleBlock: { schema: z.object({ enabled: z.boolean() }) },
      create(ctx) {
        rules = ctx.rules;
        const bound = ctx.rules.triggers();
        reader = bound;
        bound.onChange(() => snapshots.push(bound.current()));
        return {};
      },
    }),
  ]);
  const { bus, coordinator } = runtime;
  const service = coordinator.getExtensionService<RuleContributionsService>(RuleContributionsToken.name);
  const call = createTestCall();
  expect(coordinator.getRuleSource()).toBe(feed.source);
  await expect(rules?.validate({ rules: [], groups: [] })).rejects.toThrow('validation is not implemented');
  expect(service?.groupStrategies.get('rule-consumer.all')).toBeDefined();
  expect(service?.ruleBlocks.get('rule-consumer')).toBeDefined();
  expect(
    (await bus.request(call, RulesSubjects.triggers, { catalogContext: 'schema-context' })).entries,
  ).toContainEqual(expect.objectContaining({ extension: 'rule-consumer', facts: { description: 'schema-context' } }));
  expect((await bus.request(call, RulesSubjects.lookups, { catalogContext: 'schema-context' })).entries).toContainEqual(
    expect.objectContaining({ extension: 'rule-consumer', answer: { description: 'schema-context' } }),
  );
  expect((await bus.request(call, RulesSubjects.reactions, {})).entries).toContainEqual(
    expect.objectContaining({ extension: 'rule-consumer', keyed: true, result: { type: 'string' } }),
  );

  const own = { kind: trigger.kind, params: null, subjects: trigger.subjects() };
  feed.publish([own, { ...own, kind: 'other.trigger' }]);
  feed.publish([own, { ...own, kind: 'other.changed' }]);
  expect(snapshots).toEqual([[own]]);
  await coordinator.applyExtensionTransition('rule-consumer', false);
  feed.publish([{ ...own, params: 'changed' }]);
  expect(reader?.current()).toEqual([]);
  expect(snapshots).toEqual([[own]]);
  expect(service?.triggers.get(trigger.kind)).toBeUndefined();
  expect(service?.groupStrategies.get('rule-consumer.all')).toBeUndefined();
  await coordinator.applyExtensionTransition('rule-source', false);
  expect(coordinator.getRuleSource()).toBeUndefined();
  expect(feed.listeners.size).toBe(0);
});

it('diagnoses foreign and duplicate definitions and rolls back contributors that cannot activate', async () => {
  const { source } = ruleFeed();
  const runtime = await bootRuleHost([
    extension('rule-source', { ruleSource: source }),
    extension('rule-foreign', { triggers: [trigger] }),
    extension('rule-consumer', { triggers: [trigger, trigger] }),
    extension('rule-other-source', {
      ruleSource: source,
      triggers: [{ ...trigger, kind: 'rule-other-source.test' }],
    }),
  ]);
  const { coordinator } = runtime;
  const errors = new Map(coordinator.list().map(({ name, error }) => [name, error]));
  expect(errors.get('rule-foreign')).toMatch(/must be namespaced/);
  expect(errors.get('rule-consumer')).toMatch(/twice/);
  expect(errors.get('rule-other-source')).toMatch(/second one/);
  expect(
    coordinator
      .getExtensionService<RuleContributionsService>(RuleContributionsToken.name)
      ?.triggers.get('rule-other-source.test'),
  ).toBeUndefined();
  expect(coordinator.getRuleSource()).toBe(source);
});

it('asks the shared rights resolver with the witnessed call and reports a sanitized denial', async () => {
  const questions: RightSourceQuestion[] = [];
  const right = 'rule-right.read';
  const runtime = await bootRuleHost([
    extension('rule-right', {
      rights: [{ right, description: 'Read a value', context: {} }],
      rightsSources: [
        {
          source: 'rule-right.policy',
          description: 'Test policy',
          rights: [right],
          async answer(question) {
            questions.push(question);
            if (questions.length > 1) throw new Error('Policy unavailable');
            return { granted: false, reason: 'declined' };
          },
        },
      ],
    }),
  ]);
  const denials: AccessDenied[] = [];
  const unsubscribe = runtime.bus.on(AccessSubjects.denied, ({ payload }) => {
    denials.push(payload);
  });
  onTestFinished(unsubscribe);
  const lookup = runtime.coordinator
    .getExtensionService<RuleContributionsService>(RuleContributionsToken.name)
    ?.lookups.get('makaio.has-right');
  const call = createTestCall({
    caller: { kind: 'makaio.rules', id: 'evaluation' },
    principal: { kind: 'test.user', id: 'principal' },
    attestedBy: { kind: 'test.source', id: 'witness' },
  });
  await expect(
    lookup?.resolve(call, { right, context: { privateValue: 'redacted' } }, undefined, new Date().toISOString()),
  ).resolves.toEqual({ granted: false, reason: 'declined' });
  expect(questions[0]?.call).toMatchObject({ principal: call.principal, attestedBy: call.attestedBy });
  expect(denials).toEqual([
    {
      at: CoreDenialPlace.lookup,
      ctx: { caller: call.caller, principal: call.principal, attestedBy: call.attestedBy },
      right,
      reason: 'declined',
      by: 'rule-right.policy',
    },
  ]);
  await expect(
    lookup?.resolve(call, { right, context: { alternate: true } }, undefined, new Date().toISOString()),
  ).rejects.toThrow('source-unavailable');
  expect(denials).toHaveLength(1);
});

it('sends the generic reaction request as the evaluation for the witnessed principal', async () => {
  const namespace = createBusNamespace('rule-echo', {
    echo: { request: z.object({}), response: z.object({ echoed: z.boolean() }) },
  });
  const views: unknown[] = [];
  const { bus, coordinator } = await bootRuleHost([
    extension('rule-echo', {
      dependencies: [dep(ReactionRegistryToken.name)],
      namespaces: [namespace],
      create(ctx) {
        views.push(ctx.getService(extensionToken(ReactionRegistryToken.name)));
        return {};
      },
      reactions: {
        createReactions(ctx) {
          views.push(ctx.getService(ReactionRegistryToken));
          return [
            defineReaction({
              kind: 'rule-echo.local',
              description: 'Handles a test rule',
              parameterSchema: z.object({}),
              keyed: false,
              handler: async () => ({ state: 'accepted' }),
            }),
          ];
        },
      },
    }),
  ]);
  coordinator.forExtension('rule-echo', (_name, _pkg, ctx) => {
    const view = ctx.getService(ReactionRegistryToken);
    views.push(view);
    expect(view?.listDescriptors()).toContainEqual(expect.objectContaining({ kind: 'rule-echo.local' }));
  });
  expect(views).toHaveLength(3);
  for (const view of views) {
    expect(view).toBeDefined();
    expect(view).not.toHaveProperty('invoke');
  }
  const caller = { kind: MAKAIO_RULES_PARTY_KIND, id: MAKAIO_RULES_PARTY_KIND };
  const principal = { kind: 'test.user', id: 'principal' };
  const attestedBy = { kind: 'test.source', id: 'witness' };
  const call = createTestCall({ caller, principal, attestedBy });
  const received: unknown[] = [];
  onTestFinished(
    bus.on(namespace.subjects.echo, (ctx) => {
      received.push(ctx.call);
      ctx.setResult({ echoed: true });
    }),
  );
  const registry = coordinator.getExtensionService<ReactionRegistry>(ReactionRegistryToken.name);
  const invoke = registry?.invoke.bind(registry);
  const reaction = { kind: 'makaio.send-bus-request' };
  const rule = { id: 'echo', description: 'Echo the event', on: { kind: 'makaio.bus-message' }, reaction };
  await expect(
    invoke?.(
      reaction.kind,
      { subject: 'rule-echo.echo', payload: {} },
      {
        call,
        key: 'echo-part',
        cause: {
          rule,
          ruleId: rule.id,
          ruleSet: { id: 'test', digest: 'test' },
          evaluationId: 'test-evaluation',
          event: {
            cause: { message: { receivedAt: new Date(0).toISOString() } },
            subject: 'rule-echo.changed',
            facts: {},
            origin: { caller, principal, attestedBy },
          },
        },
      },
    ),
  ).resolves.toEqual({ state: 'accepted', result: { echoed: true } });
  expect(received).toEqual([expect.objectContaining({ caller, principal, attestedBy })]);
});
