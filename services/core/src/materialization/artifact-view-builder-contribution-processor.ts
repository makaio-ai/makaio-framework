import type { ContributionProcessor } from '@makaio/kernel';
import { ArtifactViewBuilderRegistryToken } from './packages.js';
import type { ArtifactViewBuilderRegistry } from './artifact-view-builder-registry.js';

/**
 * Create the processor for `MakaioExtension.artifactViewBuilders`
 * contributions.
 *
 * For each activating extension, this processor:
 * 1. Resolves the `ArtifactViewBuilderRegistry` service from the context.
 * 2. Calls `createBuilders()` on the extension contribution.
 * 3. Registers the returned builders via `replaceBuildersForOwner` using
 *    the extension name as the owner key.
 *
 * On stop, it calls `removeBuildersForOwner` to clean up. On
 * reactivation (same extension name), `replaceBuildersForOwner`
 * atomically replaces the previous set.
 *
 * A missing registry is a hard composition error — ensure
 * `artifactViewBuilderRegistryPackage` is started before extensions that
 * declare artifact view builders.
 * @returns Awaited contribution processor for artifact view builder contributions.
 */
export function createArtifactViewBuilderContributionProcessor(): ContributionProcessor {
  const activeContributions = new Map<string, ArtifactViewBuilderRegistry>();

  return {
    filter: (pkg) => pkg.artifactViewBuilders != null,

    async processActivated(name, pkg, ctx) {
      const contribution = pkg.artifactViewBuilders;
      if (!contribution) return;
      const registry = ctx.getService(ArtifactViewBuilderRegistryToken);
      if (!registry) {
        throw new Error(
          'ArtifactViewBuilderRegistry is not available — ensure artifact-view-builder-registry is started before extensions with artifact view builders.',
        );
      }

      const builders = await contribution.createBuilders();

      // replaceBuildersForOwner is atomic: it validates the entire incoming
      // set, builds a candidate global index, and only swaps state after
      // the full candidate validates. If it throws, prior state is intact.
      // It also handles same-owner replacement natively (excludes the
      // current owner from collision checks), so no pre-removal is needed.
      registry.replaceBuildersForOwner(name, builders);
      activeContributions.set(name, registry);
    },

    async processStopped(name) {
      const registry = activeContributions.get(name);
      if (!registry) return;
      activeContributions.delete(name);

      // removeBuildersForOwner cannot throw: it deletes the owner entry and
      // rebuilds the global index from the remaining collision-free owners.
      registry.removeBuildersForOwner(name);
    },
  };
}
