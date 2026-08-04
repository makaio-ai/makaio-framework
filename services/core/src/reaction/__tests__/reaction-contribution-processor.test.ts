import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { defineReaction, type ExtensionToken, type ReactionDefinition } from '@makaio/contracts';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { ReactionRegistryToken, reactionRegistryPackage } from '../packages.js';
import { ReactionRegistry } from '../reaction-registry.js';
import { createReactionContributionProcessor } from '../reaction-contribution-processor.js';

function makeContext(registry?: ReactionRegistry): KernelExtensionContext {
  const bus = createBusInstance();
  return {
    bus,
    identity: {
      extensionName: 'alpha',
    } as KernelExtensionContext['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/extensions/alpha',
    username: 'test',
    machineId: 'machine-1',
    signal: new AbortController().signal,
    tryImport: async () => null,
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      (token.name === ReactionRegistryToken.name ? registry : undefined) as T | undefined,
    hasExtension: () => false,
  };
}

/**
 * Builds a Reaction definition namespaced under the given extension.
 * @param extensionName - Owning extension name used as the kind prefix.
 * @param reactionName - Reaction name appended to the extension prefix.
 * @param handler - Executable handler installed on the test Reaction.
 * @returns A minimal executable Reaction definition for processor tests.
 */
function makeReaction(
  extensionName: string,
  reactionName: string,
  handler: ReactionDefinition['handler'] = async () => {},
): ReactionDefinition {
  return defineReaction({
    kind: `${extensionName}.${reactionName}`,
    description: `Test Reaction ${reactionName} used by contribution processor tests.`,
    parameterSchema: z.object({ message: z.string() }),
    handler,
  });
}

/**
 * Builds an extension package contributing the given Reactions.
 * @param name - Extension name owning the contribution.
 * @param createReactions - Factory forwarded to the `reactions` surface.
 * @returns A kernel extension package with a Reactions contribution.
 */
function makePackage(
  name: string,
  createReactions: () => readonly ReactionDefinition[] | Promise<readonly ReactionDefinition[]>,
): KernelMakaioExtension {
  return {
    name,
    displayName: 'Alpha',
    version: '0.1.0',
    reactions: { createReactions },
  };
}

/** Host-supplied invocation input reused across dispatch assertions. */
const invocationInput = {
  eventKind: 'test.event',
  eventPayload: { value: 1 },
  hostContext: { hostId: 'host-1' },
} as const;

/** No-op active-extension iterator for tests that do not exercise replay. */
const forEachNoActiveExtension = (): void => {};

describe('createReactionContributionProcessor', () => {
  it('registers reactions on activation so they are invocable afterwards', async () => {
    const registry = new ReactionRegistry(createBusInstance());
    await registry.init();
    const processor = createReactionContributionProcessor({ forEachActiveExtension: forEachNoActiveExtension });

    await processor.processActivated(
      'alpha',
      makePackage('alpha', () => [makeReaction('alpha', 'notify')]),
      makeContext(registry),
    );

    const outcome = await registry.invoke('alpha.notify', { message: 'hi' }, invocationInput);
    expect(outcome).toEqual({ success: true });
    expect(registry.listDescriptors().map((descriptor) => descriptor.kind)).toEqual(['alpha.notify']);

    await registry.destroy();
  });

  it('ignores packages without a reactions contribution even when invoked directly', async () => {
    const processor = createReactionContributionProcessor({ forEachActiveExtension: forEachNoActiveExtension });
    const plainPackage = { name: 'plain', displayName: 'Plain', version: '0.1.0' } as const;

    expect(processor.filter!(plainPackage)).toBe(false);
    expect(processor.filter!(makePackage('alpha', () => []))).toBe(true);
    await expect(processor.processActivated('plain', plainPackage, makeContext())).resolves.toBeUndefined();
  });

  it('throws a hard composition error when the registry is missing', async () => {
    const processor = createReactionContributionProcessor({ forEachActiveExtension: forEachNoActiveExtension });

    await expect(
      processor.processActivated(
        'alpha',
        makePackage('alpha', () => []),
        makeContext(),
      ),
    ).rejects.toThrow('ReactionRegistry is not available');
  });

  it('supports async createReactions factories', async () => {
    const registry = new ReactionRegistry(createBusInstance());
    await registry.init();
    const processor = createReactionContributionProcessor({ forEachActiveExtension: forEachNoActiveExtension });

    await processor.processActivated(
      'alpha',
      makePackage('alpha', async () => [makeReaction('alpha', 'async-notify')]),
      makeContext(registry),
    );

    const outcome = await registry.invoke('alpha.async-notify', { message: 'hi' }, invocationInput);
    expect(outcome).toEqual({ success: true });

    await registry.destroy();
  });

  it('replays active async contributors when the registry activates', async () => {
    const registry = new ReactionRegistry(createBusInstance());
    await registry.init();
    const createReactions = vi.fn(async () => [makeReaction('alpha', 'async-replay')]);
    const activePackage = makePackage('alpha', createReactions);
    const processor = createReactionContributionProcessor({
      forEachActiveExtension: (callback) => {
        callback('alpha', activePackage, makeContext(registry));
      },
    });

    await processor.processActivated(ReactionRegistryToken.name, reactionRegistryPackage, makeContext(registry));

    expect(createReactions).toHaveBeenCalledTimes(1);
    await expect(registry.invoke('alpha.async-replay', { message: 'hi' }, invocationInput)).resolves.toEqual({
      success: true,
    });

    await registry.destroy();
  });

  it('clears replay cleanup ownership when a later active contributor fails', async () => {
    const registry = new ReactionRegistry(createBusInstance());
    await registry.init();
    const deregister = vi.spyOn(registry, 'deregister');
    const firstContributor = makePackage('alpha', () => [makeReaction('alpha', 'replay')]);
    const failingContributor = makePackage('beta', () => {
      throw new Error('beta factory exploded');
    });
    const processor = createReactionContributionProcessor({
      forEachActiveExtension: (callback) => {
        callback('alpha', firstContributor, makeContext(registry));
        callback('beta', failingContributor, makeContext(registry));
      },
    });

    await expect(
      processor.processActivated(ReactionRegistryToken.name, reactionRegistryPackage, makeContext(registry)),
    ).rejects.toThrow('beta factory exploded');
    await processor.processStopped?.('alpha');

    expect(deregister).not.toHaveBeenCalled();

    await registry.destroy();
  });

  it('propagates registry rejection and leaves nothing registered', async () => {
    // Registry-level rejection message specifics stay covered in
    // reaction-registry.test.ts; this asserts processor-level atomicity.
    const registry = new ReactionRegistry(createBusInstance());
    await registry.init();
    const processor = createReactionContributionProcessor({ forEachActiveExtension: forEachNoActiveExtension });

    await expect(
      processor.processActivated(
        'alpha',
        makePackage('alpha', () => [makeReaction('other', 'notify')]),
        makeContext(registry),
      ),
    ).rejects.toThrow("must be namespaced by extension 'alpha.'");
    expect(registry.listDescriptors()).toEqual([]);

    await registry.destroy();
  });

  it('propagates a throwing createReactions and leaves nothing registered', async () => {
    const registry = new ReactionRegistry(createBusInstance());
    await registry.init();
    const processor = createReactionContributionProcessor({ forEachActiveExtension: forEachNoActiveExtension });

    await expect(
      processor.processActivated(
        'alpha',
        makePackage('alpha', () => {
          throw new Error('factory exploded');
        }),
        makeContext(registry),
      ),
    ).rejects.toThrow('factory exploded');
    expect(registry.listDescriptors()).toEqual([]);

    await registry.destroy();
  });

  it('deregisters on stop, is idempotent, and ignores unknown names', async () => {
    const registry = new ReactionRegistry(createBusInstance());
    await registry.init();
    const processor = createReactionContributionProcessor({ forEachActiveExtension: forEachNoActiveExtension });

    await processor.processActivated(
      'alpha',
      makePackage('alpha', () => [makeReaction('alpha', 'notify')]),
      makeContext(registry),
    );
    await processor.processStopped?.('alpha');
    await processor.processStopped?.('alpha');
    await processor.processStopped?.('never-activated');

    const outcome = await registry.invoke('alpha.notify', { message: 'hi' }, invocationInput);
    expect(outcome.success).toBe(false);
    expect(registry.listDescriptors()).toEqual([]);

    await registry.destroy();
  });

  it('atomically replaces an owner batch on re-activation without stop', async () => {
    const registry = new ReactionRegistry(createBusInstance());
    await registry.init();
    const processor = createReactionContributionProcessor({ forEachActiveExtension: forEachNoActiveExtension });
    const firstHandler = vi.fn(async () => {});
    const replacementHandler = vi.fn(async () => {});
    const firstPackage = makePackage('alpha', () => [makeReaction('alpha', 'notify', firstHandler)]);
    const replacementPackage = makePackage('alpha', () => [makeReaction('alpha', 'log', replacementHandler)]);

    await processor.processActivated('alpha', firstPackage, makeContext(registry));
    await processor.processActivated('alpha', replacementPackage, makeContext(registry));

    await expect(registry.invoke('alpha.notify', { message: 'hi' }, invocationInput)).resolves.toMatchObject({
      success: false,
    });
    await expect(registry.invoke('alpha.log', { message: 'hi' }, invocationInput)).resolves.toEqual({ success: true });
    expect(firstHandler).not.toHaveBeenCalled();
    expect(replacementHandler).toHaveBeenCalledTimes(1);
    expect(registry.listDescriptors().map((descriptor) => descriptor.kind)).toEqual(['alpha.log']);

    await registry.destroy();
  });

  it('treats an empty contribution as a complete replacement with symmetric cleanup ownership', async () => {
    const registry = new ReactionRegistry(createBusInstance());
    await registry.init();
    const processor = createReactionContributionProcessor({ forEachActiveExtension: forEachNoActiveExtension });

    await processor.processActivated(
      'alpha',
      makePackage('alpha', () => [makeReaction('alpha', 'notify')]),
      makeContext(registry),
    );
    await processor.processActivated(
      'alpha',
      makePackage('alpha', () => []),
      makeContext(registry),
    );
    expect(registry.listDescriptors()).toEqual([]);

    // A later same-owner registration must still be removed when the
    // contributor stops, proving that the empty batch retained cleanup
    // ownership without asserting against a mocked implementation detail.
    registry.register('alpha', [makeReaction('alpha', 'replacement')]);
    await processor.processStopped?.('alpha');

    expect(registry.listDescriptors()).toEqual([]);

    await registry.destroy();
  });

  it('preserves the prior registration and cleanup when re-activation fails', async () => {
    const registry = new ReactionRegistry(createBusInstance());
    await registry.init();
    const processor = createReactionContributionProcessor({ forEachActiveExtension: forEachNoActiveExtension });
    const priorHandler = vi.fn(async () => {});

    await processor.processActivated(
      'alpha',
      makePackage('alpha', () => [makeReaction('alpha', 'notify', priorHandler)]),
      makeContext(registry),
    );
    await expect(
      processor.processActivated(
        'alpha',
        makePackage('alpha', () => [makeReaction('other', 'notify')]),
        makeContext(registry),
      ),
    ).rejects.toThrow("must be namespaced by extension 'alpha.'");

    await expect(registry.invoke('alpha.notify', { message: 'hi' }, invocationInput)).resolves.toEqual({
      success: true,
    });
    expect(priorHandler).toHaveBeenCalledTimes(1);
    await processor.processStopped?.('alpha');
    expect(registry.listDescriptors()).toEqual([]);

    await registry.destroy();
  });
});
