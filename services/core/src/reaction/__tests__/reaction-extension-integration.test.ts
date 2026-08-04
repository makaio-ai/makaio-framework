import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { createReactionRuleRef, defineReaction } from '@makaio/contracts';
import type { ReactionExecutionContext } from '@makaio/contracts';
import { ExtensionCoordinator } from '@makaio/kernel';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import { ReactionRegistryToken, reactionRegistryPackage } from '../packages.js';
import type { ReactionRegistry } from '../reaction-registry.js';
import { createReactionContributionProcessor } from '../reaction-contribution-processor.js';

/**
 * Minimal {@link KernelExtensionContext} fields (excluding coordinator-owned
 * and bus-owned fields) for test coordinators.
 */
const TEST_PKG_CTX_BASE: Omit<
  KernelExtensionContext,
  'bus' | 'identity' | 'getService' | 'dataDir' | 'config' | 'signal' | 'hasExtension'
> = {
  platform: 'linux',
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async (_specifier) => null,
};

/** Everything one handler run observed, captured for assertions. */
interface ObservedInvocation {
  /** Schema-validated parameters the handler received. */
  readonly parameters: Readonly<{ channel: string; message: string }>;
  /** Frozen execution envelope the handler received. */
  readonly context: ReactionExecutionContext;
}

/** Booted acceptance harness: coordinator, resolved registry, and captures. */
interface Harness {
  /** The real coordinator that loaded and started both extensions. */
  readonly coordinator: ExtensionCoordinator;
  /** The registry resolved the way a host would, after boot. */
  readonly registry: ReactionRegistry;
  /** Handler observations, one entry per successful handler run. */
  readonly observed: ObservedInvocation[];
  /** Number of times the extension's Reaction factory has built its batch. */
  readonly reactionFactoryCalls: () => number;
  /**
   * The extension-wide shutdown signal `createReactions` received on its
   * {@link ReactionContributionContext} — the acceptance criterion compares it
   * against the per-invocation signal handlers observe.
   */
  readonly extensionSignal: () => AbortSignal | undefined;
}

/** Canonical kind contributed by the fictional extension. */
const KIND = 'demo-notifier.notify-owner';

/**
 * Boots a real coordinator with the framework Reaction registry package, the
 * real Reaction contribution processor, and a fictional `demo-notifier`
 * extension whose contribution imports only framework contracts.
 * @returns The started harness with captured handler observations.
 */
async function bootHarness(): Promise<Harness> {
  const observed: ObservedInvocation[] = [];
  let extensionSignal: AbortSignal | undefined;
  let reactionFactoryCalls = 0;

  // The fictional extension: a plain manifest whose Reactions contribution is
  // authored purely against @makaio/contracts — no product-domain types.
  const demoNotifier: KernelMakaioExtension = {
    name: 'demo-notifier',
    displayName: 'Demo Notifier',
    version: '0.1.0',
    reactions: {
      createReactions: (ctx) => {
        reactionFactoryCalls += 1;
        extensionSignal = ctx.signal;
        return [
          defineReaction({
            kind: KIND,
            description: 'Notifies the owning user about a host-selected event.',
            parameterSchema: z.object({ channel: z.string(), message: z.string() }),
            handler: async (parameters, context) => {
              observed.push({ parameters, context });
            },
          }),
        ];
      },
    },
  };

  const coordinator = new ExtensionCoordinator(createBusInstance(), { extensionContextBase: TEST_PKG_CTX_BASE });
  coordinator.registerContributionProcessor(
    createReactionContributionProcessor({
      forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
    }),
  );
  // Registry first: extensions with reactions resolve it via getService during
  // their own activation, exactly as in the production boot order.
  coordinator.load([reactionRegistryPackage, demoNotifier]);
  await coordinator.startAll();

  const registry = coordinator.getExtensionService(ReactionRegistryToken);
  if (!registry) {
    throw new Error('ReactionRegistry service did not start');
  }
  return {
    coordinator,
    registry,
    observed,
    reactionFactoryCalls: () => reactionFactoryCalls,
    extensionSignal: () => extensionSignal,
  };
}

describe('Reaction extension acceptance (real coordinator lifecycle)', () => {
  it('invokes a Reaction contributed by a non-product extension with the host-supplied envelope', async () => {
    const harness = await bootHarness();
    const ruleRef = createReactionRuleRef({ ruleId: 'rule-42' });
    const eventPayload = { issueNumber: 7 };
    const hostContext = { hostId: 'host-1' };

    const outcome = await harness.registry.invoke(
      KIND,
      { channel: 'owner', message: 'build finished' },
      { eventKind: 'demo.event', eventPayload, hostContext, ruleRef, correlationId: 'corr-1' },
    );

    expect(outcome).toEqual({ success: true });
    expect(harness.observed).toHaveLength(1);
    const invocation = harness.observed[0]!;
    expect(invocation.parameters).toEqual({ channel: 'owner', message: 'build finished' });
    expect(invocation.context.eventKind).toBe('demo.event');
    expect(invocation.context.eventPayload).toBe(eventPayload);
    expect(invocation.context.hostContext).toBe(hostContext);
    expect(invocation.context.ruleRef).toBe(ruleRef);
    expect(invocation.context.correlationId).toBe('corr-1');

    await harness.coordinator.shutdown();
  });

  it('stops resolving the kind after the extension is disabled through the coordinator', async () => {
    const harness = await bootHarness();

    await harness.coordinator.handleSetEnabled('demo-notifier', false);

    const outcome = await harness.registry.invoke(
      KIND,
      { channel: 'owner', message: 'late dispatch' },
      { eventKind: 'demo.event', eventPayload: {}, hostContext: {} },
    );
    expect(outcome).toEqual({
      success: false,
      error: { message: `Reaction kind '${KIND}' is not registered` },
    });
    expect(harness.observed).toHaveLength(0);

    await harness.coordinator.shutdown();
  });

  it('restores an active contributor exactly once when the registry is re-enabled', async () => {
    const harness = await bootHarness();

    await harness.coordinator.handleSetEnabled(ReactionRegistryToken.name, false);
    await harness.coordinator.handleSetEnabled(ReactionRegistryToken.name, true);

    const restoredRegistry = harness.coordinator.getExtensionService(ReactionRegistryToken);
    if (!restoredRegistry) {
      throw new Error('ReactionRegistry service did not restart');
    }
    expect(harness.reactionFactoryCalls()).toBe(2);
    expect(restoredRegistry.listDescriptors().map((descriptor) => descriptor.kind)).toEqual([KIND]);
    await expect(
      restoredRegistry.invoke(
        KIND,
        { channel: 'owner', message: 're-enabled' },
        { eventKind: 'demo.event', eventPayload: {}, hostContext: {} },
      ),
    ).resolves.toEqual({ success: true });
    expect(harness.observed).toHaveLength(1);

    await harness.coordinator.shutdown();
  });

  it('removes a replayed contributor when its queued disable follows an async replay factory', async () => {
    const replayFactoryEntered = Promise.withResolvers<void>();
    const releaseReplayFactory = Promise.withResolvers<void>();
    let factoryCalls = 0;
    let handlerCalls = 0;
    const demoNotifier: KernelMakaioExtension = {
      name: 'demo-notifier',
      displayName: 'Demo Notifier',
      version: '0.1.0',
      reactions: {
        createReactions: async () => {
          factoryCalls += 1;
          if (factoryCalls === 2) {
            replayFactoryEntered.resolve();
            await releaseReplayFactory.promise;
          }
          return [
            defineReaction({
              kind: KIND,
              description: 'Notifies the owning user about a host-selected event.',
              parameterSchema: z.object({ channel: z.string(), message: z.string() }),
              handler: async () => {
                handlerCalls += 1;
              },
            }),
          ];
        },
      },
    };
    const coordinator = new ExtensionCoordinator(createBusInstance(), { extensionContextBase: TEST_PKG_CTX_BASE });
    coordinator.registerContributionProcessor(
      createReactionContributionProcessor({
        forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
      }),
    );
    coordinator.load([reactionRegistryPackage, demoNotifier]);
    await coordinator.startAll();

    await coordinator.handleSetEnabled(ReactionRegistryToken.name, false);
    const reenabling = coordinator.handleSetEnabled(ReactionRegistryToken.name, true);
    await replayFactoryEntered.promise;

    let disableSettled = false;
    const disabling = coordinator.handleSetEnabled('demo-notifier', false).finally(() => {
      disableSettled = true;
    });
    await Promise.resolve();
    expect(disableSettled).toBe(false);

    releaseReplayFactory.resolve();
    await expect(reenabling).resolves.toBe(true);
    await expect(disabling).resolves.toBe(true);

    const registry = coordinator.getExtensionService(ReactionRegistryToken);
    if (!registry) {
      throw new Error('ReactionRegistry service did not restart');
    }
    await expect(
      registry.invoke(
        KIND,
        { channel: 'owner', message: 'must not reach stopped contributor' },
        { eventKind: 'demo.event', eventPayload: {}, hostContext: {} },
      ),
    ).resolves.toEqual({
      success: false,
      error: { message: `Reaction kind '${KIND}' is not registered` },
    });
    expect(handlerCalls).toBe(0);

    await coordinator.shutdown();
  });

  it('hands the handler a per-invocation signal distinct from the extension shutdown signal', async () => {
    const harness = await bootHarness();
    const shutdownSignal = harness.extensionSignal();
    expect(shutdownSignal).toBeInstanceOf(AbortSignal);

    // Layer the extension-wide shutdown signal UNDER the invocation the way a
    // host would; the handler must still observe a runtime-owned signal.
    const outcome = await harness.registry.invoke(
      KIND,
      { channel: 'owner', message: 'signal check' },
      { eventKind: 'demo.event', eventPayload: {}, hostContext: {}, hostSignal: shutdownSignal },
    );

    expect(outcome).toEqual({ success: true });
    const invocationSignal = harness.observed[0]!.context.signal;
    expect(invocationSignal).toBeInstanceOf(AbortSignal);
    expect(invocationSignal).not.toBe(shutdownSignal);

    await harness.coordinator.shutdown();
  });
});
