import type { ContributionProcessor } from '@makaio/kernel';
import type { AdapterSubsystemService } from './adapter-subsystem-service.js';

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
    filter: (pkg) => !!pkg.adapters?.length || !!pkg.providers?.length,

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
