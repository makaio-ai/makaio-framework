import type { ContributionProcessor } from '@makaio/kernel';
import type { SurfaceBindingRegistration } from '@makaio/contracts/materialization';
import { SurfaceBindingRegistryToken } from './packages.js';
import type { SurfaceBindingRegistry } from './surface-binding-registry.js';

interface ActiveSurfaceBindingContribution {
  /** Registry instance that owns these registrations. */
  readonly registry: SurfaceBindingRegistry;
  /** Concrete surface binding records contributed by the active package. */
  readonly registrations: readonly SurfaceBindingRegistration[];
}

/**
 * Re-register every active surface binding for a registry after a stop removes
 * keys that another active extension may also own.
 * @param activeContributions - Active package contributions keyed by package name.
 * @param registry - Registry whose active registrations should be restored.
 */
function rebuildActiveRegistrations(
  activeContributions: ReadonlyMap<string, ActiveSurfaceBindingContribution>,
  registry: SurfaceBindingRegistry,
): void {
  for (const contribution of activeContributions.values()) {
    if (contribution.registry !== registry) continue;
    for (const registration of contribution.registrations) {
      registry.registerBinding(registration);
    }
  }
}

/**
 * Create a framework-owned processor for `MakaioExtension.surfaceBindings`.
 *
 * Iterates over each declared {@link SurfaceBindingDefinition} and registers
 * it directly with the {@link SurfaceBindingRegistry} service. Missing registry
 * is a hard composition error — ensure `surfaceBindingRegistryPackage` is
 * started before extensions that declare surface bindings.
 * @returns Awaited contribution processor for surface binding contributions.
 */
export function createSurfaceBindingContributionProcessor(): ContributionProcessor {
  const activeContributions = new Map<string, ActiveSurfaceBindingContribution>();

  const restoreContribution = (name: string, contribution: ActiveSurfaceBindingContribution | undefined): void => {
    if (!contribution) return;
    for (const registration of contribution.registrations) {
      contribution.registry.registerBinding(registration);
    }
    activeContributions.set(name, contribution);
  };

  const stopContribution = (name: string): void => {
    const contribution = activeContributions.get(name);
    if (!contribution) return;
    activeContributions.delete(name);

    for (let index = contribution.registrations.length - 1; index >= 0; index -= 1) {
      const registration = contribution.registrations[index]!;
      contribution.registry.deregisterBinding(registration.id);
    }
    rebuildActiveRegistrations(activeContributions, contribution.registry);
  };

  return {
    filter: (pkg) => (pkg.surfaceBindings?.bindings?.length ?? 0) > 0,

    async processActivated(name, pkg, ctx) {
      // Contribution processors run inside the ExtensionCoordinator lifecycle.
      // They use the registry service directly so activation rollback and
      // processStopped can remove package-owned entries; public consumers cross
      // this boundary through the MaterializationSubjects bus RPCs.
      const registry = ctx.getService(SurfaceBindingRegistryToken);
      if (!registry) {
        throw new Error(
          'SurfaceBindingRegistry is not available — ensure surface-binding-registry is started before extensions with surfaceBindings.',
        );
      }

      const registrations = (pkg.surfaceBindings?.bindings ?? []).map((definition) => definition.toRegistration());
      const previousContribution = activeContributions.get(name);
      stopContribution(name);
      const registered: SurfaceBindingRegistration[] = [];
      try {
        for (const registration of registrations) {
          registry.registerBinding(registration);
          registered.push(registration);
        }
      } catch (error) {
        for (let index = registered.length - 1; index >= 0; index -= 1) {
          registry.deregisterBinding(registered[index]!.id);
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
        console.error(`[SurfaceBindingContributionProcessor] Deregister error for "${name}":`, error);
      }
    },
  };
}
