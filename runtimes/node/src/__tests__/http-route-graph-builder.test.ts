import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHonoRouteGraph } from '../hono-route-graph.js';
import { createHttpRouteGraphBuilder } from '../http-route-graph-builder.js';
import type { HttpRouteContribution } from '../http-route-contribution.js';
import type { HonoRouteGraph } from '../hono-route-graph.js';

describe('createHttpRouteGraphBuilder', () => {
  it('builds a Hono app with contributions in phase order', async () => {
    const routeGraph = createHonoRouteGraph(new Hono());
    const builder = createHttpRouteGraphBuilder(routeGraph);

    // Register static-fallback before extension to verify phase sort
    builder.add({
      owner: '__static',
      phase: 'static-fallback',
      mount: (app) => app.get('*', (c) => c.text('fallback')),
    });
    builder.add({
      owner: 'my-ext',
      phase: 'extension',
      mount: (app) => app.get('/extensions/my-ext/browser/index.js', (c) => c.text('ext')),
    });

    routeGraph.markReady();

    const extRes = await routeGraph.fetch(new Request('http://localhost/extensions/my-ext/browser/index.js'));
    expect(extRes.status).toBe(200);
    expect(await extRes.text()).toBe('ext');

    // Catch-all only matches paths not claimed by extensions
    const fallbackRes = await routeGraph.fetch(new Request('http://localhost/other'));
    expect(await fallbackRes.text()).toBe('fallback');
  });

  it('removes contributions by owner and rebuilds', async () => {
    const routeGraph = createHonoRouteGraph(new Hono());
    const builder = createHttpRouteGraphBuilder(routeGraph);

    builder.add({
      owner: 'removable',
      phase: 'extension',
      mount: (app) => app.get('/removable', (c) => c.text('here')),
    });
    routeGraph.markReady();

    const before = await routeGraph.fetch(new Request('http://localhost/removable'));
    expect(before.status).toBe(200);

    builder.remove('removable');

    const after = await routeGraph.fetch(new Request('http://localhost/removable'));
    expect(after.status).toBe(404);
  });

  it('does not rebuild when route graph is undefined (dev mode)', () => {
    const builder = createHttpRouteGraphBuilder(undefined);
    const mount = vi.fn();

    builder.add({ owner: 'x', phase: 'extension', mount });

    // mount is never called because there is no route graph to rebuild onto
    expect(mount).not.toHaveBeenCalled();
    expect(builder.contributions).toHaveLength(1);
  });

  it('remove of unknown owner is a no-op', () => {
    const routeGraph = createHonoRouteGraph(new Hono());
    const builder = createHttpRouteGraphBuilder(routeGraph);

    // Should not throw
    builder.remove('nonexistent');
    expect(builder.contributions).toHaveLength(0);
  });

  it('exposes a contributions snapshot', () => {
    const builder = createHttpRouteGraphBuilder(undefined);
    const c: HttpRouteContribution = {
      owner: 'test',
      phase: 'extension',
      mount: () => {},
    };
    builder.add(c);

    expect(builder.contributions).toEqual([c]);
  });

  it('does not retain an added contribution when rebuild fails', () => {
    const routeGraph = createHonoRouteGraph(new Hono());
    const builder = createHttpRouteGraphBuilder(routeGraph);

    expect(() =>
      builder.add({
        owner: 'bad-ext',
        phase: 'extension',
        mount: () => {
          throw new Error('mount failed');
        },
      }),
    ).toThrow('mount failed');

    expect(builder.contributions).toHaveLength(0);
  });

  it('empty builder produces a Hono app that returns 404', async () => {
    const routeGraph = createHonoRouteGraph(new Hono());
    const builder = createHttpRouteGraphBuilder(routeGraph);

    // Force a build with no contributions
    routeGraph.replaceApp(builder.build());
    routeGraph.markReady();

    const res = await routeGraph.fetch(new Request('http://localhost/anything'));
    expect(res.status).toBe(404);
  });

  it('does not commit removal when rebuild fails', () => {
    let failReplace = false;
    const routeGraph: HonoRouteGraph = {
      fetch: new Hono().fetch,
      markReady: () => {},
      replaceApp: () => {
        if (failReplace) {
          throw new Error('replace failed');
        }
      },
    };
    const builder = createHttpRouteGraphBuilder(routeGraph);

    builder.add({
      owner: 'first',
      phase: 'extension',
      mount: (app) => app.get('/first', (c) => c.text('first')),
    });

    failReplace = true;

    expect(() => builder.remove('first')).toThrow('replace failed');
    expect(builder.contributions).toHaveLength(1);
  });
});
