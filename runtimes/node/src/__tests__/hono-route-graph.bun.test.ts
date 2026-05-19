import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createHonoRouteGraph } from '../hono-route-graph.js';

describe('createHonoRouteGraph', () => {
  it('does not build the Hono matcher before boot marks HTTP routes ready', async () => {
    const app = new Hono();
    app.get('/health', (context) => context.text('ok'));
    const routeGraph = createHonoRouteGraph(app);

    const bootingResponse = await routeGraph.fetch(new Request('http://127.0.0.1/health'));

    expect(bootingResponse.status).toBe(503);

    app.use('/extensions/account-manager/browser/*', async (context) => {
      return context.text('extension');
    });
    routeGraph.markReady();

    const healthResponse = await routeGraph.fetch(new Request('http://127.0.0.1/health'));
    const extensionResponse = await routeGraph.fetch(
      new Request('http://127.0.0.1/extensions/account-manager/browser/index.js'),
    );

    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.text()).toBe('ok');
    expect(extensionResponse.status).toBe(200);
    expect(await extensionResponse.text()).toBe('extension');
  });

  it('swaps future requests to a fresh Hono route graph', async () => {
    const firstApp = new Hono();
    firstApp.get('/version', (context) => context.text('first'));
    const routeGraph = createHonoRouteGraph(firstApp);
    routeGraph.markReady();

    const secondApp = new Hono();
    secondApp.get('/version', (context) => context.text('second'));
    routeGraph.replaceApp(secondApp);

    const response = await routeGraph.fetch(new Request('http://127.0.0.1/version'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('second');
  });

  describe('infrastructure route handling', () => {
    it('handles GET /health via the configured callback and returns JSON', async () => {
      const healthData = { status: 'ok', uptime: 42 };
      const routeGraph = createHonoRouteGraph(new Hono(), {
        health: () => healthData,
      });
      routeGraph.markReady();

      const response = await routeGraph.fetch(new Request('http://127.0.0.1/health'));

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual(healthData);
    });

    it('handles GET /bus with 426 Upgrade Required', async () => {
      const routeGraph = createHonoRouteGraph(new Hono());
      routeGraph.markReady();

      const response = await routeGraph.fetch(new Request('http://127.0.0.1/bus'));

      expect(response.status).toBe(426);
      expect(response.headers.get('upgrade')).toBe('websocket');
      expect(await response.text()).toBe('WebSocket endpoint');
    });

    it('falls through to the Hono app for paths other than /health and /bus', async () => {
      const app = new Hono();
      app.get('/api/data', (context) => context.json({ value: 'delegated' }));
      const routeGraph = createHonoRouteGraph(app, { health: () => ({ status: 'ok' }) });
      routeGraph.markReady();

      const response = await routeGraph.fetch(new Request('http://127.0.0.1/api/data'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ value: 'delegated' });
    });

    it('applies the 503 gate to /health and /bus before markReady', async () => {
      const routeGraph = createHonoRouteGraph(new Hono(), {
        health: () => ({ status: 'ok' }),
      });

      const healthResponse = await routeGraph.fetch(new Request('http://127.0.0.1/health'));
      const busResponse = await routeGraph.fetch(new Request('http://127.0.0.1/bus'));

      expect(healthResponse.status).toBe(503);
      expect(busResponse.status).toBe(503);
    });

    it('falls through to the Hono app for GET /health when no health option is provided', async () => {
      const app = new Hono();
      app.get('/health', (context) => context.text('custom-health'));
      const routeGraph = createHonoRouteGraph(app);
      routeGraph.markReady();

      const response = await routeGraph.fetch(new Request('http://127.0.0.1/health'));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('custom-health');
    });
  });
});
