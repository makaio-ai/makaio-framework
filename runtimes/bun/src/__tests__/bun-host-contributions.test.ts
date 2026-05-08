import { describe, expect, it } from 'vitest';
import type { MakaioExtension } from '@makaio/contracts';
import type { BunHostExtensionPackage, BunRouteGraphFetch, BunWebSocketHandler } from '../index.js';
import { collectActiveBunHostPackages, createBunHostRouter, normalizeBunHostPackages } from '../index.js';

const upgradeServer = {
  upgrade: () => false,
};

describe('Bun host contributions', () => {
  it('activates host routing only when active packages are supplied', async () => {
    const calls: string[] = [];
    const ws = {} as Parameters<BunWebSocketHandler['open']>[0];
    const baseFetch: BunRouteGraphFetch = () => {
      calls.push('base-fetch');
      return new Response('base');
    };
    const baseWebSocket: BunWebSocketHandler = {
      binaryType: 'arraybuffer',
      open() {
        calls.push('base-open');
      },
      message() {
        calls.push('base-message');
      },
      close() {
        calls.push('base-close');
      },
    };
    const hostPackage: BunHostExtensionPackage = {
      name: 'relay',
      displayName: 'Relay',
      bun: {
        createFetch: (next) => (request, server) => {
          calls.push('extension-fetch');
          return next(request, server);
        },
        createWebSocketHandler: (next) => ({
          binaryType: 'arraybuffer',
          open(socket) {
            calls.push('extension-open');
            next.open(socket);
          },
          message(socket, message) {
            calls.push('extension-message');
            next.message(socket, message);
          },
          close(socket, code, reason) {
            calls.push('extension-close');
            next.close(socket, code, reason);
          },
        }),
      },
    };

    const router = createBunHostRouter(baseFetch, baseWebSocket);
    await router.fetch(new Request('http://localhost/'), upgradeServer);
    router.websocket.open(ws);

    router.activate([hostPackage]);
    await router.fetch(new Request('http://localhost/'), upgradeServer);
    router.websocket.open(ws);
    router.websocket.message(ws, 'hello');
    router.websocket.close(ws, 1000, 'done');

    expect(calls).toEqual([
      'base-fetch',
      'base-open',
      'extension-fetch',
      'base-fetch',
      'extension-open',
      'base-open',
      'extension-message',
      'base-message',
      'extension-close',
      'base-close',
    ]);
  });

  it('collects only active packages with valid Bun host hooks', () => {
    const plainPackage: MakaioExtension = { name: 'api', displayName: 'API' };
    const hostPackage: BunHostExtensionPackage = {
      name: 'relay',
      displayName: 'Relay',
      bun: {
        createFetch: (next) => next,
      },
    };

    const activePackages = collectActiveBunHostPackages({
      forEachActiveExtension(callback) {
        callback(plainPackage.name, plainPackage);
        callback(hostPackage.name, hostPackage);
      },
    });

    expect(activePackages).toEqual([hostPackage]);
    expect(normalizeBunHostPackages([plainPackage, hostPackage])).toEqual([hostPackage]);
  });
});
