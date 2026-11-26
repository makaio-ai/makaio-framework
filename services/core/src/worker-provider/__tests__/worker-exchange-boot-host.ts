import { strictEqual, throws } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import type { WebSocketHandler } from 'bun';
import { MakaioBus } from '@makaio/bus-core';
import { busContextOf } from '@makaio/bus-core/kernel-api';
import { JobRunOutcomeNamespace, type JobRunOutcomeHandler } from '@makaio/contracts/workflow';
import { HmacAuth, ServerTransport } from '@makaio/bus-transport-websocket';
import {
  WorkerExchangeListenerConfigurationError,
  type SingleHostWorkerExchangeOptions,
  type WorkerExchangeListenerSecurity,
} from '@makaio/runtime-node';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import { createWorkerRunPromotion } from '../worker-run-sessions.js';
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
  testOutcomeOwnerSource,
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
  let owner: Awaited<ReturnType<typeof bookRedemptionOwner>> | undefined;
  let source: AtomicRedemptionWorkerOrderSource | undefined;
  let reads = 0;
  let proofChecks = 0;
  let promotions = 0;
  /**
   * Verify the presented test proof against the launched allocation.
   * @param presented - Wire proof.
   * @param allocation - Bound provider allocation.
   * @returns The allocation deadline for a matching proof.
   */
  async function verifyProof(
    presented: Parameters<SingleHostWorkerExchangeOptions['verifyProof']>[0],
    allocation: Parameters<SingleHostWorkerExchangeOptions['verifyProof']>[1],
  ) {
    proofChecks += 1;
    const child = worker.children.get(RUN_ID);
    return presented === probe.start.proof && child?.ref.providerData.pid === allocation.providerData.pid
      ? child?.deadline
      : undefined;
  }
  const backing: AtomicRedemptionWorkerOrderSource = {
    readRedemptionCredentials(id, signal) {
      reads += 1;
      return source?.readRedemptionCredentials(id, signal) ?? Promise.resolve(undefined);
    },
    lockOrder: (tx, id, signal) => source?.lockOrder(tx, id, signal) ?? Promise.resolve(undefined),
    hasStartToken: (order) => source?.hasStartToken(order) ?? false,
    readStartToken: (order) => source?.readStartToken(order),
  };
  const outcome = probe.start.exerciseOutcome ? outcomeContribution(probe, () => host) : undefined;
  const home = join(probe.directory, 'host-home');
  const discovery = dispatchProbeDiscovery(
    home,
    () => worker.provider,
    (ctx) => ({
      async init() {
        const storage = await openExchangeDatabase(probe.start.database);
        cleanup.push(storage.cleanup);
        await migrateRedemptionOwner(storage);
        const origin = ctx.bus.own('start');
        const { kind, id } = origin.caller;
        owner = await bookRedemptionOwner(ctx.database, order, { kind, id }, fixtureToken, false, 'boot-order');
        source =
          outcome === undefined
            ? redemptionOwnerSource(storage.executor, fixtureToken)
            : testOutcomeOwnerSource(storage.executor, fixtureToken, origin, false);
        probe.report({ kind: 'boot-owner-held' });
        await probe.release;
      },
      async destroy() {},
    }),
    outcome,
  );
  const supported = await supportedExchangeOptions(probe, verifyProof);
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
      singleHostWorkerExchange: supported,
      workerExchangeTest: probe.enabled
        ? {
            maxPendingExchanges: 2,
            verifyProof,
            async withRunPromotion(database, { jobRunId, revocationKey, expiresAt }, signal, publish) {
              await createWorkerRunPromotion(database, backing)({ jobRunId, revocationKey, expiresAt }, signal, () => {
                promotions += 1;
                publish();
              });
            },
          }
        : undefined,
    });
    throws(() => host?.bus.on(JobRunOutcomeNamespace.subjects.outcome.submit, () => {}), /already has a handler/);
    const ctx = activeContext(host);
    if (probe.enabled || supported !== undefined) {
      const dispatch = ctx.workerDispatch;
      if (dispatch === undefined) throw new Error('Boot did not bind the worker dispatch');
      worker.releaseReply();
      await dispatch.startOrderedWorker(ctx.bus.own('start'), order, probe.signal);
    }
    const transport = bootTransport(host);
    process.on('message', (command) => {
      if (command !== 'boot-revoke-without-notification' || owner === undefined) return;
      void owner
        .revokeWithoutNotification()
        .then(() => probe.report({ kind: 'boot-revoked', connections: transport.getConnectionCount() }))
        .catch(() => probe.report({ kind: 'failed', stage: 'boot revocation' }));
    });
    process.on('message', (command) => {
      if (command !== 'boot-close' && command !== 'boot-rollback') return;
      const runOwner = owner;
      if (runOwner === undefined) throw new Error('Missing boot run owner');
      const rollback = command === 'boot-rollback';
      void (async () => {
        await runOwner.closeForLocalInvalidation(ctx.bus.own('start'), rollback);
        const row = await runOwner.read();
        probe.report({
          kind: 'boot-ending',
          closed: row?.state === 'closed',
          connections: transport.getConnectionCount(),
        });
      })().catch(() => probe.report({ kind: 'failed', stage: 'boot ending' }));
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
    probe.report({ kind: 'ready', port: listener.port, exchangePort: host.workerExchangeAddress?.port });
    await probe.stopped;
  } catch (error) {
    if (!(error instanceof WorkerExchangeListenerConfigurationError) || !expectsListenerRejection(probe.start)) {
      throw error;
    }
    probe.report({
      kind: 'boot-rejected',
      code: error.code,
      message: error.message,
      port: listener.port,
      transportRegistered: busContextOf(MakaioBus).transportRegistry.getTransport('websocket') !== undefined,
    });
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
 * Identify the intentionally invalid listener inputs.
 * @param start - Process case inputs.
 * @returns Whether the test awaits a typed startup rejection.
 */
function expectsListenerRejection({ externalExchange: external }: ExchangeHostStart): boolean {
  return (
    external !== undefined &&
    (external.security === 'unprotected' || external.tlsIssue !== undefined || external.ingressVerifier === 'missing')
  );
}

/**
 * Read the shared WebSocket transport registered by normal boot.
 * @param host - Booted runtime.
 * @returns Native WebSocket bus transport.
 */
function bootTransport(host?: MakaioRuntime): ServerTransport {
  const transport = host && busContextOf(host.bus).transportRegistry.getTransport('websocket');
  if (!(transport instanceof ServerTransport)) throw new Error('Missing native host WebSocket transport');
  return transport;
}

/**
 * Provide the test owner through the normal extension contribution.
 * @param probe - Process barriers and reporting channel.
 * @param host - Current booted runtime.
 * @returns Outcome contribution.
 */
function outcomeContribution(
  probe: BootHostProbe,
  host: () => MakaioRuntime | undefined,
): KernelMakaioExtension['jobRunOutcomes'] {
  const release = Promise.withResolvers<void>();
  process.on('message', (command) => {
    if (command === 'release-outcome') release.resolve();
  });
  return {
    createHandler: (ctx) => async (submission) => {
      if (!(await writeOutcome(ctx, submission))) {
        return { decision: 'refused', code: 'fixture-rollback', retryable: true };
      }
      probe.report({ kind: 'outcome-committed', connections: bootTransport(host()).getConnectionCount() });
      await Promise.race([release.promise, probe.stopped]);
      return { decision: 'accepted' };
    },
  };
}

/**
 * Close through the framework capability, optionally rolling back the owner transaction.
 * @param ctx - Context of the activated owner.
 * @param submission - Bound outcome invocation.
 * @returns Whether the close committed.
 */
async function writeOutcome(
  ctx: KernelExtensionContext,
  { call, result, jobRuns }: Parameters<JobRunOutcomeHandler>[0],
) {
  const rollback = new Error('Rollback requested by fixture');
  try {
    await ctx.database.transaction(async (tx) => {
      await jobRuns.close(call, {
        tx,
        jobRunId: result.jobRunId,
        ending: { kind: 'result', result },
        answer: 'stored',
      });
      if (result.workflowId === 'rollback') throw rollback;
    });
    return true;
  } catch (error) {
    if (error !== rollback) throw error;
    return false;
  }
}

/**
 * Configure the distinct boot-owned listener without giving it ordinary bus routes.
 * @param probe - Native process inputs.
 * @param verifyProof - Verifier for the provisioned test allocation.
 * @returns Supported worker exchange options for the selected case.
 */
async function supportedExchangeOptions(
  probe: BootHostProbe,
  verifyProof: SingleHostWorkerExchangeOptions['verifyProof'],
): Promise<SingleHostWorkerExchangeOptions | undefined> {
  const external = probe.start.externalExchange;
  if (external === undefined) return undefined;
  const options: SingleHostWorkerExchangeOptions = {
    listen: { host: external.host, port: 0 },
    maxBytes: external.maxBytes,
    maxPendingExchanges: 2,
    verifyProof,
    security:
      external.security === 'verified-ingress'
        ? ingressSecurity(external.ingressVerifier)
        : await fixtureTlsSecurity(probe.directory, external.tlsIssue),
  };
  if (external.security === 'unprotected') Reflect.deleteProperty(options, 'security');
  return options;
}

/**
 * Use the generated TLS fixture, with one input replaced for startup rejection cases.
 * @param directory - Generated fixture location.
 * @param issue - Invalid credential to supply, if requested.
 * @returns Native TLS options for the host.
 */
async function fixtureTlsSecurity(
  directory: string,
  issue: NonNullable<ExchangeHostStart['externalExchange']>['tlsIssue'],
): Promise<WorkerExchangeListenerSecurity> {
  let [key, cert] = await Promise.all(['key.pem', 'cert.pem'].map((file) => readFile(join(directory, file), 'utf8')));
  if (issue === 'empty-key') key = '';
  if (issue === 'empty-cert') cert = '';
  if (issue === 'malformed-cert') cert = 'not a certificate';
  if (issue === 'mismatched-key') {
    key = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
  }
  return { kind: 'tls', key, cert };
}

const invalidVerifierResults = {
  throws: () => {
    throw new Error('Test ingress verifier failed');
  },
  truthy: () => 'verified',
  promise: () => Promise.resolve(true),
};

/**
 * Supply the trusted test ingress policy or an invalid implementation from an untyped caller.
 * @param behavior - Invalid verifier behavior, when testing its runtime contract.
 * @returns The ingress policy passed to boot.
 */
function ingressSecurity(
  behavior: NonNullable<ExchangeHostStart['externalExchange']>['ingressVerifier'],
): WorkerExchangeListenerSecurity {
  const security: WorkerExchangeListenerSecurity = {
    kind: 'verified-ingress',
    verifyIngress: ({ peerAddress, headers }) =>
      (peerAddress === '127.0.0.1' || peerAddress === '::1') && headers.get('x-test-ingress-proof') === 'verified',
  };
  if (behavior === 'missing') Reflect.deleteProperty(security, 'verifyIngress');
  else if (behavior !== undefined) Reflect.set(security, 'verifyIngress', invalidVerifierResults[behavior]);
  return security;
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
      // stopBunServerForProcessExit in the Bun host).
      void server.stop(true);
    },
  };
}
