import type { WebSocketHandler } from 'bun';
import { expect, test } from 'bun:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KernelExtensionContext } from '@makaio/kernel';
import { createHonoRouteGraph, type MakaioRuntime } from '@makaio/runtime-node';
import { MakaioBus } from '@makaio/bus-core';
import { busContextOf } from '@makaio/bus-core/kernel-api';
import { Hono } from 'hono';
import {
  childProvider,
  dispatchProbeDiscovery,
  installBootOrderTable,
  probeOrder,
  source,
  writeOrder,
} from '../../../node/src/__tests__/worker-dispatch-boot-fixture.js';
import { bootMakaioRuntime, BunBusServerTransportProvider, createBunRouteGraphFetch } from '../index.js';
import type { BunBootMakaioRuntimeOptions } from '../boot.js';

test('Bun dispatches and drains a worker from an extension contribution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bun-worker-dispatch-'));
  const databasePath = join(home, 'makaio.db');
  const transport = new BunBusServerTransportProvider({ loopbackAuthorityHost: '127.0.0.1' });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(),
    websocket: transport.createWebSocketHandler() as WebSocketHandler<undefined>,
  });
  const cleanup: (() => Promise<void>)[] = [];
  const worker = childProvider((dispose) => cleanup.push(dispose));
  let ctx: KernelExtensionContext | undefined;
  const discovery = dispatchProbeDiscovery(
    home,
    () => worker.provider,
    (context) => ({
      async init() {
        ctx = context;
      },
      async destroy() {},
    }),
  );
  let runtime: MakaioRuntime | undefined;
  const { MAKAIO_DATABASE_PATH: previousPath, MAKAIO_DATABASE_URL: previousUrl } = process.env;
  try {
    const { hostname, port } = server;
    if (hostname === undefined || port === undefined) throw new Error('Bun listener unavailable');
    // The runtime selects SQLite through its file settings; a database URL takes precedence.
    delete process.env['MAKAIO_DATABASE_URL'];
    process.env['MAKAIO_DATABASE_PATH'] = databasePath;
    runtime = await bootMakaioRuntime({
      bunServer: { hostname, port },
      transport,
      makaioHome: home,
      frameworkVersion: '3.0.0',
      discovery,
      workerDispatch: {
        scopeSetting: { kind: 'absent' },
        connection: () => ({ busAuth: { kind: 'none' } }),
        source,
      },
    });
    await installBootOrderTable(`file:${databasePath}`);
    if (ctx?.workerDispatch === undefined) throw new Error('Worker dispatch unavailable');
    const dispatch = ctx.workerDispatch;
    const order = probeOrder();
    await writeOrder(ctx, order);
    worker.releaseReply();
    const result = await dispatch.startOrderedWorker(ctx.bus.own('start'), order, ctx.signal);
    const allocationRef = worker.children.get(order.jobRunId)?.ref;
    if (allocationRef === undefined) throw new Error('Worker child unavailable');
    expect(result).toEqual({ kind: 'allocated', allocationRef });
    expect(worker.launches()).toBe(1);
    await runtime.shutdown();
    runtime = undefined;
    expect(worker.stops()).toBe(1);
    expect(worker.children.size).toBe(0);
    expect(await Bun.file(databasePath).exists()).toBe(true);
  } finally {
    if (previousUrl === undefined) delete process.env['MAKAIO_DATABASE_URL'];
    else process.env['MAKAIO_DATABASE_URL'] = previousUrl;
    if (previousPath === undefined) delete process.env['MAKAIO_DATABASE_PATH'];
    else process.env['MAKAIO_DATABASE_PATH'] = previousPath;
    try {
      await runtime?.shutdown();
    } finally {
      try {
        await Promise.all(cleanup.map((dispose) => dispose()));
      } finally {
        try {
          await server.stop(true);
        } finally {
          await rm(home, { recursive: true, force: true });
        }
      }
    }
  }
});

test('Bun rejects worker exchange test mode when the running fetch cannot upgrade it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bun-worker-exchange-'));
  const transport = new BunBusServerTransportProvider({});
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: createBunRouteGraphFetch(createHonoRouteGraph(new Hono())),
    websocket: transport.createWebSocketHandler() as WebSocketHandler<undefined>,
  });
  const { port } = server;
  let runtime: MakaioRuntime | undefined;
  let bootEntered = false;
  try {
    await expect(
      bootMakaioRuntime({
        bunServer: server as BunBootMakaioRuntimeOptions['bunServer'],
        transport,
        makaioHome: home,
        onCancellationBudget: () => {
          bootEntered = true;
        },
        workerDispatch: {
          scopeSetting: { kind: 'absent' },
          connection: () => ({ busAuth: { kind: 'none' } }),
          source,
        },
        workerExchangeTest: {
          maxPendingExchanges: 1,
          async verifyProof() {
            throw new Error('Unexpected proof verification');
          },
          async withRunPromotion() {
            throw new Error('Unexpected run promotion');
          },
        },
      }).then((started) => {
        runtime = started;
      }),
    ).rejects.toThrow('Worker exchange test mode requires a Bun exchange-capable fetch');
    expect(bootEntered).toBe(false);
    expect(busContextOf(MakaioBus).transportRegistry.getTransport('websocket')).toBeUndefined();
  } finally {
    try {
      await runtime?.shutdown();
    } finally {
      await server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  }

  if (port === undefined) throw new Error('Bun listener unavailable');
  const socket = createConnection({ host: '127.0.0.1', port });
  try {
    await expect(once(socket, 'connect')).rejects.toHaveProperty('code', 'ECONNREFUSED');
  } finally {
    socket.destroy();
  }
});
