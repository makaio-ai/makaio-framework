import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { MakaioBus } from '@makaio/bus-core';
import { JournalError, type JournalEdgeCapability } from '@makaio/contracts';
import { createBusNamespace, journalSubject } from '@makaio/core';
import type { KernelMakaioExtension } from '@makaio/kernel';
import { journalStorageSchema } from '@makaio/services-core/journal/storage';
import { resolveSchema } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { eq } from 'drizzle-orm';
import { expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { bootMakaioRuntimeCore } from '../boot.js';
import { ExplicitDescriptorDiscovery } from '../extension-discovery.js';

const extension = 'journal-boot-writer';
const edgeName = `${extension}.incoming`;
const subject = `${extension}.changed`;
const namespace = createBusNamespace(extension, {
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
 * @returns The pending runtime and its SQLite URL.
 */
async function bootJournalHost(
  packages: readonly KernelMakaioExtension[],
  signal?: AbortSignal,
  journalStartupWaitTimeoutMs?: number,
) {
  const home = await mkdtemp(join(tmpdir(), 'makaio-boot-journal-'));
  const url = `file:${join(home, 'makaio.db')}`;
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
  });
  onTestFinished(async () => {
    try {
      const runtime = await boot.catch(() => undefined);
      await runtime?.shutdown();
    } finally {
      MakaioBus.__resetHandlers?.();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
  void boot.catch(() => undefined);
  return { boot, url };
}

/**
 * Build a manifest whose startup and subsequent writes use the real host context.
 * @param duringStart - Optional operation to await from the extension's init.
 * @returns The manifest and a handle for external deliveries.
 */
function writer(duringStart?: (edge: JournalEdgeCapability) => Promise<void>) {
  const started = Promise.withResolvers<JournalEdgeCapability>();
  let transaction: ReturnType<typeof vi.spyOn> | undefined;
  const pkg: KernelMakaioExtension = {
    name: extension,
    displayName: 'Journal writer',
    version: '1.0.0',
    critical: true,
    namespaces: [namespace],
    edges: [{ edge: edgeName, description: 'Receives changes', subjects: [subject] }],
    create: ({ bus, database, journal }) => {
      transaction ??= vi.spyOn(database, 'transaction');
      const edge = journal.edge(edgeName);
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
  return { pkg, started: started.promise, transactions: () => transaction };
}

/**
 * Hold a dependent extension in startup so an independent delivery can arrive.
 * @param init - Operation to run in the dependent extension's startup.
 * @returns Manifest ordered after the journal writer.
 */
function dependent(init: () => Promise<void>): KernelMakaioExtension {
  return {
    name: 'journal-boot-dependent',
    displayName: 'Journal boot dependent',
    version: '1.0.0',
    critical: true,
    dependencies: [{ type: 'extension', name: extension, version: '*' }],
    create: () => ({ init, destroy: () => {} }),
  };
}

/**
 * Form one inbound delivery.
 * @param key - Sender's idempotency key.
 * @returns The edge input for the delivery.
 */
function delivery(key: string) {
  return { entries: [{ key, subject, payload: key }] };
}

it('waits for the last extension before accepting and commits handler records to shared SQLite storage', {
  timeout: 30_000,
}, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { pkg, started, transactions } = writer();
  const { boot, url } = await bootJournalHost([
    pkg,
    dependent(async () => {
      entered.resolve();
      await release.promise;
    }),
  ]);
  const edge = await Promise.race([started, boot.then(() => started)]);
  try {
    await Promise.race([entered.promise, boot.then(() => entered.promise)]);
    const inbound = edge.accept(delivery('inbound'));
    void inbound.catch(() => undefined);
    await setImmediate();
    expect(transactions()).not.toHaveBeenCalled();

    release.resolve();
    const runtime = await boot;
    await expect(inbound).resolves.toMatchObject([{ status: 'recorded' }]);
    const reader = await createDatabaseClient({ url });
    try {
      // ORIGIN: The test host sends a fresh request to the running extension.
      const call = runtime.bus.own('observer');
      await expect(runtime.bus.request(call, namespace.subjects.record, { key: 'handler' })).resolves.toEqual({
        recorded: true,
      });
      const { journalEntries } = resolveSchema(reader.db, journalStorageSchema);
      const rows = await reader.db.select().from(journalEntries).where(eq(journalEntries.key, 'handler'));
      expect(rows).toMatchObject([{ subject, payload: 'handler' }]);
    } finally {
      await reader.close();
    }
    const pendingAtShutdown = edge.accept(delivery('shutdown-race'));
    const shutdown = runtime.shutdown();
    await expect(pendingAtShutdown).rejects.toThrow('shutting down');
    await shutdown;
    await expect(edge.accept(delivery('stopped'))).rejects.toThrow('shutting down');
  } finally {
    release.resolve();
  }
});

it('breaks a cycle between a dependent startup and the edge owner', { timeout: 30_000 }, async () => {
  const requested = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  const { pkg, started, transactions } = writer(async (edge) => {
    // The owner serves this request after its own init has returned.
    void requested.promise.then(() => edge.accept(delivery('startup-cycle'))).then(response.resolve, response.resolve);
  });
  const { boot } = await bootJournalHost(
    [
      pkg,
      dependent(async () => {
        await started;
        requested.resolve();
        const outcome = await Promise.race([response.promise, setTimeout(500, 'delivery is still waiting')]);
        expect(outcome).toBeInstanceOf(JournalError);
        expect(outcome).toMatchObject({ code: 'accept-startup-timeout' });
      }),
    ],
    undefined,
    25,
  );
  await boot;
  expect(transactions()).not.toHaveBeenCalled();
});

it('rejects an accept awaited by the edge owner during startup and re-enable', { timeout: 30_000 }, async () => {
  const { pkg, transactions } = writer(async (edge) => {
    const ownStart = edge.accept(delivery('own-start'));
    await expect(Promise.race([ownStart, setTimeout(300, 'startup is waiting')])).rejects.toMatchObject({
      code: 'accept-during-own-start',
      message: expect.stringContaining(extension),
    });
  });
  const { boot } = await bootJournalHost([pkg]);
  const runtime = await boot;
  await expect(runtime.coordinator.applyExtensionTransition(extension, false)).resolves.toBe('applied');
  await expect(runtime.coordinator.applyExtensionTransition(extension, true)).resolves.toBe('applied');
  expect(transactions()).not.toHaveBeenCalled();
});

it.each(['critical failure', 'cancellation'] as const)('rejects waiting deliveries on %s', {
  timeout: 30_000,
}, async (outcome) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  const failure = new Error('boot interrupted');
  const { pkg, started, transactions } = writer();
  const { boot } = await bootJournalHost(
    [
      pkg,
      dependent(async () => {
        entered.resolve();
        await release.promise;
        if (outcome === 'critical failure') throw failure;
      }),
    ],
    abort.signal,
  );
  const edge = await Promise.race([started, boot.then(() => started)]);
  try {
    await Promise.race([entered.promise, boot.then(() => entered.promise)]);
    const inbound = edge.accept(delivery('interrupted'));
    void inbound.catch(() => undefined);
    if (outcome === 'cancellation') {
      abort.abort(failure);
      await expect(Promise.race([inbound, setTimeout(500, 'delivery is still waiting')])).rejects.toBe(failure);
    }
    release.resolve();
    await expect(boot).rejects.toThrow(failure.message);
    await expect(Promise.race([inbound, setTimeout(500, 'delivery is still waiting')])).rejects.toThrow(
      failure.message,
    );
    await expect(
      Promise.race([edge.accept(delivery('unavailable')), setTimeout(500, 'delivery is still waiting')]),
    ).rejects.toThrow(failure.message);
    expect(transactions()).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
});
