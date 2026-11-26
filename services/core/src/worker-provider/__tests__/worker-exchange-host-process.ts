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
import { resourceStep } from '../../../../../runtimes/node/src/runtime-stop-budget.js';
import { createWorkerConnectionExchange } from '../../../../../runtimes/node/src/worker-connection-exchange.js';
import type { BunExchangeUpgradeData } from '../../../../../runtimes/bun/src/bun-route-graph-fetch.js';
import { allocationProofDigest, setupExchangeStorage, TEST_RUNTIME_SECRET } from './worker-exchange-host-storage.js';
import { fixtureToken } from './ordered-worker-fixture.js';
import {
  advanceRefusalClock,
  controlFirstExchangeInputTimeout,
  expireInTransaction,
} from './worker-exchange-controlled-clock.js';
import {
  TEST_EXCHANGE_BUDGET,
  ExchangeHostStartSchema,
  type ExchangeMessage,
  type ExchangeRuntime,
  type ExchangeScenario,
} from './worker-exchange-process-types.js';

const scenario = process.argv[2] as ExchangeScenario;
const runtime = process.argv[3] as ExchangeRuntime;
const directory = process.argv[4] ?? '';
const advanceRefusal = process.argv[5] === 'advance-refusal';
let resumePort = 0;
const tls = scenario !== 'plaintext';
const lifetime = new AbortController();
const release = Promise.withResolvers<void>();
const stopped = Promise.withResolvers<void>();
const stopTransport = Promise.withResolvers<void>();
const finished = Promise.withResolvers<void>();
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

/**
 * Report relative timings only on explicit diagnostic runs.
 * @param phase - Completed startup phase.
 * @param started - Start time on the same monotonic clock.
 */
function reportPhase(phase: string, started = 0): void {
  if (process.env['WORKER_EXCHANGE_TIMINGS'] === '1') report({ kind: 'phase', phase, ms: performance.now() - started });
}

/** Start the host, then keep it alive until the supervisor releases it. */
async function run(): Promise<void> {
  if (lifetime.signal.aborted) return;
  reportPhase('host modules');
  report({ kind: 'host-loaded' });
  const [start]: unknown[] = await once(process, 'message');
  if (lifetime.signal.aborted) return;
  const { database, proof, expiredAt, port } = ExchangeHostStartSchema.parse(start);
  resumePort = port ?? 0;
  const storageStart = performance.now();
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
    database,
    proof,
    expiredAt,
    scenario.startsWith('stock-')
      ? {
          resume: resumePort !== 0,
          send: (auth) => report({ kind: 'stock-launch', auth }),
        }
      : undefined,
  );
  reportPhase('storage and booking', storageStart);
  try {
    if (!lifetime.signal.aborted) await serveExchange(fixture, expiredAt);
  } finally {
    await fixture.cleanup();
  }
}

/**
 * Serve the isolated exchange until stop or supervisor disconnect.
 * @param fixture - Booted host and isolated storage.
 * @param expiredAt - Controlled expiry for a replacement host.
 */
async function serveExchange(
  fixture: Awaited<ReturnType<typeof setupExchangeStorage>>,
  expiredAt: number | undefined,
): Promise<void> {
  const { bus, host, expiresAt } = fixture;
  const setup = bindExchange(host, expiresAt, fixture.shutdown);
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
  const observedSetup = observeExchange(setup, fixture, (signal) => {
    pendingSignal = signal;
  });
  const startListener = () => listen(auth, observedSetup, bus, checkBoundaryAccess);
  let listener = await startListener();
  reportSnapshots(fixture, () => ({ received, advertised }));
  if (scenario === 'silent') controlFirstExchangeInputTimeout(() => report({ kind: 'input-window' }));
  if (advanceRefusal || (scenario === 'stock-expired' && expiredAt !== undefined)) advanceRefusalClock();
  report({ kind: 'ready', port: listener.port });
  if (fixture.shutdown !== undefined) {
    fixture.shutdown.steps.push(resourceStep('bus transport', () => listener.close()));
    await stopped.promise;
    await fixture.shutdown.run();
    if (pendingSignal !== undefined) await finished.promise;
    report({ kind: 'shutdown-finished', aborted: pendingSignal?.aborted === true, routed: received !== 0 });
    return;
  }
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
 * @param shutdown - Real host composition in the shutdown case.
 */
function bindExchange(
  host: Parameters<typeof createWorkerConnectionExchange>[0],
  expiresAt: string,
  shutdown: Awaited<ReturnType<typeof setupExchangeStorage>>['shutdown'],
) {
  const options: Parameters<typeof createWorkerConnectionExchange>[1] = {
    maxPendingExchanges: 1,
    maxBytes: TEST_EXCHANGE_BUDGET,
    async verifyProof(proof, allocation) {
      if (scenario === 'proof-interrupted') throw new Error('Verifier unavailable');
      return typeof proof === 'string' && allocationProofDigest(proof) === allocation.providerData['proofDigest']
        ? expiresAt
        : undefined;
    },
  };
  return shutdown?.connectionExchange(host.supervisionCall, options) ?? createWorkerConnectionExchange(host, options);
}

/**
 * Observe each real admission and control the first transaction in deadline cases.
 * @param setup - Worker exchange under test.
 * @param fixture - Storage and database facade used by the real admission.
 * @param observeSignal - Exposes the active lifetime to the shutdown barrier.
 */
function observeExchange(
  setup: ReturnType<typeof createWorkerConnectionExchange>,
  fixture: Awaited<ReturnType<typeof setupExchangeStorage>>,
  observeSignal: (signal: AbortSignal) => void,
): ReturnType<typeof createWorkerConnectionExchange> {
  let deadlinePhase: 'start' | 'finish' | undefined =
    scenario === 'deadline-after-begin' ? 'start' : scenario === 'deadline-after-commit' ? 'finish' : undefined;
  return {
    ...setup,
    async admit(frame, context) {
      if (scenario.startsWith('stock-')) report({ kind: 'stock-attempt' });
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
              restoreClock = expireInTransaction(fixture.host.database, context.deadline, deadlinePhase);
              deadlinePhase = undefined;
            }
          },
        });
        if (scenario === 'host-aborted') {
          report({ kind: 'committed' });
          await release.promise;
        }
        if (scenario === 'stock-lost' && resumePort === 0 && admission !== undefined) {
          const result = (await fixture.read()).owner?.stored?.accepted;
          if (result?.payload === undefined || result.expiresAt === undefined)
            throw new Error('Missing committed order');
          report({ kind: 'stock-winner', payload: result.payload, expiresAt: result.expiresAt });
          await release.promise;
        }
        return admission;
      } finally {
        restoreClock?.();
        finished.resolve();
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
              noCredentials:
                !encoded.includes(fixtureToken) &&
                !encoded.includes(TEST_RUNTIME_SECRET) &&
                fixture.excludesProof(encoded),
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
  const readStart = performance.now();
  const keys = tls
    ? {
        key: await readFile(join(directory, 'key.pem')),
        cert: await readFile(join(directory, 'cert.pem')),
      }
    : undefined;
  reportPhase('TLS input', readStart);
  const listenerStart = performance.now();
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
      port: resumePort,
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
    reportPhase('listener', listenerStart);
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
  server.listen(resumePort, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Host listener missing');
  const { BusServerTransportProvider } = await import('../../../../../runtimes/node/src/bus-server-transport.js');
  const transport = new BusServerTransportProvider({ httpServer: server, auth, connectionExchange: { setup } });
  await transport.connect(bus, { machineId: 'test', checkBoundaryAccess });
  reportPhase('listener', listenerStart);
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
