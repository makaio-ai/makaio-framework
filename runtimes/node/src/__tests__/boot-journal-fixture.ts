import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import type { HostDatabase, JournalEdgeCapability } from '@makaio/contracts';
import { createBusNamespace, journalSubject } from '@makaio/core';
import type { KernelMakaioExtension } from '@makaio/kernel';
import { onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { bootMakaioRuntimeCore } from '../boot.js';
import type { CoreBootOptions } from '../boot-types.js';
import { ExplicitDescriptorDiscovery } from '../extension-discovery.js';

export const extension = 'journal-boot-writer';
const edgeName = `${extension}.incoming`;
export const subject = `${extension}.changed`;
export const namespace = createBusNamespace(extension, {
  changed: journalSubject(z.string(), {
    retention: 'recorded',
    schemaVersion: '1',
    readOlder: { kind: 'as-recorded' },
  }),
  record: { request: z.object({ key: z.string() }), response: z.object({ recorded: z.boolean() }) },
});

/**
 * Boot the Node runtime against an isolated home with an in-process transport.
 * @param packages - Manifests to discover during boot.
 * @param signal - Optional startup cancellation signal.
 * @param journalStartupWaitTimeoutMs - Maximum time an inbound delivery waits for startup.
 * @param options - Existing home, database target, and optional coordinator wiring.
 * @returns The pending runtime and its database URL.
 */
export async function bootJournalHost(
  packages: readonly KernelMakaioExtension[],
  signal?: AbortSignal,
  journalStartupWaitTimeoutMs?: number,
  options: Pick<CoreBootOptions, 'configureCoordinator' | 'database'> & {
    home?: string;
  } = {},
) {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'makaio-boot-journal-')));
  const url = options.database?.url ?? `file:${join(home, 'makaio.db')}`;
  const discovery = new ExplicitDescriptorDiscovery(
    packages.map((pkg) => ({
      descriptor: {
        name: pkg.name,
        displayName: pkg.displayName,
        version: pkg.version,
        makaio: { framework: '>=1.0.0' },
        entrypoints: { server: true },
      },
      extensionPath: home,
      source: 'local',
      preloadedModule: { default: pkg },
    })),
  );
  for (const key of ['MAKAIO_SKIP_EXTENSIONS', 'MAKAIO_DATABASE_PATH', 'MAKAIO_DATABASE_URL']) {
    vi.stubEnv(key, undefined);
  }
  const boot = bootMakaioRuntimeCore({ connect: async () => {}, disconnect: async () => {} }, 0, '127.0.0.1', {
    makaioHome: home,
    frameworkVersion: '3.0.0',
    discovery,
    signal,
    journalStartupWaitTimeoutMs,
    ...(url.startsWith('file:') ? { dbPath: url.slice('file:'.length) } : { database: options.database }),
    configureCoordinator: options.configureCoordinator,
  });
  onTestFinished(async () => {
    try {
      const runtime = await boot.catch(() => undefined);
      await runtime?.shutdown();
    } finally {
      MakaioBus.__resetHandlers?.();
      vi.unstubAllEnvs();
      if (!options.home) await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
  void boot.catch(() => undefined);
  return { boot, home, url };
}

/**
 * Build a manifest whose startup and subsequent writes use the real host context.
 * @param duringStart - Optional operation to await from the extension's init.
 * @returns The manifest and a handle for external deliveries.
 */
export function writer(duringStart?: (edge: JournalEdgeCapability) => Promise<void>) {
  const started = Promise.withResolvers<JournalEdgeCapability>();
  const readyDatabase = Promise.withResolvers<HostDatabase>();
  const deliveryContext = new AsyncLocalStorage<{ openedTransaction: boolean }>();
  let instrumentedDatabase: HostDatabase | undefined;
  let deliveriesWithTransaction = 0;
  const pkg: KernelMakaioExtension = {
    name: extension,
    displayName: 'Journal writer',
    version: '1.0.0',
    critical: true,
    namespaces: [namespace],
    edges: [{ edge: edgeName, description: 'Receives changes', subjects: [subject] }],
    create: ({ bus, database, journal }) => {
      readyDatabase.resolve(database);
      if (database !== instrumentedDatabase) {
        const transact = database.transaction.bind(database);
        database.transaction = (run) => {
          const delivery = deliveryContext.getStore();
          if (delivery && !delivery.openedTransaction) {
            delivery.openedTransaction = true;
            deliveriesWithTransaction++;
          }
          return transact(run);
        };
        instrumentedDatabase = database;
      }
      const registered = journal.edge(edgeName);
      const edge: JournalEdgeCapability = {
        ...registered,
        accept: (input) => deliveryContext.run({ openedTransaction: false }, () => registered.accept(input)),
      };
      const destroy = bus.on(namespace.subjects.record, async ({ payload: { key }, call, setResult }) => {
        const outcomes = await database.transaction((tx) =>
          journal.record(call, { tx, entries: [{ key, subject, payload: key }] }),
        );
        setResult({ recorded: outcomes[0]?.status === 'recorded' });
      });
      return {
        init: async () => {
          await duringStart?.(edge);
          started.resolve(edge);
        },
        destroy,
      };
    },
  };
  return {
    pkg,
    started: started.promise,
    database: readyDatabase.promise,
    deliveriesWithTransaction: () => deliveriesWithTransaction,
  };
}

/**
 * Form one inbound delivery.
 * @param key - Sender's idempotency key.
 * @returns The edge input for the delivery.
 */
export function delivery(key: string) {
  return { entries: [{ key, subject, payload: key }] };
}
