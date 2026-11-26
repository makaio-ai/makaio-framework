import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import type { WebSocketHandler } from 'bun';
import { createBusNamespace } from '@makaio/core';
import { HmacAuth } from '@makaio/bus-transport-websocket';
import { canonicalStringify } from '@makaio/utils';
import { z } from 'zod';
import { createWorkerConnectionExchange } from '../../../../../runtimes/node/src/worker-connection-exchange.js';
import type { BunExchangeUpgradeData } from '../../../../../runtimes/bun/src/bun-route-graph-fetch.js';
import { setupExchangeStorage, TEST_RUNTIME_SECRET } from './worker-exchange-host-storage.js';
import { fixtureToken } from './ordered-worker-fixture.js';
import {
  advanceRefusalClock,
  controlFirstExchangeInputTimeout,
  expireInTransaction,
} from './worker-exchange-controlled-clock.js';
import {
  TEST_EXCHANGE_BUDGET,
  type ExchangeMessage,
  type ExchangeRuntime,
  type ExchangeScenario,
} from './worker-exchange-process-types.js';

const scenario = process.argv[2] as ExchangeScenario;
const runtime = process.argv[3] as ExchangeRuntime;
const directory = process.argv[4] ?? '';
const advanceRefusal = process.argv[5] === 'advance-refusal';
const tls = scenario !== 'plaintext';
const lifetime = new AbortController();
const release = Promise.withResolvers<void>();
const stopped = Promise.withResolvers<void>();
const stopTransport = Promise.withResolvers<void>();
const hmacSecret = 'shared-test-credential';

/** Release all test barriers and cancel work when the supervisor goes away. */
function stop(): void {
  lifetime.abort();
  release.resolve();
  stopped.resolve();
}

process.on('message', (command) => {
  if (command === 'release') release.resolve();
  else if (command === 'stop-transport') stopTransport.resolve();
  else if (command === 'abort-host') {
    lifetime.abort();
    release.resolve();
  } else if (command === 'stop') stop();
});
process.once('disconnect', stop);
if (!process.connected) stop();

/**
 * Send a credential-free test result to the process supervisor.
 * @param message - Test milestone or result.
 */
function report(message: ExchangeMessage): void {
  if (process.connected) process.send?.(message, undefined, undefined, () => {});
}

/** Start the host, then keep it alive until the supervisor releases it. */
async function run(): Promise<void> {
  if (lifetime.signal.aborted) return;
  const fixture = await setupExchangeStorage(
    scenario,
    {
      beforeCommit() {
        report({ kind: 'precommit' });
        return release.promise;
      },
      beforeCorrelation() {
        report({ kind: 'pending-correlation' });
        return release.promise;
      },
      duringDigest() {
        report({ kind: 'digest' });
        return release.promise;
      },
      afterDigest() {
        report({ kind: 'digest-finished' });
      },
      duringCommit() {
        report({ kind: 'commit' });
        return release.promise;
      },
    },
    lifetime.signal,
  );
  try {
    if (!lifetime.signal.aborted) await serveExchange(fixture);
  } finally {
    await fixture.cleanup();
  }
}

/**
 * Serve the isolated exchange until stop or supervisor disconnect.
 * @param fixture - Booted host and isolated storage.
 */
async function serveExchange(fixture: Awaited<ReturnType<typeof setupExchangeStorage>>): Promise<void> {
  const { bus, host, expiresAt } = fixture;
  const setup = bindExchange(host, expiresAt);
  const { subjects } = bus.registerNamespace(
    createBusNamespace('exchangeTest', {
      ping: { request: z.object({}), response: z.object({ principal: z.string() }) },
    }),
  );
  let received = 0;
  let advertised = 0;
  bus.on(subjects.ping, (context) => {
    received += 1;
    context.setResult({ principal: context.call.principal.kind });
  });
  const auth = new HmacAuth({ secret: hmacSecret });
  const checkBoundaryAccess = async (intent: { operation: string }) => {
    if (intent.operation === 'subscribe' || intent.operation === 'register-handler') advertised += 1;
    return undefined;
  };
  let pendingSignal: AbortSignal | undefined;
  const observedSetup = observeExchange(setup, host.database, (signal) => {
    pendingSignal = signal;
  });
  const startListener = () => listen(auth, observedSetup, bus, checkBoundaryAccess);
  let listener = await startListener();
  reportSnapshots(fixture, () => ({ received, advertised }));
  if (scenario === 'silent') controlFirstExchangeInputTimeout(() => report({ kind: 'input-window' }));
  if (advanceRefusal) advanceRefusalClock();
  report({ kind: 'ready', port: listener.port });
  try {
    if (scenario === 'transport-stopped') {
      await Promise.race([stopTransport.promise, stopped.promise]);
      if (lifetime.signal.aborted) return;
      const wasPending = pendingSignal?.aborted === false;
      const closing = listener.close();
      report({ kind: 'transport-stopped', abortedBeforeRelease: wasPending && pendingSignal?.aborted === true });
      release.resolve();
      await closing;
      if (lifetime.signal.aborted) return;
      listener = await startListener();
      report({ kind: 'restarted', port: listener.port });
    }
    await stopped.promise;
  } finally {
    await listener.close();
  }
}

/**
 * Exercise the binding contract before opening the listener.
 * @param host - Real storage and dispatch host.
 * @param expiresAt - Expiry for the fixture's verified allocation proof.
 */
function bindExchange(host: Parameters<typeof createWorkerConnectionExchange>[0], expiresAt: string) {
  return createWorkerConnectionExchange(host, {
    maxPendingExchanges: 1,
    maxBytes: TEST_EXCHANGE_BUDGET,
    async verifyProof(proof, allocation) {
      if (scenario === 'proof-interrupted') throw new Error('Verifier unavailable');
      return proof === allocation.providerData['allocation'] ? expiresAt : undefined;
    },
  });
}

/**
 * Observe each real admission and control the first transaction in deadline cases.
 * @param setup - Worker exchange under test.
 * @param database - Database facade used by the real admission.
 * @param observeSignal - Exposes the active lifetime to the shutdown barrier.
 */
function observeExchange(
  setup: ReturnType<typeof createWorkerConnectionExchange>,
  database: Parameters<typeof createWorkerConnectionExchange>[0]['database'],
  observeSignal: (signal: AbortSignal) => void,
): ReturnType<typeof createWorkerConnectionExchange> {
  let deadlinePhase: 'start' | 'finish' | undefined =
    scenario === 'deadline-after-begin' ? 'start' : scenario === 'deadline-after-commit' ? 'finish' : undefined;
  return {
    ...setup,
    async admit(frame, context) {
      observeSignal(context.signal);
      if (scenario === 'dropped' || scenario === 'dropped-digest' || scenario === 'dropped-commit') {
        context.signal.addEventListener('abort', () => report({ kind: 'peer-gone' }), { once: true });
      }
      let restoreClock: (() => void) | undefined;
      try {
        const admission = await setup.admit(frame, {
          ...context,
          markProofVerified() {
            context.markProofVerified();
            if (deadlinePhase !== undefined) {
              restoreClock = expireInTransaction(database, context.deadline, deadlinePhase);
              deadlinePhase = undefined;
            }
          },
        });
        if (scenario === 'host-aborted') {
          report({ kind: 'committed' });
          await release.promise;
        }
        return admission;
      } finally {
        restoreClock?.();
        report({ kind: 'exchange-finished' });
      }
    },
  };
}

/**
 * Report the persisted booking and observed routing at the supervisor's request.
 * @param fixture - Live storage fixture.
 * @param counters - Current bus observations.
 */
function reportSnapshots(
  fixture: Awaited<ReturnType<typeof setupExchangeStorage>>,
  counters: () => { received: number; advertised: number },
): void {
  process.on('message', (command) => {
    if (command === 'snapshot') {
      void fixture.read().then(
        (rows) => {
          const encoded = canonicalStringify(rows);
          const accepted = rows.owner?.stored?.accepted;
          const payload = accepted?.payload;
          report({
            kind: 'snapshot',
            snapshot: {
              unchanged: encoded === fixture.initial,
              redeemed: rows.owner?.state === 'redeemed',
              bound: rows.dispatch?.boundAllocation != null,
              deadlineMatches:
                typeof payload === 'object' &&
                payload !== null &&
                'latestResultAt' in payload &&
                payload.latestResultAt === accepted?.expiresAt,
              ...counters(),
              noCredentials: !encoded.includes(fixtureToken) && !encoded.includes(TEST_RUNTIME_SECRET),
              ...(scenario === 'dropped-digest' ? { digestReadFollowups: fixture.digestReadFollowups() } : {}),
            },
          });
        },
        () => report({ kind: 'failed', stage: 'snapshot' }),
      );
    }
  });
}

/**
 * Compose one native WebSocket host with real TLS when selected.
 * @param auth - Existing client authentication policy.
 * @param setup - Opt-in exchange policy.
 * @param bus - Running test host bus.
 * @param checkBoundaryAccess - Observes subscription operations at the transport boundary.
 */
async function listen(
  auth: HmacAuth,
  setup: ReturnType<typeof createWorkerConnectionExchange>,
  bus: Awaited<ReturnType<typeof setupExchangeStorage>>['bus'],
  checkBoundaryAccess: (intent: { operation: string }) => Promise<undefined>,
) {
  const keys = tls
    ? {
        key: await readFile(join(directory, 'key.pem')),
        cert: await readFile(join(directory, 'cert.pem')),
      }
    : undefined;
  if (runtime === 'bun') {
    const [
      { serve },
      { Hono },
      { createHonoRouteGraph },
      { BunBusServerTransportProvider },
      { createBunRouteGraphFetch },
    ] = await Promise.all([
      import('bun'),
      import('hono'),
      import('../../../../../runtimes/node/src/hono-route-graph.js'),
      import('../../../../../runtimes/bun/src/bus-server-transport.js'),
      import('../../../../../runtimes/bun/src/bun-route-graph-fetch.js'),
    ]);
    const transport = new BunBusServerTransportProvider({ auth, connectionExchange: setup });
    const fetch = createBunRouteGraphFetch(createHonoRouteGraph(new Hono()), {
      directTls: tls ? true : undefined,
      hasPendingCapacity: () => transport.hasPendingExchangeCapacity,
    });
    const server = serve({
      port: 0,
      hostname: '127.0.0.1',
      tls: keys,
      fetch: (request, server) =>
        fetch(request, {
          upgrade: (target) => server.upgrade(target, { data: undefined }),
          upgradeExchange: (target, data) => server.upgrade(target, { data }),
        }),
      websocket: transport.createWebSocketHandler() as WebSocketHandler<BunExchangeUpgradeData | undefined>,
    });
    await transport.connect(bus, { machineId: 'test', checkBoundaryAccess });
    if (server.port === undefined) throw new Error('Bun listener missing');
    return {
      port: server.port,
      async close() {
        await transport.disconnect();
        // The child owns the native listener. Bun can retain closed TLS sockets
        // during stop, so finish storage cleanup before releasing its OS handles.
        server.unref();
        void server.stop(true);
      },
    };
  }
  const server = keys === undefined ? createHttpServer() : createHttpsServer(keys);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Host listener missing');
  const { BusServerTransportProvider } = await import('../../../../../runtimes/node/src/bus-server-transport.js');
  const transport = new BusServerTransportProvider({ httpServer: server, auth, connectionExchange: { setup } });
  await transport.connect(bus, { machineId: 'test', checkBoundaryAccess });
  return {
    port: address.port,
    async close() {
      await transport.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

try {
  await run();
} catch (error) {
  report({ kind: 'failed', stage: error instanceof Error ? error.name : 'host' });
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
  if (runtime === 'bun') process.exit(process.exitCode ?? 0);
}
