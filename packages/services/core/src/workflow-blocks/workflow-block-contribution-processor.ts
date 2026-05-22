import type { ContributionProcessor } from '@makaio/kernel';
import { WorkflowBlockRegistryToken } from '../framework-packages.js';

/**
 * Processes workflow block contributions from extensions.
 *
 * Registers and deregisters blocks with the {@link WorkflowBlockRegistry}
 * as extensions activate and stop.
 * @returns Contribution processor that manages workflow block registration.
 */
export function createWorkflowBlockContributionProcessor(): ContributionProcessor {
  const cleanups = new Map<string, () => Promise<void>>();

  return {
    filter: (pkg) => !!pkg.workflowBlocks?.blocks,

    async processActivated(name, pkg, ctx) {
      const registry = ctx.getService(WorkflowBlockRegistryToken);
      if (!registry) {
        throw new Error(
          'WorkflowBlockRegistry is not available — ensure workflow-block-registry is started before extensions with workflowBlocks.',
        );
      }
      await registry.register(name, pkg.workflowBlocks!.blocks);
      cleanups.set(name, () => registry.deregister(name));
    },

    async processStopped(name) {
      const cleanup = cleanups.get(name);
      if (!cleanup) return;
      try {
        await cleanup();
      } catch (error) {
        console.error(`[WorkflowBlockContributionProcessor] Deregister error for "${name}":`, error);
      }
      cleanups.delete(name);
    },
  };
}
