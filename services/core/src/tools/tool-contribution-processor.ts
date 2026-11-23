import type { ContributionProcessor } from '@makaio/kernel';
import { ToolRegistryToken } from '../framework-packages.js';

/**
 * Create a framework-owned processor for `MakaioExtension.tools`.
 *
 * Toolsets are registered sequentially so failures have deterministic rollback.
 * Missing ToolRegistry is a hard composition error.
 * @returns Awaited contribution processor for tool contributions.
 */
export function createToolContributionProcessor(): ContributionProcessor {
  const cleanups = new Map<string, Array<() => Promise<void>>>();

  return {
    filter: (pkg) => !!pkg.tools?.createToolsets,

    /**
     * Register toolsets with the carrier of the extension that contributed them.
     * @param name - Activated extension name.
     * @param pkg - Activated extension package.
     * @param ctx - Runtime context of the contributing extension.
     */
    async processActivated(name, pkg, ctx) {
      const toolRegistry = ctx.getService(ToolRegistryToken);
      if (!toolRegistry) {
        throw new Error(
          'ToolRegistry is not available. Ensure toolRegistryPackage is included in the composition root.',
        );
      }

      const toolsets = pkg.tools!.createToolsets(ctx);
      const registered: Array<() => Promise<void>> = [];

      try {
        for (const toolset of toolsets) {
          await toolRegistry.register(toolset, { bus: ctx.bus });
          registered.push(() => toolRegistry.deregister(toolset.metadata.name));
        }
      } catch (error) {
        for (let index = registered.length - 1; index >= 0; index -= 1) {
          try {
            await registered[index]!();
          } catch (rollbackError) {
            console.error(`[ToolContributionProcessor] Rollback error for "${name}":`, rollbackError);
          }
        }
        throw error;
      }

      cleanups.set(name, registered);
    },

    async processStopped(name) {
      const registered = cleanups.get(name);
      if (!registered) return;

      for (let index = registered.length - 1; index >= 0; index -= 1) {
        try {
          await registered[index]!();
        } catch (error) {
          console.error(`[ToolContributionProcessor] Deregister error for "${name}":`, error);
        }
      }
      cleanups.delete(name);
    },
  };
}
