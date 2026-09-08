import type { ContributionProcessor } from '@makaio/kernel';
import type { ArtifactLifecycleHookRegistration } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import { ArtifactLifecycleHookRegistryToken } from '../framework-packages.js';

/** Cleanup state tracked per active extension. */
interface ActiveHookContribution {
  /** Cleanup function returned by the registry's `registerHooks` call. */
  readonly cleanup: () => void;
}

/**
 * Bind a hook declared on an artifact kind definition to that owning kind.
 *
 * Kind-local hooks are authored inside a single kind definition, so the kind
 * declaration owns the kind/schemaVersion filter even when the hook omitted or
 * attempted to widen it.
 * @param kind - Owning artifact kind discriminator.
 * @param schemaVersion - Owning artifact schema version.
 * @param hook - Hook registration declared by the kind definition.
 * @returns Hook registration with an owner-enforced kind/schema filter.
 */
function scopeHookToKindDefinition(
  kind: string,
  schemaVersion: number,
  hook: ArtifactLifecycleHookRegistration<IMakaioBus>,
): ArtifactLifecycleHookRegistration<IMakaioBus> {
  return {
    ...hook,
    filter: {
      ...hook.filter,
      kind,
      schemaVersion,
    },
  };
}

/**
 * Create a framework-owned processor for `MakaioExtension.artifactLifecycleHooks`
 * and for live hooks declared on artifact kind definitions.
 *
 * For each activating extension, this processor:
 * 1. Collects hooks from `artifactLifecycleHooks.createHooks(ctx)` (if present).
 * 2. Collects live hooks from every `artifactKinds.kinds[*].hooks.hooks` entry
 *    (if present).
 * 3. Registers the combined set with the artifact lifecycle hook registry
 *    under the extension name.
 *
 * A missing registry is a hard composition error — ensure
 * `artifactLifecycleHookRegistryPackage` is started before extensions that
 * declare artifact lifecycle hooks.
 * @returns Awaited contribution processor for artifact lifecycle hook contributions.
 */
export function createArtifactLifecycleHookContributionProcessor(): ContributionProcessor {
  const activeContributions = new Map<string, ActiveHookContribution>();

  const stopContribution = (name: string): void => {
    const contribution = activeContributions.get(name);
    if (!contribution) return;
    activeContributions.delete(name);
    contribution.cleanup();
  };

  return {
    filter: (pkg) => {
      const hasExtensionHooks = pkg.artifactLifecycleHooks != null;
      const hasKindHooks = (pkg.artifactKinds?.kinds ?? []).some((k) => (k.hooks?.hooks.length ?? 0) > 0);
      return hasExtensionHooks || hasKindHooks;
    },

    async processActivated(name, pkg, ctx) {
      const registry = ctx.getService(ArtifactLifecycleHookRegistryToken);
      if (!registry) {
        throw new Error(
          'ArtifactLifecycleHookRegistry is not available — ensure artifact-lifecycle-hook-registry is started before extensions with artifact lifecycle hooks.',
        );
      }

      // Collect hooks from the extension-level contribution.
      const extensionHooks: ArtifactLifecycleHookRegistration<IMakaioBus>[] = pkg.artifactLifecycleHooks
        ? [...(await pkg.artifactLifecycleHooks.createHooks({ bus: ctx.bus, extensionName: name }))]
        : [];

      // Collect live hooks from artifact kind definitions.
      const kindHooks: ArtifactLifecycleHookRegistration<IMakaioBus>[] = [];
      for (const kindDef of pkg.artifactKinds?.kinds ?? []) {
        if (kindDef.hooks) {
          for (const h of kindDef.hooks.hooks) {
            kindHooks.push(
              scopeHookToKindDefinition(
                kindDef.kind,
                kindDef.schemaVersion,
                h as ArtifactLifecycleHookRegistration<IMakaioBus>,
              ),
            );
          }
        }
      }

      const allHooks: ArtifactLifecycleHookRegistration<IMakaioBus>[] = [...extensionHooks, ...kindHooks];

      stopContribution(name);
      const cleanup = registry.registerHooks(name, allHooks);
      activeContributions.set(name, { cleanup });
    },

    async processStopped(name) {
      try {
        stopContribution(name);
      } catch (error) {
        console.error(`[ArtifactLifecycleHookContributionProcessor] Deregister error for "${name}":`, error);
      }
    },
  };
}
