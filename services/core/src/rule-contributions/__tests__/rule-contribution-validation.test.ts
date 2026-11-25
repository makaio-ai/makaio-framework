import { expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { defineReaction } from '@makaio/contracts/reaction';
import type { LookupContribution, ReactionRule, RuleFinding } from '@makaio/contracts/rules';
import { ExtensionCoordinator, type KernelMakaioExtension } from '@makaio/kernel';
import { useJournalHostFixture } from '@makaio/storage-conformance';
import { ReactionRegistryToken, reactionRegistryPackage } from '../../reaction/packages.js';
import { createReactionContributionProcessor } from '../../reaction/reaction-contribution-processor.js';
import type { ReactionRegistry } from '../../reaction/reaction-registry.js';
import { RuleContributionsToken, createRuleContributionsPackage } from '../packages.js';
import { createRuleContributionProcessor } from '../rule-contribution-processor.js';
import type { RuleContributionsService } from '../rule-contributions-service.js';

const { constructContext } = useJournalHostFixture();
const OWNER = 'validation-test';
const RULE: ReactionRule = {
  id: 'check-fixture',
  description: 'Checks all custom validators',
  on: { kind: `${OWNER}.trigger` },
  reaction: { kind: `${OWNER}.react`, params: { message: { literal: 'reaction input' } } },
  lookups: [
    { name: 'slow', lookup: `${OWNER}.slow`, args: {} },
    { name: 'ready', lookup: `${OWNER}.ready`, args: { note: { literal: 'lookup input' } } },
  ],
  extensions: { [OWNER]: { enabled: true } },
};

/**
 * Creates a lookup with a custom validation hook.
 * @param name - Local kind name.
 * @param validate - The contributed check.
 * @returns A lookup declaration.
 */
function lookup(name: string, validate: NonNullable<LookupContribution['validate']>): LookupContribution {
  return {
    kind: `${OWNER}.${name}`,
    description: `Checks the ${name} lookup`,
    args: z.object({}),
    answer: () => ({}),
    resolve: async () => null,
    validate,
  };
}

/**
 * Starts a coordinator that resolves the rule host's normal package configuration.
 * @param contributor - Extension contributing the hooks for the test rule.
 * @param validationTimeoutMs - Configured per-hook deadline.
 * @returns The active rule contributions service.
 */
async function startService(contributor: KernelMakaioExtension, validationTimeoutMs: number) {
  const coordinator = new ExtensionCoordinator(createBusInstance(), {
    extensionContextBase: {
      constructContext,
      platform: 'linux',
      homedir: '/home/test',
      makaioHome: '/home/test/.makaio',
      username: 'test',
      machineId: 'test',
      tryImport: async () => null,
    },
  });
  onTestFinished(() => coordinator.shutdown());
  coordinator.registerContributionProcessor(
    createReactionContributionProcessor({
      forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
    }),
  );
  const getService = () => coordinator.getExtensionService<RuleContributionsService>(RuleContributionsToken.name);
  coordinator.registerContributionProcessor(createRuleContributionProcessor(getService));
  const ruleContributionsPackage = createRuleContributionsPackage(() =>
    coordinator.getExtensionService<ReactionRegistry>(ReactionRegistryToken.name),
  );
  coordinator.load(
    [reactionRegistryPackage, ruleContributionsPackage, contributor],
    new Map([[RuleContributionsToken.name, { validationTimeoutMs }]]),
  );
  await coordinator.startAll();
  const service = getService();
  if (!service) throw new Error('Rule contributions service did not start');
  return service;
}

it('collects synchronous and asynchronous checks and isolates a throw and the configured deadline', async () => {
  const context = { roots: {}, catalogContext: 'check context' };
  const warning: RuleFinding = { severity: 'warning', code: 'advice', path: '$', message: 'Review this choice' };
  const delayed = Promise.withResolvers<RuleFinding[]>();
  const service = await startService(
    {
      name: OWNER,
      displayName: 'Validation fixture',
      version: '1.0.0',
      reactions: {
        createReactions: () => [
          defineReaction({
            kind: RULE.reaction.kind,
            description: 'Returns a promised warning',
            parameterSchema: z.object({ message: z.string() }),
            keyed: false,
            handler: async () => ({ state: 'accepted' }),
            validate: async (params, ctx) => {
              expect(params).toEqual(RULE.reaction.params);
              expect(ctx).toBe(context);
              return [warning];
            },
          }),
        ],
      },
      lookups: [
        lookup('slow', () => delayed.promise),
        lookup('ready', (args, ctx) => {
          expect(args).toEqual({ note: { literal: 'lookup input' } });
          expect(ctx).toBe(context);
          return [warning];
        }),
      ],
      ruleBlock: {
        schema: z.object({ enabled: z.boolean() }),
        validate: (block, rule, ctx) => {
          expect(block).toEqual({ enabled: true });
          expect(rule).toBe(RULE);
          expect(ctx).toBe(context);
          throw new Error('block check failed');
        },
      },
    },
    25,
  );

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    let settled = false;
    const checking = service.validateRuleContributions(RULE, context).then((findings) => {
      settled = true;
      return findings;
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await checking).toEqual([
      { ...warning, ruleId: RULE.id, contribution: { kind: 'reaction', name: RULE.reaction.kind } },
      {
        severity: 'error',
        code: 'contribution-validation-timeout',
        ruleId: RULE.id,
        path: '$.lookups[0]',
        contribution: { kind: 'lookup', name: `${OWNER}.slow` },
        message: "Validation of lookup 'validation-test.slow' exceeded 25 ms",
      },
      { ...warning, ruleId: RULE.id, contribution: { kind: 'lookup', name: `${OWNER}.ready` } },
      {
        severity: 'error',
        code: 'contribution-validation-failed',
        ruleId: RULE.id,
        path: '$.extensions["validation-test"]',
        contribution: { kind: 'rule-block', name: OWNER },
        message: "Validation of rule-block 'validation-test' failed: block check failed",
      },
    ]);
    delayed.reject(new Error('late lookup rejection'));
  } finally {
    vi.useRealTimers();
  }
});
