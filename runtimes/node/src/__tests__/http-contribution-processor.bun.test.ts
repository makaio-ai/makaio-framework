import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { KernelMakaioExtension } from '@makaio/kernel/extension';
import { createHttpContributionProcessor } from '../http-contribution-processor.js';
import { createHttpRouteGraphBuilder } from '../http-route-graph-builder.js';
import { createHonoRouteGraph } from '../hono-route-graph.js';

/**
 * Build a minimal extension manifest for HTTP contribution processor tests.
 * @param partial - Extension fields to override.
 * @returns Typed extension manifest.
 */
function makeTestExtension(partial: Partial<KernelMakaioExtension> = {}): KernelMakaioExtension {
  return {
    name: 'test-ext',
    displayName: 'Test Extension',
    version: '0.1.0',
    ...partial,
  };
}

describe('createHttpContributionProcessor', () => {
  it('filter returns true for extensions with http', () => {
    const builder = createHttpRouteGraphBuilder(undefined);
    const processor = createHttpContributionProcessor(builder);

    const withHttp = makeTestExtension({ http: { prefix: '/test', mount: () => {} } });
    const withoutHttp = makeTestExtension();

    expect(processor.filter!(withHttp)).toBe(true);
    expect(processor.filter!(withoutHttp)).toBe(false);
  });

  it('processActivated adds a contribution to the builder', async () => {
    const builder = createHttpRouteGraphBuilder(undefined);
    const processor = createHttpContributionProcessor(builder);

    const mount = mock();
    const pkg = makeTestExtension({
      http: { prefix: '/extensions/test-ext/browser', mount },
    });

    await processor.processActivated('test-ext', pkg, {} as never);

    expect(builder.contributions).toHaveLength(1);
    expect(builder.contributions[0]!.owner).toBe('test-ext');
    expect(builder.contributions[0]!.phase).toBe('extension');
  });

  it('processStopped removes contributions by owner', async () => {
    const builder = createHttpRouteGraphBuilder(undefined);
    const processor = createHttpContributionProcessor(builder);

    const pkg = makeTestExtension({
      http: { prefix: '/test', mount: () => {} },
    });

    await processor.processActivated('test-ext', pkg, {} as never);
    expect(builder.contributions).toHaveLength(1);

    await processor.processStopped!('test-ext');
    expect(builder.contributions).toHaveLength(0);
  });

  it('mount callback is invoked with a Hono app during rebuild', async () => {
    const routeGraph = createHonoRouteGraph(new Hono());
    const builder = createHttpRouteGraphBuilder(routeGraph);
    const processor = createHttpContributionProcessor(builder);

    const mount = mock();
    const pkg = makeTestExtension({
      http: { prefix: '/test', mount },
    });

    await processor.processActivated('test-ext', pkg, {} as never);

    // mount should have been called during rebuild (since routeGraph is provided)
    expect(mount).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledWith(expect.any(Hono));
  });
});
