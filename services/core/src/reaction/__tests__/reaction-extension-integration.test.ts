import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { defineReaction } from '@makaio/contracts';
import type { ReactionExecutionContext } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { ExtensionCoordinator } from '@makaio/kernel';
import type { ExtensionContextBase, KernelMakaioExtension } from '@makaio/kernel';
import { ReactionRegistryToken, reactionRegistryPackage } from '../packages.js';
import type { ReactionRegistry } from '../reaction-registry.js';
import { createReactionContributionProcessor } from '../reaction-contribution-processor.js';
import { makeTestCause, makeTestInvocationInput } from './reaction-test-fixtures.js';
import { useJournalHostFixture } from '@makaio/storage-conformance';

const { constructContext } = useJournalHostFixture();

/**
 * Minimal {@link KernelExtensionContext} fields (excluding coordinator-owned
 * and bus-owned fields) for test coordinators.
 */
const TEST_PKG_CTX_BASE: ExtensionContextBase = {
  constructContext,
  platform: 'linux',
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async (_specifier) => null,
};

/** Everything one handler run observed, captured for assertions. */
interface ObservedInvocation {
  /** Call context the handler received. */
  readonly call: CallContext;
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
            keyed: false,
            handler: async (call, parameters, context) => {
              observed.push({ call, parameters, context });
              return { state: 'accepted' };
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

  const registry = coordinator.getExtensionService<ReactionRegistry>(ReactionRegistryToken.name);
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
    const bus = createBusInstance();
    const cause = makeTestCause({ ruleId: 'rule-42' });

    const outcome = await harness.registry.invoke(
      KIND,
      { channel: 'owner', message: 'build finished' },
      makeTestInvocationInput(bus, { key: 'rule-42:occasion-7', cause, correlationId: 'corr-1' }),
    );

    expect(outcome).toEqual({ state: 'accepted' });
    expect(harness.observed).toHaveLength(1);
    const invocation = harness.observed[0]!;
    expect(invocation.parameters).toEqual({ channel: 'owner', message: 'build finished' });
    expect(invocation.context.key).toBe('rule-42:occasion-7');
    expect(invocation.context.cause).toBe(cause);
    expect(invocation.context.correlationId).toBe('corr-1');

    await harness.coordinator.shutdown();
  });

  it('stops resolving the kind after the extension is disabled through the coordinator', async () => {
    const harness = await bootHarness();
    const bus = createBusInstance();

    await harness.coordinator.applyExtensionTransition('demo-notifier', false);

    const outcome = await harness.registry.invoke(
      KIND,
      { channel: 'owner', message: 'late dispatch' },
      makeTestInvocationInput(bus),
    );
    expect(outcome).toEqual({
      state: 'failed',
      code: 'unknown-reaction',
      reason: `Reaction kind '${KIND}' is not registered`,
    });
    expect(harness.observed).toHaveLength(0);

    await harness.coordinator.shutdown();
  });

  it('restores an active contributor exactly once when the registry is re-enabled', async () => {
    const harness = await bootHarness();
    const bus = createBusInstance();

    await harness.coordinator.applyExtensionTransition(ReactionRegistryToken.name, false);
    await harness.coordinator.applyExtensionTransition(ReactionRegistryToken.name, true);

    const restoredRegistry = harness.coordinator.getExtensionService<ReactionRegistry>(ReactionRegistryToken.name);
    if (!restoredRegistry) {
      throw new Error('ReactionRegistry service did not restart');
    }
    expect(harness.reactionFactoryCalls()).toBe(2);
    expect(restoredRegistry.listDescriptors().map((descriptor) => descriptor.kind)).toEqual([KIND]);
    await expect(
      restoredRegistry.invoke(KIND, { channel: 'owner', message: 're-enabled' }, makeTestInvocationInput(bus)),
    ).resolves.toEqual({ state: 'accepted' });
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
              keyed: false,
              handler: async () => {
                handlerCalls += 1;
                return { state: 'accepted' };
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

    await coordinator.applyExtensionTransition(ReactionRegistryToken.name, false);
    const reenabling = coordinator.applyExtensionTransition(ReactionRegistryToken.name, true);
    await replayFactoryEntered.promise;

    let disableSettled = false;
    const disabling = coordinator.applyExtensionTransition('demo-notifier', false).finally(() => {
      disableSettled = true;
    });
    await Promise.resolve();
    expect(disableSettled).toBe(false);

    releaseReplayFactory.resolve();
    await expect(reenabling).resolves.toBe('applied');
    await expect(disabling).resolves.toBe('applied');

    const registry = coordinator.getExtensionService<ReactionRegistry>(ReactionRegistryToken.name);
    if (!registry) {
      throw new Error('ReactionRegistry service did not restart');
    }
    const bus = createBusInstance();
    await expect(
      registry.invoke(
        KIND,
        { channel: 'owner', message: 'must not reach stopped contributor' },
        makeTestInvocationInput(bus),
      ),
    ).resolves.toEqual({
      state: 'failed',
      code: 'unknown-reaction',
      reason: `Reaction kind '${KIND}' is not registered`,
    });
    expect(handlerCalls).toBe(0);

    await coordinator.shutdown();
  });

  it('hands the handler a per-invocation signal distinct from the extension shutdown signal', async () => {
    const harness = await bootHarness();
    const bus = createBusInstance();
    const shutdownSignal = harness.extensionSignal();
    expect(shutdownSignal).toBeInstanceOf(AbortSignal);

    // Layer the extension-wide shutdown signal UNDER the invocation the way a
    // host would; the handler must still observe a runtime-owned signal.
    const outcome = await harness.registry.invoke(
      KIND,
      { channel: 'owner', message: 'signal check' },
      makeTestInvocationInput(bus, { hostSignal: shutdownSignal }),
    );

    expect(outcome).toEqual({ state: 'accepted' });
    const invocationSignal = harness.observed[0]!.context.signal;
    expect(invocationSignal).toBeInstanceOf(AbortSignal);
    expect(invocationSignal).not.toBe(shutdownSignal);

    await harness.coordinator.shutdown();
  });
});
