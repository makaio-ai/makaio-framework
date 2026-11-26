import { strictEqual } from 'node:assert';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import type { WebSocketHandler } from 'bun';
import { MakaioBus } from '@makaio/bus-core';
import { busContextOf } from '@makaio/bus-core/kernel-api';
import { HmacAuth, ServerTransport } from '@makaio/bus-transport-websocket';
import { readIssuerIdentityKey } from '../issuer-identity-key.js';
import { serializeByKey } from '@makaio/storage-drizzle';
import type { MakaioRuntime, CoreBootOptions } from '../../../../../runtimes/node/src/boot-types.js';
import type { BunBootMakaioRuntimeOptions } from '../../../../../runtimes/bun/src/boot.js';
import {
  activeContext,
  childProvider,
  dispatchProbeDiscovery,
  probeOrder,
} from '../../../../../runtimes/node/src/__tests__/worker-dispatch-boot-fixture.js';
import type { AtomicRedemptionWorkerOrderSource } from '../start-order.js';
import { readDispatch } from '../dispatch-store.js';
import {
  bookRedemptionOwner,
  migrateRedemptionOwner,
  readRedemptionOwnerRow,
  redemptionOwnerSource,
} from './redemption-owner-fixture.js';
import { fixtureToken } from './ordered-worker-fixture.js';
import { openExchangeDatabase } from './worker-exchange-restart-storage.js';
import {
  RUN_ID,
  type ExchangeHostStart,
  type ExchangeMessage,
  type ExchangeRuntime,
} from './worker-exchange-process-types.js';

interface BootHostProbe {
  readonly start: ExchangeHostStart;
  readonly runtime: ExchangeRuntime;
  readonly directory: string;
  /** Absolute path of the framework `storage` directory that holds the migration chains. */
  readonly storageDirectory: string;
  readonly enabled: boolean;
  readonly signal: AbortSignal;
  readonly release: Promise<void>;
  readonly stopped: Promise<void>;
  report(message: ExchangeMessage): void;
}

/**
 * Exercise full native boot with the fixture's SQL owner and provider contribution.
 * @param probe - Isolated process settings and startup barrier.
 */
export async function runExchangeBootHost(probe: BootHostProbe): Promise<void> {
  if (probe.start.rejectBindHost !== undefined) return probeBootRejection(probe, probe.start.rejectBindHost);

  const cleanup: (() => Promise<void>)[] = [];
  const worker = childProvider((dispose) => cleanup.push(dispose));
  const order = { ...probeOrder(), jobRunId: RUN_ID };
  const ownerTurns = new Map<string, Promise<void>>();
  let owner: Awaited<ReturnType<typeof bookRedemptionOwner>> | undefined;
  let source: AtomicRedemptionWorkerOrderSource | undefined;
  let reads = 0;
  let proofChecks = 0;
  let promotions = 0;
  const backing: AtomicRedemptionWorkerOrderSource = {
    readRedemptionCredentials(id, signal) {
      reads += 1;
      return source?.readRedemptionCredentials(id, signal) ?? Promise.resolve(undefined);
    },
    lockOrder: (tx, id, signal) => source?.lockOrder(tx, id, signal) ?? Promise.resolve(undefined),
    hasStartToken: (order) => source?.hasStartToken(order) ?? false,
    readStartToken: (order) => source?.readStartToken(order),
  };
  const home = join(probe.directory, 'host-home');
  const discovery = dispatchProbeDiscovery(
    home,
    () => worker.provider,
    (ctx) => ({
      async init() {
        const storage = await openExchangeDatabase(probe.start.database);
        cleanup.push(storage.cleanup);
        await migrateRedemptionOwner(storage);
        const { kind, id } = ctx.bus.own('start').caller;
        owner = await bookRedemptionOwner(ctx.database, order, { kind, id }, fixtureToken, false, 'boot-order');
        source = redemptionOwnerSource(storage.executor, fixtureToken);
        probe.report({ kind: 'boot-owner-held' });
        await probe.release;
      },
      async destroy() {},
    }),
  );
  const listener = await startListener(probe, probe.start.bindHost);
  let host: MakaioRuntime | undefined;
  const sqlite = probe.start.database.startsWith('file:');
  if (sqlite) {
    delete process.env['MAKAIO_DATABASE_URL'];
    process.env['MAKAIO_DATABASE_PATH'] = probe.start.database.slice(5);
  }
  try {
    host = await listener.boot({
      discovery,
      makaioHome: home,
      frameworkVersion: '3.0.0',
      database: sqlite
        ? undefined
        : {
            url: probe.start.database,
            engines: [(await import('../../../../../storage/pg/src/index.js')).storageEngine],
          },
      centralMigrationsDir: join(
        probe.storageDirectory,
        sqlite ? join('migrations', 'drizzle') : join('pg', 'drizzle-postgres'),
      ),
      signal: probe.signal,
      onTransportReady: () => probe.report({ kind: 'boot-listening', port: listener.port }),
      workerDispatch: {
        source: backing,
        scopeSetting: { kind: 'absent' },
        connection: () => ({ busAuth: { kind: 'none' } }),
      },
      workerExchangeTest: probe.enabled
        ? {
            maxPendingExchanges: 2,
            async verifyProof(presented, allocation) {
              proofChecks += 1;
              const child = worker.children.get(RUN_ID);
              return presented === probe.start.proof && child?.ref.providerData.pid === allocation.providerData.pid
                ? child?.deadline
                : undefined;
            },
            async withRunPromotion(database, { jobRunId, revocationKey, expiresAt }, signal, publish) {
              await serializeByKey(ownerTurns, jobRunId, async () => {
                signal.throwIfAborted();
                const current = await database.transaction((tx) => backing.lockOrder(tx, jobRunId, signal), {
                  signal,
                });
                if (
                  current?.state === 'redeemed' &&
                  current.redemption?.tokenRevoked === false &&
                  readIssuerIdentityKey(current.redemption) === revocationKey &&
                  current.redemption.stored?.accepted.expiresAt === expiresAt
                ) {
                  signal.throwIfAborted();
                  promotions += 1;
                  publish();
                }
              });
            },
          }
        : undefined,
    });
    const ctx = activeContext(host);
    if (probe.enabled) {
      const dispatch = ctx.workerDispatch;
      if (dispatch === undefined) throw new Error('Boot did not bind the worker dispatch');
      worker.releaseReply();
      await dispatch.startOrderedWorker(ctx.bus.own('start'), order, probe.signal);
    }
    const transport = busContextOf(host.bus).transportRegistry.getTransport('websocket');
    if (!(transport instanceof ServerTransport)) throw new Error('Missing native host WebSocket transport');
    process.on('message', (command) => {
      if (command !== 'boot-close' && command !== 'boot-rollback') return;
      const runOwner = owner;
      if (runOwner === undefined) throw new Error('Missing boot run owner');
      const rollback = command === 'boot-rollback';
      void serializeByKey(ownerTurns, RUN_ID, async () => {
        const key = await runOwner.closeForLocalInvalidation(ctx.bus.own('start'), rollback);
        if (key !== undefined) transport.invalidateExchangeSessions(key);
        const row = await runOwner.read();
        probe.report({
          kind: 'boot-ending',
          closed: row?.state === 'closed',
          connections: transport.getConnectionCount(),
        });
      }).catch(() => probe.report({ kind: 'failed', stage: 'boot ending' }));
    });
    process.on('message', (command) => {
      if (command !== 'boot-snapshot') return;
      void ctx.database
        .transaction(async (tx) => {
          const row = await readRedemptionOwnerRow(tx, RUN_ID);
          const claim = await readDispatch(tx, RUN_ID);
          probe.report({
            kind: 'boot-snapshot',
            reads,
            proofChecks,
            promotions,
            accepted: row?.stored?.accepted !== undefined,
            bound: claim?.boundAllocation != null,
          });
        })
        .catch(() => probe.report({ kind: 'failed', stage: 'boot snapshot' }));
    });
    probe.report({ kind: 'ready', port: listener.port });
    await probe.stopped;
  } finally {
    try {
      await host?.shutdown();
    } finally {
      await Promise.allSettled(cleanup.map((dispose) => dispose()));
      await listener.close();
    }
  }
}

/**
 * Verify a native listener is rejected before boot registers its transport.
 * @param probe - Native runtime and test certificate location.
 * @param hostname - Configured address for the rejection probe.
 */
async function probeBootRejection(probe: BootHostProbe, hostname: string): Promise<void> {
  const listener = await startListener(probe, hostname);
  let rejection: unknown;
  try {
    const runtime = await listener
      .boot({
        signal: probe.signal,
        makaioHome: join(probe.directory, 'rejected-hosts', String(listener.port)),
        onTransportReady: () => probe.report({ kind: 'boot-listening', port: listener.port }),
        workerExchangeTest: {
          maxPendingExchanges: 2,
          async verifyProof() {
            throw new Error('Unexpected proof verification');
          },
          async withRunPromotion() {
            throw new Error('Unexpected run promotion');
          },
        },
      })
      .catch((error: unknown) => {
        rejection = error;
      });
    await runtime?.shutdown();
  } finally {
    await listener.close();
  }
  if (!(rejection instanceof Error)) throw new Error('Expected worker exchange boot to reject the listener');
  probe.report({
    kind: 'boot-rejected',
    message: rejection.message,
    port: listener.port,
    transportRegistered: busContextOf(MakaioBus).transportRegistry.getTransport('websocket') !== undefined,
  });
  await probe.stopped;
}

/**
 * Start the real TLS listener and call its public runtime entry point.
 * @param probe - Native runtime and test certificate location.
 * @param bindHost - Configured listener address.
 */
async function startListener(probe: BootHostProbe, bindHost = '127.0.0.1') {
  const key = await readFile(join(probe.directory, 'key.pem'));
  const cert = await readFile(join(probe.directory, 'cert.pem'));
  const auth = probe.start.omitLegacyAuth ? undefined : new HmacAuth({ secret: 'shared-test-credential' });
  if (probe.runtime === 'node') {
    const { bootMakaioRuntime } = await import('../../../../../runtimes/node/src/boot.js');
    const server = createServer({ key, cert }).listen(0, bindHost);
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Node listener unavailable');
    return {
      port: address.port,
      boot: (options: CoreBootOptions) => bootMakaioRuntime({ ...options, httpServer: server, auth }),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
  const [{ serve }, { Hono }, { createHonoRouteGraph }, bun] = await Promise.all([
    import('bun'),
    import('hono'),
    import('../../../../../runtimes/node/src/hono-route-graph.js'),
    import('../../../../../runtimes/bun/src/index.js'),
  ]);
  const transport = new bun.BunBusServerTransportProvider({ auth });
  const routeGraph = createHonoRouteGraph(new Hono());
  const listener = { port: 0, hostname: bindHost, tls: { key, cert } };
  const server = probe.enabled
    ? bun.serveBunWorkerExchangeTest(routeGraph, transport, listener)
    : serve({
        ...listener,
        fetch: bun.createBunRouteGraphFetch(routeGraph),
        websocket: transport.createWebSocketHandler() as WebSocketHandler<undefined>,
      });
  const { port } = server;
  if (server.hostname === undefined || port === undefined) throw new Error('Bun listener unavailable');
  const nativeServer = server as BunBootMakaioRuntimeOptions['bunServer'];
  return {
    port,
    async boot(options: CoreBootOptions) {
      if (bindHost !== 'localhost') {
        strictEqual(nativeServer.address?.address, bindHost, 'Bun must report the native TCP bind address');
      }
      return bun.bootMakaioRuntime({ ...options, transport, bunServer: nativeServer });
    },
    async close() {
      server.unref();
      // Do not await: after WebSocket upgrades Bun's stop promise can stay pending
      // even with stop(true), which keeps this host alive (see
      // framework/runtimes/bun/src/host-shutdown.ts, stopBunServerForProcessExit).
      void server.stop(true);
    },
  };
}
