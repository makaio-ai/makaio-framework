import type { ContributionProcessor } from '@makaio/kernel';
import type { WorkerProviderRegistry } from './provider-registry.js';

/**
 * Register worker providers under the identity supplied by the coordinator.
 * @param registry - Host registry shared by dispatch and supervision.
 * @returns Processor for the activation and withdrawal of provider contributions.
 */
export function createWorkerProviderContributionProcessor(registry: WorkerProviderRegistry): ContributionProcessor {
  const activeContributions = new Map<string, () => void>();

  return {
    filter: (pkg) => pkg.workerProviders !== undefined,

    async processActivated(name, pkg, ctx) {
      const contribution = pkg.workerProviders;
      if (contribution === undefined) return;
      const batch = await contribution.createProviders(ctx);
      const withdraw = await registry.replace(ctx.bus.own('start'), { ...batch, owner: name }, ctx.signal);
      activeContributions.set(name, withdraw);
    },

    async processStopped(name) {
      const withdraw = activeContributions.get(name);
      activeContributions.delete(name);
      withdraw?.();
    },
  };
}
