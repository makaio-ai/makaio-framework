import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { ExtensionSubjects } from '@makaio/kernel';
import type { ViteBusServerPluginOptions } from './index.js';
import { createViteRuntimeBootOptions, ViteBusServerPlugin } from './index.js';

type TestRuntimeOptions = NonNullable<ViteBusServerPluginOptions['runtimeOptions']>;

const tempDirs: string[] = [];

afterEach(() => {
  MakaioBus.__resetHandlers?.();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create discovery overrides that keep the real runtime boot framework-only.
 * @returns Empty extension discovery options.
 */
function emptyRuntimeOptions(): TestRuntimeOptions {
  return {
    frameworkVersion: '0.1.0',
    discovery: { discover: async () => [] },
  };
}

/**
 * Wait until the real runtime has registered extension list handlers.
 * @returns Extension list response.
 */
async function waitForExtensionList(): Promise<{ readonly extensions: ReadonlyArray<{ readonly name: string }> }> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await MakaioBus.requestOptional(ExtensionSubjects.list, {}, { timeout: 250 });
      if (result.handled) {
        return result.data;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for real runtime extension list handler: ${String(lastError)}`);
}

/**
 * Start a Node HTTP server on an ephemeral port.
 * @param httpServer - Server to start.
 * @returns Bound address info.
 */
async function listen(httpServer: HttpServer): Promise<AddressInfo> {
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  return httpServer.address() as AddressInfo;
}

/**
 * Close a Node HTTP server if it is still listening.
 * @param httpServer - Server to close.
 */
async function closeServer(httpServer: HttpServer): Promise<void> {
  if (!httpServer.listening) return;
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('ViteBusServerPlugin', () => {
  describe('options validation', () => {
    it('throws when secret is empty string', () => {
      expect(() => ViteBusServerPlugin({ secret: '' })).toThrow('options.secret is set but empty');
    });

    it('throws when secret is whitespace-only', () => {
      expect(() => ViteBusServerPlugin({ secret: '   ' })).toThrow('options.secret is set but empty');
    });

    it('does not throw when secret is a valid string', () => {
      expect(() => ViteBusServerPlugin({ secret: 'my-dev-secret' })).not.toThrow();
    });

    it('does not throw when secret is omitted', () => {
      expect(() => ViteBusServerPlugin()).not.toThrow();
      expect(() => ViteBusServerPlugin({})).not.toThrow();
    });
  });

  describe('plugin structure', () => {
    it('returns plugin with correct name', () => {
      const plugin = ViteBusServerPlugin();
      expect(plugin.name).toBe('vite-bus-server');
    });

    it('exports configureServer hook as a function', () => {
      const plugin = ViteBusServerPlugin();
      expect(typeof plugin.configureServer).toBe('function');
    });

    it('exports closeBundle hook as a function', () => {
      const plugin = ViteBusServerPlugin();
      expect(typeof plugin.closeBundle).toBe('function');
    });
  });

  describe('runtime boot options', () => {
    it('merges host runtime options into the real boot option builder', () => {
      const httpServer = createServer();
      const hostCapabilities = ['workspace-host', 'native-pty'] as const;
      const discoveryOverride = emptyRuntimeOptions().discovery;

      const options = createViteRuntimeBootOptions({
        httpServer,
        runtimeOptions: {
          discovery: discoveryOverride,
          hostCapabilities,
        },
      });

      expect(options).toMatchObject({
        httpServer,
        loopbackName: 'vite',
        surface: 'interactive',
        discovery: discoveryOverride,
        hostCapabilities: ['node', ...hostCapabilities],
      });
    });

    it('preserves plugin-owned loopback invariants even when runtime options include extra keys', () => {
      const httpServer = createServer();
      const runtimeHttpServer = createServer();
      const runtimeOptions = {
        ...emptyRuntimeOptions(),
        auth: 'runtime-auth',
        httpServer: runtimeHttpServer,
        loopbackName: 'not-vite',
        onTransportReady: () => undefined,
        surface: 'headless',
      } as TestRuntimeOptions & Record<string, unknown>;

      const options = createViteRuntimeBootOptions({
        httpServer,
        runtimeOptions,
      });

      expect(options.loopbackName).toBe('vite');
      expect(options.surface).toBe('interactive');
      expect(options.httpServer).toBe(httpServer);
      expect(options.auth).toBeUndefined();
      expect(options).not.toHaveProperty('onTransportReady');
    });

    it('starts the real runtime after the HTTP server listens', async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'makaio-vite-bus-server-'));
      tempDirs.push(tempDir);
      const previousDatabasePath = process.env['MAKAIO_DATABASE_PATH'];
      process.env['MAKAIO_DATABASE_PATH'] = path.join(tempDir, 'makaio.db');

      const httpServer = createServer();
      const plugin = ViteBusServerPlugin({ runtimeOptions: emptyRuntimeOptions() });
      const configureServer = plugin.configureServer as (server: { httpServer: HttpServer }) => void;
      const closeBundle = plugin.closeBundle as () => Promise<void>;

      try {
        configureServer({ httpServer });
        const address = await listen(httpServer);
        expect(address.port).toBeGreaterThan(0);

        const extensionList = await waitForExtensionList();
        expect(extensionList.extensions.some((extension) => extension.name === 'preferences-storage')).toBe(true);
      } finally {
        await closeBundle();
        if (previousDatabasePath === undefined) {
          delete process.env['MAKAIO_DATABASE_PATH'];
        } else {
          process.env['MAKAIO_DATABASE_PATH'] = previousDatabasePath;
        }
        await closeServer(httpServer);
      }
    }, 30_000);
  });
});
