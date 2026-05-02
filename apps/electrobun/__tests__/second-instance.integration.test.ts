import { createBusContext, createBusInstance } from '@makaio/bus-core';
import { startBusServer, type BusServer } from '@makaio/bus-server';
import { HostSubjects } from '@makaio/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { connectAndFocus } from '../src/second-instance.js';

interface FocusBusServer {
  busServer: BusServer;
  unsubscribeFocus: () => void;
  webSocketServer: WebSocketServer;
  port: number;
}

/**
 * Start a real loopback WebSocket bus server with the host focus handler.
 * @param focused - Focus handler result to return to the second instance.
 * @returns Running server resources and cleanup handles.
 */
async function startFocusBusServer(focused: boolean): Promise<FocusBusServer> {
  const webSocketServer = new WebSocketServer({ host: '127.0.0.1', path: '/bus', port: 0 });
  await new Promise<void>((resolve, reject) => {
    webSocketServer.once('listening', resolve);
    webSocketServer.once('error', reject);
  });

  const address = webSocketServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve WebSocket server address');
  }

  const bus = createBusInstance({ context: createBusContext() });
  const unsubscribeFocus = bus.on(HostSubjects.app.focus, (ctx) => {
    ctx.setResult({ focused, windowId: focused ? 1 : null });
  });
  const busServer = await startBusServer({
    websocket: webSocketServer,
    bus,
    loopbackName: 'second-instance-test-loopback',
  });

  return { busServer, unsubscribeFocus, webSocketServer, port: address.port };
}

/**
 * Stop resources from {@link startFocusBusServer}.
 * @param server - Server resources to close.
 */
async function stopFocusBusServer(server: FocusBusServer | undefined): Promise<void> {
  if (!server) return;
  server.unsubscribeFocus();
  await server.busServer.stop();
  if (server.webSocketServer.address()) {
    await new Promise<void>((resolve, reject) => {
      server.webSocketServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('connectAndFocus integration', () => {
  let server: FocusBusServer | undefined;

  afterEach(async () => {
    await stopFocusBusServer(server);
    server = undefined;
  });

  it('focuses an existing instance through the real bus and WebSocket transport', async () => {
    server = await startFocusBusServer(true);

    await expect(connectAndFocus(server.port, { auth: false })).resolves.toBe(true);
  });

  it('returns false when the existing instance reports focus failure', async () => {
    server = await startFocusBusServer(false);

    await expect(connectAndFocus(server.port, { auth: false })).resolves.toBe(false);
  });
});
