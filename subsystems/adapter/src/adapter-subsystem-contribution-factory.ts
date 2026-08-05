import { dep } from '@makaio/contracts';
import type { ContributionProcessor, KernelMakaioExtension } from '@makaio/kernel';
import { ADAPTER_SUBSYSTEM_PACKAGE_NAME } from '@makaio/services-core/adapter-subsystem';
import type { AdapterSubsystemService } from './adapter-subsystem-service.js';

/**
 * Whether a package's contributions are processed by the adapter subsystem.
 *
 * The single definition of "adapter-contributing", shared by the processor that
 * consumes such a package and the ordering helper that has to start the
 * subsystem before it.
 * @param pkg - Package manifest to classify.
 * @returns `true` when the package contributes adapters or providers.
 */
export function contributesToAdapterSubsystem(pkg: KernelMakaioExtension): boolean {
  return !!pkg.adapters?.length || !!pkg.providers?.length;
}

/**
 * Declare the adapter subsystem as a dependency of every adapter contributor.
 *
 * The contribution processor resolves the subsystem service **eagerly** when a
 * contributing package activates, so such a package starting first is a hard
 * failure. That ordering used to hold by accident of the load list, which is not
 * something a package graph may rest on: any dependency added anywhere can move
 * the subsystem later, and a contributed adapter is discovered code that cannot
 * be asked to declare a framework package it never names.
 *
 * The composition root that installs the processor is therefore the party that
 * states the ordering, once, for whatever it loads.
 *
 * **No self-dependency guard, deliberately.** The subsystem's own package
 * declares neither `adapters` nor `providers`, so {@link
 * contributesToAdapterSubsystem} answers `false` for it and it is returned
 * untouched — a self-dependency is not something this can produce. A guard here
 * would be a check against a state the classifier already excludes, and it would
 * quietly absorb the real defect if the subsystem package ever *did* start
 * contributing, which is a graph problem that should be loud.
 * @param packages - Load set to stamp.
 * @returns The same packages, contributors carrying the subsystem dependency.
 */
export function orderAfterAdapterSubsystem<T extends KernelMakaioExtension>(packages: readonly T[]): T[] {
  return packages.map((pkg) => {
    if (!contributesToAdapterSubsystem(pkg)) return pkg;
    const dependencies = pkg.dependencies ?? [];
    if (dependencies.some((dependency) => dependency.name === ADAPTER_SUBSYSTEM_PACKAGE_NAME)) return pkg;
    return { ...pkg, dependencies: [...dependencies, dep(ADAPTER_SUBSYSTEM_PACKAGE_NAME)] };
  });
}

/**
 * Dependencies for the adapter subsystem contribution processor factory.
 */
export interface AdapterSubsystemContributionProcessorDeps {
  /**
   * Resolve the live adapter subsystem service at activation or teardown time.
   *
   * The service is resolved lazily because coordinator-managed services do not
   * exist until their package has been started. The getter returns `undefined`
   * when the service has not yet started or has already been destroyed.
   */
  readonly getAdapterSubsystemService: () => AdapterSubsystemService | undefined;
}

/**
 * Create the adapter contribution processor registered by the composition root.
 *
 * The processor is registered before `coordinator.startAll()` so adapter
 * contributions run before log-import/tool/host contribution processors.
 * The service itself is resolved lazily because coordinator-managed services
 * do not exist until their package has been started.
 * @param deps - Lazy service resolver supplied by the composition root.
 * @returns Awaited contribution processor for adapter packages.
 */
export function createAdapterSubsystemContributionProcessor(
  deps: AdapterSubsystemContributionProcessorDeps,
): ContributionProcessor {
  return {
    filter: contributesToAdapterSubsystem,

    async processActivated(name, pkg, ctx) {
      const service = deps.getAdapterSubsystemService();
      if (!service) {
        throw new Error(
          'AdapterSubsystemService is not available. Ensure the adapter subsystem package starts before adapter-contributing packages.',
        );
      }
      await service.processAdapterContributions(name, pkg, ctx);
    },

    async processStopped(name) {
      const service = deps.getAdapterSubsystemService();
      if (!service) return;
      await service.stopAdapterContributions(name);
    },
  };
}
