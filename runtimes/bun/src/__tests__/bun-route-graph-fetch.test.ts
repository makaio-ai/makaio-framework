import { describe, expect, it, vi } from 'vitest';
import { createBunRouteGraphFetch } from '../bun-route-graph-fetch.js';
import type { HonoRouteGraph } from '@makaio/runtime-node';

/**
 * Create a minimal route graph whose fetch call can be inspected.
 * @returns Route graph stub with a fetch spy.
 */
function createRouteGraphStub(): HonoRouteGraph & { readonly fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async () => new Response('delegated')),
    markReady: vi.fn(),
    replaceApp: vi.fn(),
  };
}

describe('createBunRouteGraphFetch', () => {
  it('upgrades canonical /bus WebSocket requests before route graph delegation', async () => {
    const routeGraph = createRouteGraphStub();
    const server = { upgrade: vi.fn(() => true) };
    const fetch = createBunRouteGraphFetch(routeGraph);
    const request = new Request('http://127.0.0.1/bus', {
      headers: { upgrade: 'websocket' },
    });

    const response = await fetch(request, server);

    expect(response).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledWith(request);
    expect(routeGraph.fetch).not.toHaveBeenCalled();
  });

  it('returns 426 when /bus WebSocket upgrade fails', async () => {
    const routeGraph = createRouteGraphStub();
    const server = { upgrade: vi.fn(() => false) };
    const fetch = createBunRouteGraphFetch(routeGraph);
    const request = new Request('http://127.0.0.1/bus', {
      headers: { upgrade: 'websocket' },
    });

    const response = await fetch(request, server);

    expect(response?.status).toBe(426);
    expect(await response?.text()).toBe('WebSocket upgrade failed');
    expect(routeGraph.fetch).not.toHaveBeenCalled();
  });

  it('upgrades pathless non-browser WebSocket requests for LAN clients', async () => {
    const routeGraph = createRouteGraphStub();
    const server = { upgrade: vi.fn(() => true) };
    const fetch = createBunRouteGraphFetch(routeGraph);
    const request = new Request('http://127.0.0.1/', {
      headers: { upgrade: 'websocket' },
    });

    const response = await fetch(request, server);

    expect(response).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledWith(request);
    expect(routeGraph.fetch).not.toHaveBeenCalled();
  });

  it('delegates non-bus requests to the route graph', async () => {
    const routeGraph = createRouteGraphStub();
    const server = { upgrade: vi.fn(() => true) };
    const fetch = createBunRouteGraphFetch(routeGraph);
    const request = new Request('http://127.0.0.1/dashboard');

    const response = await fetch(request, server);

    expect(await response?.text()).toBe('delegated');
    expect(server.upgrade).not.toHaveBeenCalled();
    expect(routeGraph.fetch).toHaveBeenCalledWith(request);
  });

  it('delegates browser-origin root WebSocket requests to avoid stealing app routes', async () => {
    const routeGraph = createRouteGraphStub();
    const server = { upgrade: vi.fn(() => true) };
    const fetch = createBunRouteGraphFetch(routeGraph);
    const request = new Request('http://127.0.0.1/', {
      headers: {
        origin: 'http://127.0.0.1:6252',
        upgrade: 'websocket',
      },
    });

    const response = await fetch(request, server);

    expect(await response?.text()).toBe('delegated');
    expect(server.upgrade).not.toHaveBeenCalled();
    expect(routeGraph.fetch).toHaveBeenCalledWith(request);
  });
});
