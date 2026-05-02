import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';

/**
 * Register middleware to resolve `adapterName` to `adapterId` for `getCapabilities` requests.
 *
 * Problem: Adapter handlers filter by `adapterId` only — name-only requests never reach handlers.
 * Solution: Middleware with priority 20 resolves `adapterName` through the
 * runtime identity seam before adapter handlers run.
 * @param bus - The bus instance to register the middleware on
 * @returns Cleanup function to unsubscribe the middleware
 */
export function registerAdapterNameResolver(bus: IMakaioBus): () => void {
  return bus.on(
    AdapterSubjects.getCapabilities,
    async (ctx) => {
      const { adapterName, adapterId } = ctx.payload;

      // If adapterId already provided, pass through
      if (adapterId) {
        await ctx.next();
        return;
      }

      if (adapterName) {
        const resolution = await bus.requestOptional(AdapterRuntimeSubjects.resolveId, { adapterName });
        const resolvedAdapterId = resolution.handled ? resolution.data.adapterId : undefined;
        if (resolvedAdapterId) {
          ctx.payload.adapterId = resolvedAdapterId;
        }
      }

      await ctx.next();
    },
    { priority: 20 },
  );
}
