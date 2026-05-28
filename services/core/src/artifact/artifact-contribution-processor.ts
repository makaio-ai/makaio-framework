import type { ContributionProcessor } from '@makaio/kernel';
import type { ArtifactKindRegistration } from '@makaio/contracts';
import { ArtifactSchemaRegistryToken } from '../framework-packages.js';
import type { ArtifactSchemaRegistry } from './artifact-schema-registry.js';

interface ActiveArtifactKindContribution {
  /** Registry instance that owns these registrations. */
  readonly registry: ArtifactSchemaRegistry;
  /** Concrete artifact kind records contributed by the active package. */
  readonly registrations: readonly ArtifactKindRegistration[];
}

/**
 * Re-register every active artifact kind for a registry after a stop removes
 * keys that another active extension may also own.
 * @param activeContributions - Active package contributions keyed by package name.
 * @param registry - Registry whose active registrations should be restored.
 */
function rebuildActiveRegistrations(
  activeContributions: ReadonlyMap<string, ActiveArtifactKindContribution>,
  registry: ArtifactSchemaRegistry,
): void {
  for (const contribution of activeContributions.values()) {
    if (contribution.registry !== registry) continue;
    for (const registration of contribution.registrations) {
      registry.registerKind(registration);
    }
  }
}

/**
 * Create a framework-owned processor for `MakaioExtension.artifactKinds`.
 *
 * Iterates over each declared {@link AnyArtifactKindDefinition} and registers
 * it with the {@link ArtifactSchemaRegistry}. Missing registry is a hard
 * composition error — ensure
 * `artifactSchemaRegistryPackage` is started before extensions that declare
 * artifact kinds.
 * @returns Awaited contribution processor for artifact kind contributions.
 */
export function createArtifactKindContributionProcessor(): ContributionProcessor {
  const activeContributions = new Map<string, ActiveArtifactKindContribution>();

  const stopContribution = (name: string): void => {
    const contribution = activeContributions.get(name);
    if (!contribution) return;
    activeContributions.delete(name);

    for (let index = contribution.registrations.length - 1; index >= 0; index -= 1) {
      const registration = contribution.registrations[index]!;
      contribution.registry.deregisterKind(registration.kind, registration.schemaVersion);
    }
    rebuildActiveRegistrations(activeContributions, contribution.registry);
  };

  return {
    filter: (pkg) => (pkg.artifactKinds?.kinds?.length ?? 0) > 0,

    async processActivated(name, pkg, ctx) {
      const registry = ctx.getService(ArtifactSchemaRegistryToken);
      if (!registry) {
        throw new Error(
          'ArtifactSchemaRegistry is not available — ensure artifact-schema-registry is started before extensions with artifactKinds.',
        );
      }

      const registrations = (pkg.artifactKinds?.kinds ?? []).map((kindDef) => kindDef.toRegistration());
      stopContribution(name);
      for (const registration of registrations) {
        registry.registerKind(registration);
      }
      activeContributions.set(name, { registry, registrations });
    },

    async processStopped(name) {
      try {
        stopContribution(name);
      } catch (error) {
        console.error(`[ArtifactContributionProcessor] Deregister error for "${name}":`, error);
      }
    },
  };
}
