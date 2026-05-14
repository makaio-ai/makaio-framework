import type { ContributionProcessor, KernelMakaioExtension } from '@makaio/kernel';
import type { HttpRouteGraphBuilder } from './http-route-graph-builder.js';

/**
 * Create a framework-owned contribution processor for `MakaioExtension.http`.
 *
 * Each activated extension whose manifest declares an `http` field gets its
 * routes added to the shared route graph via the builder.  When an extension
 * stops, all of its routes are removed and the graph is rebuilt.
 *
 * The `mount` callback on `MakaioExtension.http` accepts `unknown` (contracts
 * intentionally avoids a direct Hono dependency), so the wrapper below casts
 * the typed Hono app to `unknown` at the call site.
 * @param builder - Route graph builder that accumulates and rebuilds contributions.
 * @returns Awaited contribution processor for HTTP route contributions.
 */
export function createHttpContributionProcessor(builder: HttpRouteGraphBuilder): ContributionProcessor {
  return {
    filter: (pkg: KernelMakaioExtension) => !!pkg.http,

    async processActivated(name: string, pkg: KernelMakaioExtension): Promise<void> {
      builder.add({
        owner: name,
        phase: 'extension',
        mount: (app) => pkg.http!.mount(app),
      });
    },

    async processStopped(name: string): Promise<void> {
      builder.remove(name);
    },
  };
}
