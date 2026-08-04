import type { ContributionProcessor, KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import { ReactionRegistryToken } from './packages.js';

/** Runtime hooks used to replay contributions after registry activation. */
export interface ReactionContributionProcessorOptions {
  /**
   * Enumerate active extensions in dependency order.
   *
   * The registry can be enabled after an extension contributing Reactions is
   * already active, so it replays those active contributors after startup.
   * @param callback - Called for each active extension and its context.
   */
  readonly forEachActiveExtension: (
    callback: (name: string, pkg: KernelMakaioExtension, ctx: KernelExtensionContext) => void,
  ) => void;
}

/**
 * Processes Reaction contributions from extensions.
 *
 * Calls each extension's `reactions.createReactions(ctx)` factory during
 * activation and registers the returned definitions with the
 * {@link ReactionRegistry} under the extension name; deregisters them when the
 * extension stops.
 *
 * Contributor activation is atomic: if `createReactions` or the registry
 * replacement throws, the existing registration and its cleanup remain
 * intact. Failed registry-owner replay clears its cleanup ownership because
 * the coordinator destroys that registry service before a later retry.
 * @param options - Runtime hooks used for late registry-owner activation.
 * @returns Contribution processor that manages Reaction registration.
 */
export function createReactionContributionProcessor(
  options: ReactionContributionProcessorOptions,
): ContributionProcessor {
  const cleanups = new Map<string, () => void>();

  const stopContribution = (name: string): void => {
    const cleanup = cleanups.get(name);
    if (!cleanup) return;
    cleanups.delete(name);
    cleanup();
  };

  const registerContribution = async (
    name: string,
    pkg: KernelMakaioExtension,
    ctx: KernelExtensionContext,
  ): Promise<void> => {
    const contribution = pkg.reactions;
    if (!contribution) return;

    const registry = ctx.getService(ReactionRegistryToken);
    if (!registry) {
      throw new Error(
        'ReactionRegistry is not available — ensure reaction-registry is started before extensions with reactions.',
      );
    }

    // The contracts factory signature accepts sync or async returns; the
    // ctx alias (ReactionContributionContext) is the host extension context
    // passed through as-is.
    const reactions = await contribution.createReactions(ctx);

    // Coordinator lifecycle transitions share one FIFO lane. A disable
    // admitted while this asynchronous factory is pending therefore cannot
    // run between its settlement and registration: it follows this complete
    // activation and deregisters the just-installed batch.
    registry.register(name, reactions);
    cleanups.set(name, () => registry.deregister(name));
  };

  return {
    filter: (pkg) => pkg.name === ReactionRegistryToken.name || !!pkg.reactions,

    async processActivated(name, pkg, ctx) {
      if (name === ReactionRegistryToken.name) {
        const activeContributors: Array<[string, KernelMakaioExtension, KernelExtensionContext]> = [];
        options.forEachActiveExtension((activeName, activePkg, activeCtx) => {
          if (activePkg.reactions) {
            activeContributors.push([activeName, activePkg, activeCtx]);
          }
        });
        try {
          for (const [activeName, activePkg, activeCtx] of activeContributors) {
            await registerContribution(activeName, activePkg, activeCtx);
          }
        } catch (error) {
          cleanups.clear();
          throw error;
        }
        return;
      }

      await registerContribution(name, pkg, ctx);
    },

    async processStopped(name) {
      if (name === ReactionRegistryToken.name) {
        cleanups.clear();
        return;
      }
      try {
        stopContribution(name);
      } catch (error) {
        console.error(`[ReactionContributionProcessor] Deregister error for "${name}":`, error);
      }
    },
  };
}
