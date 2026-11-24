import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { NoTransportProvider, type KernelMakaioExtension } from '@makaio/kernel';
import { sessionStoragePackage, SessionStorageSubjects } from '@makaio/services-core';
import { getRawSqlExecutor, registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { clientStoragePackage, ClientRuntimeStorageSubjects, ClientsCoreToken } from '@makaio/subsystem-client';
import { sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bootMakaioRuntimeCore, type MakaioRuntime } from '../boot.js';
import { ExplicitDescriptorDiscovery } from '../extension-discovery.js';

const storageProbeNamespace = createBusNamespace('storage:boot-probe', {
  read: { request: z.object({}), response: z.object({ value: z.number() }) },
});

const transport = new NoTransportProvider();

it('starts framework and discovered storage packages on the default SQLite database', { timeout: 30_000 }, async () => {
  const makaioHome = await fs.mkdtemp(path.join(tmpdir(), 'makaio-boot-storage-'));
  let runtime: MakaioRuntime | undefined;
  const configure = vi.fn();
  const storageProbe: KernelMakaioExtension = {
    name: 'boot-storage-probe',
    displayName: 'Boot Storage Probe',
    version: '1.0.0',
    namespaces: [storageProbeNamespace],
    runtimeBoot: { configure },
    storage: {
      /**
       * Serve a request using the database supplied to the extension.
       * @param bus - Extension bus.
       * @param db - Host database handle.
       * @returns Cleanup for the request handler.
       */
      registerHandlers: registerDrizzleHandlers((bus, db) =>
        bus.on(storageProbeNamespace.subjects.read, async (ctx) => {
          const [row] = await getRawSqlExecutor(db).all<{ value: number }>(sql`SELECT 1 AS value`);
          ctx.setResult(row);
        }),
      ),
    },
  };

  try {
    for (const name of ['MAKAIO_SKIP_EXTENSIONS', 'MAKAIO_DATABASE_URL', 'MAKAIO_DATABASE_PATH']) {
      vi.stubEnv(name, undefined);
    }
    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      makaioHome,
      frameworkVersion: '3.0.0',
      discovery: new ExplicitDescriptorDiscovery([
        {
          descriptor: {
            name: storageProbe.name,
            displayName: storageProbe.displayName,
            version: storageProbe.version,
            makaio: { framework: '>=1.0.0' },
            entrypoints: { server: true },
          },
          extensionPath: makaioHome,
          source: 'local',
          preloadedModule: { default: storageProbe },
        },
      ]),
    });
    expect(runtime.coordinator.getInfo(sessionStoragePackage.name)?.state).toBe('active');
    expect(runtime.coordinator.getInfo(clientStoragePackage.name)?.state).toBe('active');
    expect(runtime.coordinator.getInfo(storageProbe.name)?.state).toBe('active');
    expect(configure).toHaveBeenCalledOnce();
    const activeNames = runtime.coordinator
      .list()
      .filter(({ state }) => state === 'active')
      .map(({ name }) => name);
    expect(activeNames).toContain(ClientsCoreToken.name);
    expect(activeNames.indexOf(clientStoragePackage.name)).toBeLessThan(activeNames.indexOf(ClientsCoreToken.name));

    const { bus } = runtime;
    // ORIGIN: The boot test reads storage from the bus returned by the runtime.
    const call = bus.own('observer');
    await expect(bus.request(call, SessionStorageSubjects.get, { sessionId: 'missing' })).resolves.toEqual({
      session: null,
    });
    await expect(bus.request(call, ClientRuntimeStorageSubjects.loadAll, {})).resolves.toEqual({ records: [] });
    await expect(bus.request(call, storageProbeNamespace.subjects.read, {})).resolves.toEqual({ value: 1 });
  } finally {
    try {
      await runtime?.shutdown();
    } finally {
      MakaioBus.__resetHandlers?.();
      vi.unstubAllEnvs();
      await fs.rm(makaioHome, { recursive: true, force: true });
    }
  }
});
