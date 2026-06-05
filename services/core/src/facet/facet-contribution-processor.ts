import type { ContributionProcessor } from '@makaio/kernel';
import type { FacetNamespaceRegistration } from '@makaio/contracts/facet';
import { FacetNamespaceRegistryToken } from '../framework-packages.js';
import type { FacetNamespaceRegistry } from './facet-namespace-registry.js';

interface ActiveFacetNamespaceContribution {
  /** Registry instance that owns these registrations. */
  readonly registry: FacetNamespaceRegistry;
  /** Concrete namespace records contributed by the active package. */
  readonly registrations: readonly FacetNamespaceRegistration[];
}

/**
 * Re-register every active facet namespace for a registry after a stop removes
 * keys that another active extension may also own.
 * @param activeContributions - Active package contributions keyed by package name.
 * @param registry - Registry whose active registrations should be restored.
 */
function rebuildActiveRegistrations(
  activeContributions: ReadonlyMap<string, ActiveFacetNamespaceContribution>,
  registry: FacetNamespaceRegistry,
): void {
  for (const contribution of activeContributions.values()) {
    if (contribution.registry !== registry) continue;
    for (const registration of contribution.registrations) {
      registry.registerNamespace(registration);
    }
  }
}

/**
 * Create a framework-owned processor for `MakaioExtension.facetNamespaces`.
 *
 * Iterates over each declared {@link FacetNamespaceDefinition} and registers
 * it directly with the {@link FacetNamespaceRegistry} service. Missing registry
 * is a hard composition error — ensure `facetNamespaceRegistryPackage` is
 * started before extensions that declare facet namespaces.
 * @returns Awaited contribution processor for facet namespace contributions.
 */
export function createFacetNamespaceContributionProcessor(): ContributionProcessor {
  const activeContributions = new Map<string, ActiveFacetNamespaceContribution>();

  const restoreContribution = (name: string, contribution: ActiveFacetNamespaceContribution | undefined): void => {
    if (!contribution) return;
    for (const registration of contribution.registrations) {
      contribution.registry.registerNamespace(registration);
    }
    activeContributions.set(name, contribution);
  };

  const stopContribution = (name: string): void => {
    const contribution = activeContributions.get(name);
    if (!contribution) return;
    activeContributions.delete(name);

    for (let index = contribution.registrations.length - 1; index >= 0; index -= 1) {
      const registration = contribution.registrations[index]!;
      contribution.registry.deregisterNamespace(registration.namespace);
    }
    rebuildActiveRegistrations(activeContributions, contribution.registry);
  };

  return {
    filter: (pkg) => (pkg.facetNamespaces?.namespaces?.length ?? 0) > 0,

    async processActivated(name, pkg, ctx) {
      // Contribution processors run inside the ExtensionCoordinator lifecycle.
      // They use the registry service directly so activation rollback and
      // processStopped can remove package-owned entries; public consumers cross
      // this boundary through the FacetSubjects bus RPCs.
      const registry = ctx.getService(FacetNamespaceRegistryToken);
      if (!registry) {
        throw new Error(
          'FacetNamespaceRegistry is not available — ensure facet-namespace-registry is started before extensions with facetNamespaces.',
        );
      }

      const registrations = (pkg.facetNamespaces?.namespaces ?? []).map((definition) => definition.toRegistration());
      const previousContribution = activeContributions.get(name);
      stopContribution(name);
      const registered: FacetNamespaceRegistration[] = [];
      try {
        for (const registration of registrations) {
          registry.registerNamespace(registration);
          registered.push(registration);
        }
      } catch (error) {
        for (let index = registered.length - 1; index >= 0; index -= 1) {
          registry.deregisterNamespace(registered[index]!.namespace);
        }
        rebuildActiveRegistrations(activeContributions, registry);
        restoreContribution(name, previousContribution);
        throw error;
      }
      activeContributions.set(name, { registry, registrations });
    },

    async processStopped(name) {
      try {
        stopContribution(name);
      } catch (error) {
        console.error(`[FacetNamespaceContributionProcessor] Deregister error for "${name}":`, error);
      }
    },
  };
}
