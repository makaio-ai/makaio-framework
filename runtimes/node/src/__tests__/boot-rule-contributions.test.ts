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
import { createBusNamespace, journalSubject, MAKAIO_RULES_PARTY_KIND } from '@makaio/core';
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
import type { BootMakaioRuntimeOptions } from '../boot-types.js';
import { bootMakaioRuntime } from '../boot.js';
import { ExplicitDescriptorDiscovery } from '../extension-discovery.js';

/**
 * Boot the real Node host with an isolated home and discover in-process manifests.
 * @param packages - Extensions to load.
 * @param packageConfigDefaults - Configuration defaults for the test host.
 * @returns The running host.
 */
async function bootRuleHost(
  packages: readonly KernelMakaioExtension[],
  packageConfigDefaults?: BootMakaioRuntimeOptions['packageConfigDefaults'],
) {
  const home = await mkdtemp(join(tmpdir(), 'makaio-rules-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const runtime = await bootMakaioRuntime({
    httpServer: server,
    packageConfigDefaults,
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
  const occasion = {
    id: 'entry',
    event: {
      cause: { entryId: 'entry', position: 1 },
      subject: 'rule-consumer.changed',
      origin: { caller: call.caller, principal: call.principal },
      facts: {},
    },
    payload: {},
  };
  expect(coordinator.getRuleSource()).toBe(feed.source);
  await expect(runtime.ruleEvaluator.prepare(occasion)).resolves.toBeUndefined();
  await expect(rules?.validate({ rules: [], groups: [] })).resolves.toEqual([]);
  const rule = {
    id: 'validated-rule',
    description: 'Validate an active trigger and reaction',
    on: { kind: 'rule-consumer.test' },
    reaction: { kind: 'rule-consumer.run', params: {} },
  };
  await expect(rules?.validate({ rules: [rule], groups: [] })).resolves.toEqual([]);
  await expect(
    rules?.validate({
      rules: [{ ...rule, reaction: { kind: 'rule-consumer.missing' }, extensions: { 'rule-consumer': {} } }],
      groups: [],
    }),
  ).resolves.toEqual([
    expect.objectContaining({ ruleId: rule.id, code: 'unknown-reaction', severity: 'error' }),
    expect.objectContaining({ ruleId: rule.id, code: 'extension-block-mismatch', severity: 'error' }),
  ]);
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
  await expect(runtime.ruleEvaluator.prepare(occasion)).resolves.toBeNull();
  await coordinator.applyExtensionTransition('rule-source', true);
  await expect(runtime.ruleEvaluator.prepare(occasion)).resolves.toBeUndefined();
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

it('checks candidate schemas and rights deterministically without activating candidate rights', async () => {
  const namespace = createBusNamespace('rule-candidate', {
    changed: journalSubject(z.object({}), {
      retention: 'recorded',
      schemaVersion: '1',
      readOlder: { kind: 'as-recorded' },
    }),
    apply: { request: z.object({}), response: z.object({}) },
  });
  let rules: RulesCapability | undefined;
  const questions: RightSourceQuestion[] = [];
  const candidateRight = { right: 'rule-candidate.read', description: 'Read candidate values', context: {} };
  await bootRuleHost([
    extension('rule-candidate', {
      namespaces: [namespace],
      triggers: [
        {
          kind: 'rule-candidate.changed',
          description: 'Project candidate facts',
          subjects: () => ['rule-candidate.changed'],
          facts: (_params, catalogContext) => ({
            type: 'object',
            $defs: { allowed: { type: 'string' } },
            properties: catalogContext === 'allowed' ? { defined: { $ref: '#/$defs/allowed' } } : {},
            required: ['defined'],
            additionalProperties: false,
          }),
          toFacts: () => ({ defined: 'yes' }),
        },
      ],
      rightsSources: [
        {
          source: 'rule-candidate.validate',
          description: 'Authorize from the candidate context',
          rights: ['makaio.subject.send', 'makaio.subject.subscribe'],
          async answer(question) {
            questions.push(question);
            const context = z.object({ check: z.string().optional() }).parse(question.context);
            return context.check !== 'denied' ? { granted: true } : { granted: false, reason: 'candidate-denied' };
          },
        },
      ],
      create(ctx) {
        rules = ctx.rules;
        return {};
      },
    }),
  ]);
  const rule = {
    id: 'candidate-rule',
    description: 'Check a rule using staged rights and facts',
    on: { kind: 'rule-candidate.changed' },
    lookups: [{ lookup: 'makaio.has-right', name: 'access', args: { right: candidateRight.right } }],
    when: { field: '$event.facts.defined', operator: { $eq: 'yes' } },
    reaction: { kind: 'makaio.send-bus-request', params: { subject: 'rule-candidate.apply', payload: {} } },
  };
  const candidate = { groups: [], pendingRights: [candidateRight], rules: [rule] };
  await expect(rules?.validate({ ...candidate, catalogContext: 'allowed' })).resolves.toEqual([]);
  await expect(rules?.validate({ ...candidate, catalogContext: 'allowed', pendingRights: [] })).resolves.toEqual([
    expect.objectContaining({ code: 'unknown-right' }),
  ]);
  const denied = { ...candidate, catalogContext: 'denied' };
  const findings = await rules?.validate(denied);
  expect(findings).toEqual([
    expect.objectContaining({ code: 'not-subscribable' }),
    expect.objectContaining({ code: 'unknown-path' }),
    expect.objectContaining({ code: 'request-not-granted' }),
  ]);
  await expect(rules?.validate(denied)).resolves.toEqual(findings);
  expect(questions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        call: expect.objectContaining({
          caller: { kind: MAKAIO_RULES_PARTY_KIND, id: MAKAIO_RULES_PARTY_KIND },
          principal: { kind: MAKAIO_RULES_PARTY_KIND, id: MAKAIO_RULES_PARTY_KIND },
        }),
        context: { check: 'denied', pattern: 'rule-candidate.changed' },
      }),
      expect.objectContaining({ context: { check: 'denied', subject: 'rule-candidate.apply' } }),
    ]),
  );
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
  const deadline = new Date(Date.now() + 1_000).toISOString();
  const { signal } = new AbortController();
  await expect(
    lookup?.resolve(call, { right, context: { privateValue: 'redacted' } }, undefined, deadline, signal),
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
    lookup?.resolve(call, { right, context: { alternate: true } }, undefined, deadline, signal),
  ).rejects.toThrow('source-unavailable');
  expect(denials).toHaveLength(1);
});

it('sends the generic reaction request as the evaluation for the witnessed principal', async () => {
  const namespace = createBusNamespace('rule-echo', {
    echo: { request: z.object({}), response: z.object({ echoed: z.boolean() }) },
  });
  const views: unknown[] = [];
  const rulePorts: unknown[] = [];
  const { bus, coordinator } = await bootRuleHost([
    extension('rule-echo', {
      dependencies: [dep(ReactionRegistryToken.name)],
      namespaces: [namespace],
      create(ctx) {
        views.push(ctx.getService(extensionToken(ReactionRegistryToken.name)));
        rulePorts.push(ctx.getService(RuleContributionsToken));
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
    if (!view) throw new Error('Reaction view is unavailable');
    views.push(view);
    expect(view.listDescriptors()).toContainEqual(expect.objectContaining({ kind: 'rule-echo.local' }));
    Reflect.apply(view.deregister, view, ['makaio']);
    expect(view.listDescriptors()).not.toContainEqual(expect.objectContaining({ kind: 'rule-echo.local' }));
    expect(view.listDescriptors()).toContainEqual(expect.objectContaining({ kind: 'makaio.send-bus-request' }));
  });
  expect(views).toHaveLength(3);
  for (const view of views) {
    expect(view).toBeDefined();
    expect.soft(view).not.toHaveProperty('invoke');
    expect.soft(view).not.toHaveProperty('ruleDefinition');
    expect.soft(view).not.toHaveProperty('getValidator');
  }
  expect(rulePorts).toEqual([expect.objectContaining({ listLookups: expect.any(Function) })]);
  expect(rulePorts[0]).not.toHaveProperty('reaction');
  expect(rulePorts[0]).not.toHaveProperty('reactions');
  const caller = { kind: MAKAIO_RULES_PARTY_KIND, id: MAKAIO_RULES_PARTY_KIND };
  const principal = { kind: 'test.user', id: 'principal' };
  const attestedBy = { kind: 'test.source', id: 'witness' };
  const call = createTestCall({ caller, principal, attestedBy });
  const received: unknown[] = [];
  onTestFinished(
    bus.on(namespace.subjects.echo, (ctx) => {
      received.push({ call: ctx.call, key: ctx.idempotencyKey });
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
  expect(received).toEqual([{ call: expect.objectContaining({ caller, principal, attestedBy }), key: 'echo-part' }]);
});

it('awaits contribution checks through the public rule validation capability', async () => {
  let rules: RulesCapability | undefined;
  const stalled = Promise.withResolvers<[]>();
  await bootRuleHost(
    [
      extension('rule-consumer', {
        triggers: [trigger],
        reactions: {
          createReactions: () => [
            defineReaction({
              kind: 'rule-consumer.run',
              description: 'Validate a reaction asynchronously',
              parameterSchema: z.object({}),
              keyed: false,
              handler: async () => ({ state: 'accepted' }),
              async validate(_params, { catalogContext }) {
                return [{ severity: 'warning', code: 'reaction-note', path: '$', message: String(catalogContext) }];
              },
            }),
          ],
        },
        lookups: [
          {
            kind: 'rule-consumer.find',
            description: 'Wait for an unavailable validation result',
            args: z.object({}),
            answer: () => ({}),
            resolve: async () => null,
            validate: () => stalled.promise,
          },
        ],
        ruleBlock: {
          schema: z.object({ enabled: z.boolean() }),
          async validate() {
            throw new Error('Invalid block');
          },
        },
        create(ctx) {
          rules = ctx.rules;
          return {};
        },
      }),
    ],
    new Map([[RuleContributionsToken.name, { validationTimeoutMs: 50 }]]),
  );
  if (!rules) throw new Error('Rules capability is unavailable');
  await expect(
    rules.validate({
      rules: [
        {
          id: 'check-contributions',
          description: 'Check each contribution',
          on: { kind: 'rule-consumer.test' },
          reaction: { kind: 'rule-consumer.run' },
          lookups: [{ name: 'found', lookup: 'rule-consumer.find', args: {} }],
          extensions: { 'rule-consumer': { enabled: true } },
        },
      ],
      groups: [],
      catalogContext: 'candidate context',
    }),
  ).resolves.toEqual([
    expect.objectContaining({
      code: 'contribution-validation-timeout',
      contribution: { kind: 'lookup', name: 'rule-consumer.find' },
    }),
    expect.objectContaining({ code: 'reaction-note', message: 'candidate context' }),
    expect.objectContaining({
      code: 'contribution-validation-failed',
      contribution: { kind: 'rule-block', name: 'rule-consumer' },
    }),
  ]);
  stalled.resolve([]);
});
