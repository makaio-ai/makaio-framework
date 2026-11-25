import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MakaioBus } from '@makaio/bus-core';
import type { KernelExtensionContext } from '@makaio/kernel';
import type { OrderedWorkerProvider } from '@makaio/services-core/worker-provider';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { buildPostgresOptionsUrl, createPostgresConfig } from '@makaio/storage-conformance';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { sql } from 'drizzle-orm';
import { expect, it, onTestFinished, vi } from 'vitest';
import { readDispatch } from '../../../../services/core/src/worker-provider/dispatch-store.js';
import { bootMakaioRuntime } from '../boot.js';
import {
  activeContext,
  childProvider,
  dispatchProbeDiscovery,
  installBootOrderTable,
  name,
  probeOrder,
  source,
  writeOrder,
} from './worker-dispatch-boot-fixture.js';

const signal = new AbortController().signal;

/**
 * Boot an extension on a real Node listener and the requested host database.
 * @param home - Runtime home retained across restart.
 * @param providers - Provider factory called on each activation.
 * @param url - Isolated test database URL.
 * @param created - Receives the context used during extension creation.
 * @param bootSignal - Cancels boot when the test has timed out.
 * @returns The runtime and its listener cleanup.
 */
async function bootProbe(
  home: string,
  providers: () => OrderedWorkerProvider,
  url: string,
  bootSignal: AbortSignal,
  created?: (ctx: KernelExtensionContext) => void,
) {
  const discovery = dispatchProbeDiscovery(home, providers, (ctx) => {
    created?.(ctx);
    return { async init() {}, async destroy() {} };
  });
  const httpServer = createServer().listen(0, '127.0.0.1');
  onTestFinished(() => {
    httpServer.close();
  });
  await once(httpServer, 'listening');
  const sqlite = url.startsWith('file:');
  const boot = bootMakaioRuntime({
    httpServer,
    signal: bootSignal,
    makaioHome: home,
    frameworkVersion: '3.0.0',
    discovery,
    database: sqlite ? undefined : { url },
    workerDispatch: {
      source,
      scopeSetting: { kind: 'absent' },
      connection: () => ({ busAuth: { kind: 'none' } }),
    },
  });
  let shutdown: Promise<void> | undefined;
  const stop = () => (shutdown ??= boot.then((runtime) => runtime.shutdown()));
  onTestFinished(async () => {
    const runtime = await boot.catch(() => undefined);
    if (runtime !== undefined) await stop();
  });
  const runtime = await boot;
  bootSignal.throwIfAborted();
  await installBootOrderTable(url);
  return { runtime, stop };
}

/**
 * Allocate a database and runtime home for one probe, including its restart.
 * @returns The isolated runtime home and connection target.
 */
async function probeStorage() {
  const home = await mkdtemp(join(tmpdir(), 'worker-dispatch-'));
  onTestFinished(async () => {
    MakaioBus.__resetHandlers?.();
    await rm(home, { recursive: true, force: true });
  });
  const postgresUrl = process.env['MAKAIO_STORAGE_TEST_URL'];
  if (postgresUrl === undefined) {
    vi.stubEnv('MAKAIO_DATABASE_URL', undefined);
    vi.stubEnv('MAKAIO_DATABASE_PATH', undefined);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    return { home, url: `file:${join(home, 'makaio.db')}` };
  }
  const storage = await createPostgresConfig(postgresUrl).createDatabaseContext({ applyCentralChain: false });
  onTestFinished(() => storage.cleanup());
  const [row] = await storage.executor.all<{ current_schema: string }>(sql`SELECT current_schema()`);
  if (row === undefined) throw new Error('Isolated test schema unavailable');
  return { home, url: buildPostgresOptionsUrl(postgresUrl, { search_path: row.current_schema }) };
}

it('binds ordered dispatch in the Node runtime and settles its child on shutdown', async ({ signal: bootSignal }) => {
  const { home, url } = await probeStorage();
  const worker = childProvider(onTestFinished);
  let created: KernelExtensionContext['workerDispatch'];
  const { runtime, stop } = await bootProbe(
    home,
    () => worker.provider,
    url,
    bootSignal,
    (ctx) => {
      created = ctx.workerDispatch;
    },
  );
  const ctx = activeContext(runtime);
  const observer = ctx.workerDispatch;
  if (created === undefined || observer === undefined) throw new Error('Worker dispatch unavailable');
  const call = ctx.bus.own('shared-work');
  const order = probeOrder();
  await writeOrder(ctx, order);
  const pending = created.startOrderedWorker(call, order, signal);
  const concurrent = observer.startOrderedWorker(call, order, signal);
  try {
    await Promise.race([worker.firstChild, pending.then((result) => expect(result.kind).toBe('allocated'))]);
    expect(worker.launches()).toBe(1);
    const binding = await observer.prepareAllocationBinding(call, order.jobRunId, { kind: 'allocation-only' });
    if (binding === undefined) throw new Error('Expected an early allocation binding');
    expect(binding.allocationRef).toEqual(worker.children.get(order.jobRunId)?.ref);
    await ctx.database.transaction(binding.bind);
  } finally {
    worker.releaseReply();
    await Promise.all([pending, concurrent]);
  }
  const status = await observer.superviseOrderedWorker(call, order.jobRunId, signal);
  expect(status).toMatchObject({ kind: 'allocated', allocationRef: worker.children.get(order.jobRunId)?.ref });
  expect(worker.launches()).toBe(1);
  expect(worker.stops()).toBe(0);
  await stop();
  expect(worker.stops()).toBe(1);
  expect(worker.children.has(order.jobRunId)).toBe(false);

  const reader = await createDatabaseClient({ url });
  try {
    await expect(
      createHostDatabase(reader.db).transaction((tx) => readDispatch(tx, order.jobRunId)),
    ).resolves.toMatchObject({
      sendSettled: true,
      settled: expect.objectContaining({ summary: 'Process-bound allocation terminated' }),
    });
  } finally {
    await reader.close();
  }
});

it('replaces providers on reactivation and drains allocations after deactivation', async ({ signal: bootSignal }) => {
  const { home, url } = await probeStorage();
  const first = childProvider(onTestFinished);
  const second = childProvider(onTestFinished);
  let currentProvider = first.provider;
  const { runtime, stop } = await bootProbe(home, () => currentProvider, url, bootSignal);
  const ctx = activeContext(runtime);
  const dispatch = ctx.workerDispatch;
  if (dispatch === undefined) throw new Error('Worker dispatch unavailable');
  const call = ctx.bus.own('start');
  const start = async () => {
    const order = probeOrder();
    await writeOrder(ctx, order);
    const result = await dispatch.startOrderedWorker(call, order, signal);
    return { order, result };
  };

  first.releaseReply();
  const initial = await start();
  expect(initial.result).toEqual({ kind: 'allocated', allocationRef: first.children.get(initial.order.jobRunId)?.ref });
  expect(await runtime.coordinator.applyExtensionTransition(name, false)).toBe('applied');
  const refused = { kind: 'refused', reason: 'provider-unavailable' };
  expect((await start()).result).toEqual(refused);

  // Rebuild the batch with the same provider ID and a new implementation.
  currentProvider = second.provider;
  expect(await runtime.coordinator.applyExtensionTransition(name, true)).toBe('applied');
  second.releaseReply();
  const replacement = await start();
  expect(replacement.result).toEqual({
    kind: 'allocated',
    allocationRef: second.children.get(replacement.order.jobRunId)?.ref,
  });
  expect(first.launches()).toBe(1);
  expect(second.launches()).toBe(1);

  expect(await runtime.coordinator.applyExtensionTransition(name, false)).toBe('applied');
  expect((await start()).result).toEqual(refused);
  await writeOrder(ctx, replacement.order, 'closed');
  await expect(dispatch.superviseOrderedWorker(call, replacement.order.jobRunId, signal)).resolves.toEqual(
    replacement.result,
  );
  expect(second.stops()).toBe(1);
  expect(second.children.size).toBe(0);
  expect(first.stops()).toBe(0);
  await stop();
  expect(first.stops()).toBe(1);
  expect(first.children.size).toBe(0);
  expect(second.stops()).toBe(1);
});
