import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import type { WebSocketHandler } from 'bun';
import { CorePartyKind, createBusNamespace } from '@makaio/core';
import { createWorkflowCancelSubject } from '@makaio/contracts';
import type { BoundaryAccessCheck, BusEventMessage } from '@makaio/bus-core';
import { busContextOf } from '@makaio/bus-core/kernel-api';
import {
  ConnectionExchangeAuth,
  HmacAuth,
  ServerTransport,
  type ConnectionExchangeAdmission,
  type ConnectionExchangeSetupContext,
} from '@makaio/bus-transport-websocket';
import { WorkerRunIdentityRequestSchema } from '@makaio/contracts/boundary';
import { canonicalStringify } from '@makaio/utils';
import { z } from 'zod';
import { resourceStep } from '../../../../../runtimes/node/src/runtime-stop-budget.js';
import { createWorkerConnectionExchange } from '../../../../../runtimes/node/src/worker-connection-exchange.js';
import type { BunExchangeUpgradeData } from '../../../../../runtimes/bun/src/bun-route-graph-fetch.js';
import {
  verifyExchangeAllocationProof,
  setupExchangeStorage,
  TEST_RUNTIME_SECRET,
} from './worker-exchange-host-storage.js';
import { fixtureToken } from './ordered-worker-fixture.js';
import { exchangeStatus } from './worker-exchange-status.js';
import {
  advanceRefusalClock,
  controlFirstExchangeInputTimeout,
  expireInTransaction,
} from './worker-exchange-controlled-clock.js';
import {
  TEST_EXCHANGE_BUDGET,
  LOCAL_DELIVERY_SUBJECT,
  STOCK_CANCEL_SUBJECT,
  RUN_ID,
  ExchangeHostStartSchema,
  type ExchangeMessage,
  type ExchangeRuntime,
  type ExchangeScenario,
} from './worker-exchange-process-types.js';

const scenario = process.argv[2] as ExchangeScenario;
const localTakeover = scenario === 'local-takeover' || scenario === 'local-takeover-invalidates';
const runtime = process.argv[3] as ExchangeRuntime;
const directory = process.argv[4] ?? '';
const advanceRefusal = process.argv[5] === 'advance-refusal';
const storageDirectory = process.argv[6] ?? '';
let resumePort = 0;
const tls = scenario !== 'plaintext';
const lifetime = new AbortController();
const release = Promise.withResolvers<void>();
const releaseTerminal = Promise.withResolvers<void>();
const heldReconciliations: PromiseWithResolvers<void>[] = [];
const releaseNativeClose = Promise.withResolvers<void>();
const stopped = Promise.withResolvers<void>();
const stopTransport = Promise.withResolvers<void>();
const finished = Promise.withResolvers<void>();
const hmacSecret = 'shared-test-credential';
const cancelSubject = createWorkflowCancelSubject(STOCK_CANCEL_SUBJECT);

/** Release all test barriers and cancel work when the supervisor goes away. */
function stop(): void {
  lifetime.abort();
  release.resolve();
  releaseTerminal.resolve();
  for (const reconciliation of heldReconciliations.splice(0)) reconciliation.resolve();
  releaseNativeClose.resolve();
  stopped.resolve();
}

process.on('message', (command) => {
  if (command === 'release') release.resolve();
  else if (command === 'release-terminal') releaseTerminal.resolve();
  else if (command === 'release-reconcile') heldReconciliations.shift()?.resolve();
  else if (command === 'release-native-close') releaseNativeClose.resolve();
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
  const options = ExchangeHostStartSchema.parse(start);
  if (scenario === 'boot-protected' || scenario === 'boot-default') {
    const { runExchangeBootHost } = await import('./worker-exchange-boot-host.js');
    return runExchangeBootHost({
      start: options,
      runtime,
      directory,
      storageDirectory,
      enabled: scenario === 'boot-protected',
      signal: lifetime.signal,
      release: release.promise,
      stopped: stopped.promise,
      report,
    });
  }
  const { database, proof, expiredAt, port } = options;
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
      beforeWakeReconnect() {
        report({ kind: 'remote-reconnect-held' });
        return release.promise;
      },
      beforeWakeReconcile() {
        const reconciliation = Promise.withResolvers<void>();
        heldReconciliations.push(reconciliation);
        report({ kind: 'remote-reconcile-held' });
        return reconciliation.promise;
      },
    },
    lifetime.signal,
    database,
    proof,
    options,
    scenario.startsWith('stock-')
      ? {
          resume: resumePort !== 0 || options.wake?.role === 'listener',
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
  const setup = bindExchange(
    host,
    expiresAt,
    fixture.shutdown,
    fixture.withRunPromotion(
      scenario === 'local-promotion'
        ? (completedTerminalTurns) => report({ kind: 'local-promotion-reading', completedTerminalTurns })
        : undefined,
    ),
  );
  const { subjects } = bus.registerNamespace(
    createBusNamespace('exchangeTest', {
      ping: { request: z.object({ hold: z.boolean().optional() }), response: z.object({ principal: z.string() }) },
    }),
  );
  let received = 0;
  let advertised = 0;
  let cancelAdvertised = false;
  bus.on(subjects.ping, (context) => {
    received += 1;
    context.setResult({ principal: context.call.principal.kind });
  });
  if (scenario === 'stock-before-sync' || scenario === 'stock-reconnect' || scenario === 'stock-listener-outage') {
    installStatusProbe(fixture, () => cancelAdvertised);
  }
  if (scenario === 'stock-before-sync' && resumePort === 0) interruptFirstSync();
  const auth = new HmacAuth({ secret: hmacSecret });
  const holdInbound = Promise.withResolvers<void>();
  const checkBoundaryAccess: BoundaryAccessCheck = async (intent, call) => {
    if (intent.operation === 'subscribe' || intent.operation === 'register-handler') {
      advertised += 1;
      if (intent.pattern === STOCK_CANCEL_SUBJECT) cancelAdvertised = true;
    }
    if (
      scenario === 'local-revoke' &&
      intent.operation === 'send' &&
      call.principal.id === RUN_ID &&
      intent.payload !== undefined &&
      canonicalStringify(intent.payload) === '{"hold":true}'
    ) {
      report({ kind: 'local-inbound-held' });
      await Promise.race([holdInbound.promise, stopped.promise]);
    }
    return undefined;
  };
  let pendingSignal: AbortSignal | undefined;
  let exchangeConnectionId: string | undefined;
  let exchangeRevocationKey: string | undefined;
  let incumbentRetired = false;
  const observedSetup = observeExchange(
    setup,
    fixture,
    (context, key) => {
      pendingSignal = context.signal;
      exchangeConnectionId = context.connectionId;
      if (key !== undefined) exchangeRevocationKey = key;
    },
    () => incumbentRetired,
  );
  const startListener = () => listen(auth, observedSetup, bus, checkBoundaryAccess);
  let listener = await startListener();
  const unbindWake = await installRetirementObserver(
    fixture,
    () => holdInbound.resolve(),
    () => exchangeConnectionId,
    (transport) => {
      incumbentRetired = true;
      if (scenario === 'local-takeover-invalidates' && exchangeRevocationKey !== undefined) {
        transport.invalidateExchangeSessions(exchangeRevocationKey);
      }
    },
  ).catch(async (error) => {
    await listener.close();
    throw error;
  });
  reportSnapshots(fixture, () => ({ received, advertised }));
  if (scenario === 'stock-reconnect' && resumePort === 0) {
    process.on('message', (command) => {
      if (command !== 'close-run') return;
      void Promise.resolve(fixture.closeRun()).then(
        () => report({ kind: 'run-closed' }),
        () => report({ kind: 'failed', stage: 'close-run' }),
      );
    });
  }
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
    unbindWake?.();
    await listener.close();
  }
}

/**
 * Install retirement observations before announcing host readiness.
 * @param fixture - Host owning the transport.
 * @param releaseInbound - Resume a request paused in the boundary decision.
 * @param exchangeConnectionId - Trusted ID assigned during the exchange.
 * @param retired - Observe logical retirement before the native close.
 * @returns Cleanup for the cross-host listener or owner command when bound.
 */
async function installRetirementObserver(
  fixture: Awaited<ReturnType<typeof setupExchangeStorage>>,
  releaseInbound: () => void,
  exchangeConnectionId: () => string | undefined,
  retired: (transport: ServerTransport) => void,
): Promise<(() => void) | undefined> {
  if (scenario === 'local-revoke' || scenario === 'local-expiry' || scenario === 'local-promotion' || localTakeover) {
    observeLocalRetirement(fixture, releaseInbound, exchangeConnectionId, retired);
  }
  return fixture.twoHostWake?.attach(observeRetirementRoutes(fixture), report);
}

/**
 * Inspect shared routing at the start of native socket close.
 * @param fixture - Host owning the transport.
 * @param exchangeConnectionId - Trusted ID of a socket waiting for local publication, when observed.
 * @param retired - Local observer of logical retirement, when configured.
 * @returns The native host's shared server transport.
 */
function observeRetirementRoutes(
  fixture: Awaited<ReturnType<typeof setupExchangeStorage>>,
  exchangeConnectionId?: () => string | undefined,
  retired?: (transport: ServerTransport) => void,
): ServerTransport {
  const transport = busContextOf(fixture.bus).transportRegistry.getTransport('websocket');
  if (!(transport instanceof ServerTransport)) throw new Error('Missing local WebSocket transport');
  const [namespace = '', subject = ''] = LOCAL_DELIVERY_SUBJECT.split('.');
  const event: BusEventMessage = { type: 'event', namespace, subject, messageId: 'delivery', payload: {} };
  transport.onConnectionClosed((id) => {
    retired?.(transport);
    void Promise.all([transport.sendToConnection(event, id), transport.send(event)]).then(
      ([direct, subscribed]) => report({ kind: 'local-retired', direct, subscribed }),
      () => report({ kind: 'failed', stage: 'local route observation' }),
    );
  });
  process.on('message', (command) => {
    if (command === 'probe-delivery') {
      void transport.send(event).then(
        (delivered) => report({ kind: 'local-delivery', delivered }),
        () => report({ kind: 'failed', stage: 'local delivery' }),
      );
    } else if (command === 'probe-local-route' && exchangeConnectionId !== undefined) {
      const id = exchangeConnectionId();
      if (id === undefined) throw new Error('Missing exchange connection ID');
      void transport.sendToConnection(event, id).then(
        (delivered) => report({ kind: 'local-route', delivered }),
        () => report({ kind: 'failed', stage: 'local route observation' }),
      );
    }
  });
  return transport;
}

/**
 * Drive the single-host owner and observe its shared transport.
 * @param fixture - Real host and test owner.
 * @param releaseInbound - Resume the request paused in the boundary decision.
 * @param exchangeConnectionId - Trusted ID assigned during the exchange.
 * @param retired - Observe logical retirement before native close.
 */
function observeLocalRetirement(
  fixture: Awaited<ReturnType<typeof setupExchangeStorage>>,
  releaseInbound: () => void,
  exchangeConnectionId: () => string | undefined,
  retired: (transport: ServerTransport) => void,
): void {
  const transport = observeRetirementRoutes(fixture, exchangeConnectionId, retired);
  process.on('message', (command) => {
    if (command !== 'close-run' && command !== 'rollback-run' && command !== 'grace-run') return;
    const transition =
      command === 'grace-run'
        ? fixture.enterLocalGrace()
        : fixture.endLocalRun(command === 'rollback-run', async (key) => {
            if (scenario === 'local-promotion') {
              report({ kind: 'local-transition-held', ...(await fixture.terminalFacts()) });
              await releaseTerminal.promise;
            }
            if (key === undefined) return;
            transport.invalidateExchangeSessions(key);
            transport.invalidateExchangeSessions(key);
            releaseInbound();
          });
    void transition
      .then(async () => {
        report({ kind: 'local-terminal', ...(await fixture.terminalFacts()) });
      })
      .catch(() => report({ kind: 'failed', stage: 'local terminal transaction' }));
  });
}

/**
 * Read live state only for the authenticated run, under the same owner lock.
 * @param fixture - Real owner storage and bus.
 * @param didAdvertiseCancel - Whether the worker replayed cancellation before checking its standing.
 */
function installStatusProbe(
  fixture: Awaited<ReturnType<typeof setupExchangeStorage>>,
  didAdvertiseCancel: () => boolean,
): void {
  const { bus, host } = fixture;
  const { subjects } = bus.registerNamespace(exchangeStatus);
  bus.on(subjects.read, async (context) => {
    report({ kind: 'stock-status-checked', cancelAdvertised: didAdvertiseCancel() });
    const { caller } = context.call;
    const { jobRunId } = context.payload;
    const expiresAt =
      caller.kind === CorePartyKind.jobRun && caller.id === jobRunId
        ? await host.database.transaction(async (tx) => {
            const order = await host.source.lockOrder(tx, jobRunId);
            if (order?.state !== 'redeemed' || order.redemption?.tokenRevoked !== false) return undefined;
            const expiry = order.redemption.stored?.accepted.expiresAt;
            return expiry !== undefined && Date.parse(expiry) > Date.now() ? expiry : undefined;
          })
        : undefined;
    context.setResult({ expiresAt });
  });
  process.on('message', (command) => {
    if (command !== 'cancel-worker') return;
    void bus.emit(bus.own('root'), cancelSubject, { executionId: 'exchange-execution' }).catch(() => {
      report({ kind: 'failed', stage: 'worker cancellation' });
    });
  });
}

/** Withhold peer sync on the first real socket until the supervisor kills the host. */
function interruptFirstSync(): void {
  const complete = ConnectionExchangeAuth.prototype.completeServerAuthentication;
  ConnectionExchangeAuth.prototype.completeServerAuthentication = function (socket) {
    ConnectionExchangeAuth.prototype.completeServerAuthentication = complete;
    complete.call(this, socket);
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      if (frame === JSON.stringify({ type: 'subscribe-sync-complete' })) {
        report({ kind: 'before-sync' });
      } else {
        send(frame);
      }
    };
  };
}

/**
 * Exercise the binding contract before opening the listener.
 * @param host - Real storage and dispatch host.
 * @param expiresAt - Expiry for the fixture's verified allocation proof.
 * @param shutdown - Real host composition in the shutdown case.
 * @param withRunPromotion - Same run ordering used by the fixture owner.
 */
function bindExchange(
  host: Parameters<typeof createWorkerConnectionExchange>[0],
  expiresAt: string,
  shutdown: Awaited<ReturnType<typeof setupExchangeStorage>>['shutdown'],
  withRunPromotion: Parameters<typeof createWorkerConnectionExchange>[1]['withRunPromotion'],
) {
  const options: Parameters<typeof createWorkerConnectionExchange>[1] = {
    maxPendingExchanges: 1,
    maxBytes: TEST_EXCHANGE_BUDGET,
    withRunPromotion,
    async verifyProof(proof, allocation) {
      if (scenario === 'proof-interrupted') throw new Error('Verifier unavailable');
      return verifyExchangeAllocationProof(proof, allocation, expiresAt);
    },
  };
  return shutdown?.connectionExchange(host.supervisionCall, options) ?? createWorkerConnectionExchange(host, options);
}

/**
 * Observe each real admission and control the first transaction in deadline cases.
 * @param setup - Worker exchange under test.
 * @param fixture - Storage and database facade used by the real admission.
 * @param observeSignal - Exposes the active lifetime to the shutdown barrier.
 * @param wasRetired - Whether the incumbent's logical retirement was observed.
 */
function observeExchange(
  setup: ReturnType<typeof createWorkerConnectionExchange>,
  fixture: Awaited<ReturnType<typeof setupExchangeStorage>>,
  observeSignal: (context: ConnectionExchangeSetupContext, revocationKey?: string) => void,
  wasRetired: () => boolean,
): ReturnType<typeof createWorkerConnectionExchange> {
  let deadlinePhase: 'start' | 'finish' | undefined =
    scenario === 'deadline-after-begin' ? 'start' : scenario === 'deadline-after-commit' ? 'finish' : undefined;
  let interruptedIdentity = false;
  return {
    ...setup,
    availability: fixture.twoHostWake?.availability,
    async admit(frame, context) {
      if (scenario === 'stock-reconnect' || scenario === 'stock-before-sync' || scenario === 'stock-listener-outage') {
        const parsed: unknown = JSON.parse(frame);
        const identity = WorkerRunIdentityRequestSchema.safeParse(parsed).success;
        report({ kind: identity ? 'identity-attempt' : 'stock-attempt' });
      } else if (scenario.startsWith('stock-')) report({ kind: 'stock-attempt' });
      observeSignal(context);
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
        if (admission === undefined) return undefined;
        const promote = admission.withPromotion?.bind(admission);
        if (promote === undefined) throw new Error('Missing worker owner promotion');
        if (localTakeover && admission.caller.id === RUN_ID) {
          observeSignal(context, admission.revocationKey);
          const identityOnly = WorkerRunIdentityRequestSchema.safeParse(JSON.parse(frame)).success;
          return {
            ...admission,
            withPromotion: (publish: () => void) =>
              promote(() => {
                publish();
                if (identityOnly && scenario === 'local-takeover') {
                  report({ kind: 'local-takeover-published', retiredDuringPublication: wasRetired() });
                }
              }),
          };
        }
        if (scenario === 'host-aborted') {
          report({ kind: 'committed' });
          await release.promise;
        }
        if (scenario === 'local-promotion') {
          report({ kind: 'committed' });
          await release.promise;
          return {
            ...admission,
            withPromotion(publish: () => void) {
              const promotion = promote(publish);
              report({ kind: 'local-promotion-queued' });
              return promotion;
            },
          };
        }
        if (fixture.twoHostWake?.availability !== undefined) {
          return {
            ...admission,
            async withPromotion(publish) {
              if (
                scenario === 'two-host-revoke' &&
                WorkerRunIdentityRequestSchema.safeParse(JSON.parse(frame)).success
              ) {
                report({ kind: 'remote-promotion-held' });
                await release.promise;
              }
              context.signal.throwIfAborted();
              await promote(publish);
            },
          };
        }
        if (scenario.startsWith('local-promotion-')) {
          return controlPromotionHook(admission, context.signal, promote);
        }
        if (scenario === 'stock-lost' && resumePort === 0) {
          const result = (await fixture.read()).owner?.stored?.accepted;
          if (result?.payload === undefined || result.expiresAt === undefined)
            throw new Error('Missing committed order');
          report({ kind: 'stock-winner', payload: result.payload, expiresAt: result.expiresAt });
          await release.promise;
        }
        if (scenario === 'stock-reconnect' && resumePort !== 0 && !interruptedIdentity) {
          interruptedIdentity = true;
          throw new Error('Test interruption after owner verification');
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
 * Exercise host-hook settlement around a verified native exchange.
 * @param admission - Previously committed worker acceptance.
 * @param setupSignal - Fixed setup-window lifetime.
 * @param promote - Verified owner's local promotion gate.
 * @returns The acceptance configured for the selected hook behavior.
 */
function controlPromotionHook(
  admission: ConnectionExchangeAdmission,
  setupSignal: AbortSignal,
  promote: NonNullable<ConnectionExchangeAdmission['withPromotion']>,
): ConnectionExchangeAdmission {
  const interrupt = new AbortController();
  return {
    ...admission,
    hostSignal: AbortSignal.any([admission.hostSignal, interrupt.signal]),
    async withPromotion(publish) {
      if (scenario === 'local-promotion-aborts') {
        interrupt.abort();
        publish();
        throw new Error('Test rejection after synchronous host interruption');
      }

      await promote(() => {
        publish();
        publish();
      });
      if (scenario === 'local-promotion-hangs') {
        setupSignal.addEventListener('abort', () => report({ kind: 'local-promotion-hook-ended' }), { once: true });
        await stopped.promise;
      } else {
        report({ kind: 'local-promotion-hook-ended' });
        throw new Error('Test rejection after publication');
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
              ...(scenario === 'stock-reconnect' || scenario === 'stock-before-sync'
                ? {
                    issuerKeyMatches:
                      accepted != null && accepted.revocationKey === rows.owner?.booking.identityRevocationKey,
                  }
                : {}),
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
  checkBoundaryAccess: BoundaryAccessCheck,
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
      websocket: observeBunNativeClose(
        transport.createWebSocketHandler() as WebSocketHandler<BunExchangeUpgradeData | undefined>,
      ),
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
  if (scenario === 'local-takeover') {
    server.once('upgrade', (_request, socket) => {
      socket.once('close', () => report({ kind: 'local-native-closed' }));
    });
  }
  reportPhase('listener', listenerStart);
  return {
    port: address.port,
    async close() {
      await transport.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Release the incumbent's real Bun close callback only after replacement accepts.
 * @param handler - Native Bun adapter callbacks.
 * @returns The same adapter with observation of its first connection's close.
 */
function observeBunNativeClose(
  handler: WebSocketHandler<BunExchangeUpgradeData | undefined>,
): WebSocketHandler<BunExchangeUpgradeData | undefined> {
  if (scenario !== 'local-takeover') return handler;
  let incumbent: Parameters<NonNullable<typeof handler.open>>[0] | undefined;
  return {
    ...handler,
    open(socket) {
      incumbent ??= socket;
      handler.open?.(socket);
    },
    close(socket, code, reason) {
      if (socket !== incumbent) return handler.close?.(socket, code, reason);
      void releaseNativeClose.promise
        .then(() => {
          handler.close?.(socket, code, reason);
          report({ kind: 'local-native-closed' });
        })
        .catch(() => report({ kind: 'failed', stage: 'native retirement observation' }));
    },
  };
}

try {
  await run();
} catch (error) {
  // The supervisor appends this line to its "stopped before" error; it carries the cause, not launch material.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  report({ kind: 'failed', stage: error instanceof Error ? error.name : 'host' });
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
  if (runtime === 'bun') process.exit(process.exitCode ?? 0);
}
