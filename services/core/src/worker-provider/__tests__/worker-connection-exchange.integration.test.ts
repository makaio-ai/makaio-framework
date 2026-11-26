import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CorePartyKind } from '@makaio/core';
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import { WORKER_REDEMPTION_EXCHANGE, WorkerExchangeReplySchema } from '@makaio/contracts/boundary';
import { WebSocket } from 'ws';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { abortableWait } from '@makaio/utils';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { getCurrentTest } from 'vitest/suite';
import { buildExchangeProcesses } from './worker-exchange-process-build.js';
import { readDispatch } from '../dispatch-store.js';
import { fixtureToken } from './ordered-worker-fixture.js';
import { TEST_RUNTIME_SECRET } from './worker-exchange-host-storage.js';
import { readRedemptionOwnerEndings, readRedemptionOwnerRow } from './redemption-owner-fixture.js';
import {
  createRestartDatabase,
  openExchangeDatabase,
  prepareExchangeDatabase,
  terminateExchangeTestListener,
} from './worker-exchange-restart-storage.js';
import {
  TEST_EXCHANGE_BUDGET,
  MEASURED_REFUSAL,
  OTHER_RUN_ID,
  RUN_ID,
  type ExchangeCommand,
  type ExchangeHostStart,
  type ExchangeMessage,
  type ExchangePeerStart,
  type ExchangeRuntime,
  type ExchangeScenario,
  type StockExchangeScenario,
} from './worker-exchange-process-types.js';

type MessageKind = ExchangeMessage['kind'];
type ExchangeTest = NonNullable<ReturnType<typeof getCurrentTest>>;
type MarkExchangePhase = (phase: string, childMs?: number) => void;
const timings = process.env['WORKER_EXCHANGE_TIMINGS'] === '1';

const refusal = '{"type":"connection-exchange-result","reject":"rejected"}';
const dialect = process.env['MAKAIO_STORAGE_TEST_DIALECT'] ?? 'sqlite';
const refusalScenarios = [
  'unknown',
  'foreign',
  'wrong-secret',
  'identity-wrong',
  'identity-missing',
  'identity-closed',
  'identity-expired',
  'identity-revoked',
  'expired',
  'revoked',
  'proof',
  'proof-replay',
  'proof-interrupted',
  'plaintext',
  'malformed',
  'over',
  'stored-over',
  'rollback',
] as const;

let certDirectory: string;
/** Framework storage directory, located from this file so it holds in any checkout layout and working directory. */
const storageDirectory = fileURLToPath(new URL('../../../../../storage', import.meta.url));
/** Upper bound for the child stderr kept to explain an early exit. */
const STDERR_TAIL_LIMIT = 2_000;
let processDirectory: string;

beforeAll(async () => {
  certDirectory = await mkdtemp(join(tmpdir(), 'worker-exchange-'));
  const beforeCertificate = performance.now();
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-noenc',
      '-days',
      '1',
      '-subj',
      '/CN=Test certificate',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      join(certDirectory, 'key.pem'),
      '-out',
      join(certDirectory, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  reportTiming('TLS certificate', beforeCertificate);
  processDirectory = await mkdtemp(join(process.cwd(), 'node_modules', '.worker-exchange-'));
  const beforeBuild = performance.now();
  await buildExchangeProcesses(processDirectory);
  reportTiming('precompile', beforeBuild);
  const beforeMigration = performance.now();
  await prepareExchangeDatabase(certDirectory);
  reportTiming('template migration', beforeMigration);
});

afterAll(async () => {
  if (processDirectory !== undefined) await rm(processDirectory, { recursive: true, force: true });
  if (certDirectory !== undefined) await rm(certDirectory, { recursive: true, force: true });
});

/**
 * Report timings without process arguments or private launch data.
 * @param phase - Phase being measured.
 * @param started - Starting time on the same monotonic clock.
 */
function reportTiming(phase: string, started: number): void {
  if (timings) console.info(`Exchange phase ${phase}: ${(performance.now() - started).toFixed(2)} ms`);
}

/** Track milestones and process lifetime for a single test child. */
class ExchangeProcess {
  private readonly history: ExchangeMessage[] = [];
  private readonly channel = new AbortController();
  private readonly exited = Promise.withResolvers<void>();
  private crashed = false;
  private stderrTail = '';

  /**
   * @param child - Independent process with an IPC channel.
   * @param role - Process purpose used in failure reports.
   * @param testSignal - Lifetime of the running Vitest test.
   * @param mark - Optional failure-only recorder for the test case.
   */
  public constructor(
    private readonly child: ChildProcess,
    private readonly role: 'host' | 'peer',
    private readonly testSignal: AbortSignal,
    mark?: MarkExchangePhase,
  ) {
    const kill = () => this.killIfRunning();
    testSignal.addEventListener('abort', kill, { once: true });
    child.once('close', () => {
      testSignal.removeEventListener('abort', kill);
      this.channel.abort('process closed');
      this.exited.resolve(); // A failed spawn can close without emitting exit.
    });
    child.once('exit', () => {
      this.channel.abort('exited');
      this.exited.resolve();
    });
    child.once('disconnect', () => this.channel.abort('IPC disconnected'));
    child.on('error', () => this.channel.abort('process error'));
    child.once('spawn', () => mark?.(`${role} spawned`));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });
    child.on('message', (message: ExchangeMessage) => {
      if (message.kind === 'phase') {
        if (mark) mark(`${role}: ${message.phase}`, message.ms);
        else console.info(`Exchange phase ${message.phase}: ${message.ms.toFixed(2)} ms`);
        return;
      }
      mark?.(`${role}: ${message.kind}`);
      this.history.push(message);
      if (message.kind === 'failed') this.channel.abort(message.stage);
    });
  }

  /**
   * Count observed events without exposing launch material.
   * @param kind - Event to count.
   * @returns Number of matching events delivered to this process handle.
   */
  public count(kind: MessageKind): number {
    return this.history.filter((event) => event.kind === kind).length;
  }

  /**
   * Observe a milestone, including ones received before this call.
   * @param kind - Expected message discriminator.
   * @returns Matching report from the process.
   */
  public async event<K extends MessageKind>(kind: K): Promise<Extract<ExchangeMessage, { kind: K }>> {
    const match = (event: ExchangeMessage): event is Extract<ExchangeMessage, { kind: K }> => event.kind === kind;
    const signal = AbortSignal.any([this.channel.signal, this.testSignal]);
    for (;;) {
      const previous = this.history.find(match);
      if (previous !== undefined) {
        this.history.splice(this.history.indexOf(previous), 1);
        return previous;
      }
      try {
        await once(this.child, 'message', { signal });
      } catch {
        const reason = this.channel.signal.aborted ? String(this.channel.signal.reason) : 'test cancelled';
        const stderr = this.stderrTail.trim();
        throw new Error(
          `Exchange ${this.role} stopped before ${kind} (${reason})${stderr === '' ? '' : `\n${this.role} stderr (last ${STDERR_TAIL_LIMIT} chars):\n${stderr}`}`,
        );
      }
    }
  }

  /**
   * Send an audited command and make an IPC write failure visible to milestone waiters.
   * @param command - Supervisor command or the newly listening port.
   */
  public send(
    command:
      | ExchangeCommand
      | number
      | ExchangeHostStart
      | ExchangePeerStart
      | {
          port: number;
          auth: Extract<ExchangeMessage, { kind: 'stock-launch' }>['auth'];
          requireDecoder: boolean;
          reconnect?: boolean;
        },
  ): void {
    this.child.send(command, (error) => {
      if (error != null) this.channel.abort('IPC write failed');
    });
  }

  /**
   * Stop the process and wait for exit or failed spawn.
   * @param timeout - The current test's existing timeout, reused for teardown.
   */
  public async stop(timeout: number): Promise<void> {
    await this.finish(timeout, this.role === 'peer');
  }

  /**
   * Kill a host at a commit barrier and wait until its port can be rebound.
   * @param timeout - Current test budget.
   */
  public async crash(timeout: number): Promise<void> {
    this.crashed = true;
    this.killIfRunning();
    await abortableWait(this.exited.promise, AbortSignal.timeout(timeout));
  }

  /**
   * Wait for the process and IPC to finish.
   * @param timeout - Current test budget.
   * @param kill - Whether to terminate the process immediately.
   */
  private async finish(timeout: number, kill: boolean): Promise<void> {
    if (kill) this.killIfRunning();
    else if (this.child.connected) this.send('stop');
    try {
      await abortableWait(this.exited.promise, AbortSignal.timeout(timeout));
    } catch {
      this.killIfRunning();
      await abortableWait(this.exited.promise, AbortSignal.timeout(timeout)).catch(() => undefined);
      throw new Error(`Exchange ${this.role} did not exit after shutdown`);
    }
    if (this.role === 'host' && !this.testSignal.aborted && this.child.exitCode !== 0 && !this.crashed) {
      throw new Error('Exchange host exited unsuccessfully during teardown');
    }
  }

  /**
   * Confirm natural process exit after a terminal bootstrap result.
   * @param timeout - Current test budget.
   */
  public async waitForExit(timeout: number): Promise<void> {
    await abortableWait(this.exited.promise, AbortSignal.timeout(timeout));
    if (this.child.exitCode !== 0) throw new Error(`Exchange ${this.role} exited unsuccessfully`);
  }

  /** Terminate a running child without waiting for its own event loop. */
  private killIfRunning(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }
}

/**
 * Launch the stock client using the real provider and a restartable host.
 * @param runtime - Native host runtime.
 * @param scenario - Independent worker boot case.
 * @param mark - Optional failure-only recorder for startup milestones.
 */
async function connectStock(runtime: ExchangeRuntime, scenario: StockExchangeScenario, mark?: MarkExchangePhase) {
  const { test, storage, proof } = await prepareCase();
  mark?.('case database ready');
  const holdReconnectDial = scenario === 'stock-reconnect';
  const args = holdReconnectDial ? ['hold-reconnect-dial'] : scenario === 'stock-dns-retry' ? ['dns-retry'] : [];
  const peer = startPeer(test, 'stock', args, scenario !== 'stock-untrusted', mark);
  const initialHost = startHost(test, runtime, scenario, { database: storage.url, proof }, mark);
  let host = initialHost;
  const reconnect = scenario === 'stock-reconnect' || scenario === 'stock-before-sync';
  const restartable =
    reconnect || scenario === 'stock-lost' || scenario === 'stock-dropped' || scenario === 'stock-expired';
  const replacement = restartable ? startHost(test, runtime, scenario) : undefined;
  const [{ port }, { auth }] = await Promise.all([
    host.event('ready'),
    host.event('stock-launch'),
    replacement?.event('host-loaded'),
  ]);
  if (scenario === 'stock-offline') await host.stop(test.timeout);
  peer.send({ port, auth, requireDecoder: scenario === 'stock-no-decoder', reconnect });
  mark?.('worker start sent');
  return {
    initialHost,
    peer,
    waitForWorkerExit: () => peer.waitForExit(test.timeout),
    async snapshot() {
      host.send('snapshot');
      return (await host.event('snapshot')).snapshot;
    },
    async restart(afterBootstrap = false) {
      if (replacement === undefined) throw new Error('Missing prepared replacement process');
      await host.crash(test.timeout);
      const expiredAt =
        afterBootstrap && auth.kind === 'exchange' ? Date.parse(auth.bootstrapDeadlineAt) + 1 : undefined;
      if (expiredAt !== undefined) {
        peer.send('expire-bootstrap');
        await peer.event('stock-clock-expired');
      }
      // Let the deliberate post-proof interruption be the first failed recovery dial.
      // Dialing the closed port during startup would consume a backoff step.
      if (holdReconnectDial) await peer.event('stock-reconnect-dial-held');
      host = replacement;
      host.send({ database: storage.url, proof, expiredAt, port });
      await host.event('ready');
      if (holdReconnectDial) peer.send('release-reconnect-dial');
      return host;
    },
    async shutdown() {
      host.send('stop');
      const result = await host.event('shutdown-finished');
      await host.stop(test.timeout);
      const reopened = await openExchangeDatabase(storage.url);
      try {
        const persisted = await createHostDatabase(reopened.db).transaction(async (tx) => {
          const owner = await readRedemptionOwnerRow(tx, RUN_ID);
          const claim = await readDispatch(tx, RUN_ID);
          return { state: owner?.state, stored: owner?.stored != null, bound: claim?.boundAllocation != null };
        });
        return { result, persisted };
      } finally {
        await reopened.cleanup();
      }
    },
  };
}

describe.each(['node', 'bun'] as const)('stock worker exchange on %s', (runtime) => {
  it('recovers from temporary DNS failure before presenting over verified TLS', async () => {
    const running = await connectStock(runtime, 'stock-dns-retry');
    await running.peer.event('stock-dns-interrupted');
    const result = await Promise.race([running.peer.event('stock-accepted'), running.peer.event('stock-stopped')]);
    expect(result).toEqual({
      kind: 'stock-accepted',
      principal: CorePartyKind.jobRun,
      payload: expect.objectContaining({ order: 'booked' }),
    });
    await expect(running.snapshot()).resolves.toMatchObject({ redeemed: true, bound: true });
    expect(running.initialHost.count('stock-attempt')).toBe(1);
  });

  it('receives its order and opens a run-authenticated connection', async ({ signal }) => {
    const started = performance.now();
    const phases: string[] = [];
    const mark: MarkExchangePhase = (phase, childMs) => {
      if (signal.aborted) return;
      const elapsed = Math.round(performance.now() - started);
      phases.push(`${phase} +${elapsed} ms${childMs === undefined ? '' : ` (child ${Math.round(childMs)} ms)`}`);
    };
    onTestFailed(() => {
      throw new Error(`Stock worker exchange phases: ${phases.join(' → ') || 'none reached'}`);
    });
    const running = await connectStock(runtime, 'stock-success', mark);
    await expect(running.peer.event('stock-accepted')).resolves.toMatchObject({
      principal: CorePartyKind.jobRun,
      payload: { order: 'booked' },
    });
    await expect(running.snapshot()).resolves.toMatchObject({ redeemed: true, bound: true, deadlineMatches: true });
    expect(running.initialHost.count('stock-attempt')).toBe(1);
  });

  it('recovers the committed order after the host dies before replying', async () => {
    const running = await connectStock(runtime, 'stock-lost');
    const { payload } = await running.initialHost.event('stock-winner');
    const replacement = await running.restart(true);
    const recovered = await running.peer.event('stock-accepted');
    expect(recovered.principal).toBe(CorePartyKind.jobRun);
    expect(recovered.payload).toEqual(payload);
    await expect(running.snapshot()).resolves.toMatchObject({ unchanged: true, redeemed: true, bound: true });
    expect(replacement.count('stock-attempt')).toBe(1);
  });

  it('delivers cancellation on the initial checked worker connection', async () => {
    const running = await connectStock(runtime, 'stock-reconnect');
    await running.peer.event('stock-status');
    await expect(running.initialHost.event('stock-status-checked')).resolves.toMatchObject({ cancelAdvertised: true });
    running.initialHost.send('cancel-worker');
    await running.peer.event('stock-cancelled');
    await running.waitForWorkerExit();
  });

  it('rechecks owner status on a fresh identity connection after host loss', async () => {
    const running = await connectStock(runtime, 'stock-reconnect');
    const first = await running.peer.event('stock-status');
    await expect(running.initialHost.event('stock-status-checked')).resolves.toMatchObject({ cancelAdvertised: true });
    const replacement = await running.restart(true);
    const next = await running.peer.event('stock-status');
    expect(next.expiresAt).toBe(first.expiresAt);
    expect(replacement.count('identity-attempt')).toBe(2);
    expect(replacement.count('stock-attempt')).toBe(0);
    await expect(running.snapshot()).resolves.toMatchObject({
      unchanged: true,
      redeemed: true,
      bound: true,
      issuerKeyMatches: true,
    });
    await expect(replacement.event('stock-status-checked')).resolves.toMatchObject({ cancelAdvertised: true });
    replacement.send('cancel-worker');
    await running.peer.event('stock-cancelled');
    await running.waitForWorkerExit();
  });

  it('uses only identity when the socket drops after the reply but before peer sync', async () => {
    const running = await connectStock(runtime, 'stock-before-sync');
    await running.initialHost.event('before-sync');
    await running.peer.event('valid-bootstrap');
    const replacement = await running.restart(true);
    await running.peer.event('stock-status');
    expect(running.peer.count('stock-status')).toBe(0);
    expect(replacement.count('identity-attempt')).toBe(1);
    expect(replacement.count('stock-attempt')).toBe(0);
    await expect(running.snapshot()).resolves.toMatchObject({ unchanged: true, redeemed: true, bound: true });
  });

  it('ends the surviving worker after its issued identity is definitively refused', async () => {
    const running = await connectStock(runtime, 'stock-reconnect');
    await running.peer.event('stock-status');
    running.initialHost.send('close-run');
    await running.initialHost.event('run-closed');
    const replacement = await running.restart(true);
    await expect(running.peer.event('stock-stopped')).resolves.toMatchObject({ code: 'WS_AUTHENTICATION_REJECTED' });
    await running.waitForWorkerExit();
    expect(replacement.count('identity-attempt')).toBe(1);
    expect(replacement.count('stock-attempt')).toBe(0);
    expect(running.peer.count('stock-status')).toBe(0);
  });

  it('retries after a connection drops before the owner commit', async () => {
    const running = await connectStock(runtime, 'stock-dropped');
    await running.initialHost.event('precommit');
    const replacement = await running.restart();
    await expect(running.peer.event('stock-accepted')).resolves.toMatchObject({
      principal: CorePartyKind.jobRun,
      payload: { order: 'booked' },
    });
    await expect(running.snapshot()).resolves.toMatchObject({ unchanged: false, redeemed: true, bound: true });
    expect(replacement.count('stock-attempt')).toBe(1);
  });

  it('refuses an expired first presentation after restarting without a commit', async () => {
    const running = await connectStock(runtime, 'stock-expired');
    await running.initialHost.event('precommit');
    const replacement = await running.restart(true);
    await expect(running.peer.event('stock-stopped')).resolves.toMatchObject({ code: 'WS_AUTHENTICATION_REJECTED' });
    await expect(running.snapshot()).resolves.toMatchObject({ unchanged: true, redeemed: false, bound: false });
    expect(replacement.count('stock-attempt')).toBe(1);
  });

  it('ends at bootstrap expiry when the listener is unavailable before any presentation', async () => {
    const running = await connectStock(runtime, 'stock-offline');
    await expect(running.peer.event('stock-stopped')).resolves.toMatchObject({ code: 'WS_CONNECTION_TIMEOUT' });
    expect(running.initialHost.count('stock-attempt')).toBe(0);
  });

  it('ends after one generic refusal with matching credentials and a foreign proof', async () => {
    const running = await connectStock(runtime, 'stock-refused');
    await expect(running.peer.event('stock-stopped')).resolves.toMatchObject({
      code: 'WS_AUTHENTICATION_REJECTED',
    });
    await running.waitForWorkerExit();
    await expect(running.snapshot()).resolves.toMatchObject({ unchanged: true });
    expect(running.initialHost.count('stock-attempt')).toBe(1);
  });

  it('retries the host interruption close and then receives the first commit', async () => {
    const running = await connectStock(runtime, 'stock-retry');
    await expect(running.peer.event('stock-accepted')).resolves.toMatchObject({
      principal: CorePartyKind.jobRun,
      payload: { order: 'booked' },
    });
    await expect(running.snapshot()).resolves.toMatchObject({ redeemed: true, bound: true });
    expect(running.initialHost.count('stock-attempt')).toBe(2);
  });

  it('ends when the host replay deadline expires during retry', async () => {
    const running = await connectStock(runtime, 'stock-deadline');
    await running.initialHost.event('precommit');
    running.peer.send('expire-replay');
    await running.peer.event('stock-clock-expired');
    running.initialHost.send('release');
    await expect(running.peer.event('stock-stopped')).resolves.toMatchObject({ code: 'WS_CONNECTION_TIMEOUT' });
    await expect(running.snapshot()).resolves.toMatchObject({ unchanged: true });
    expect(running.initialHost.count('stock-attempt')).toBe(2);
  });

  it('drains an open stock exchange during host shutdown', async () => {
    const running = await connectStock(runtime, 'stock-shutdown');
    await running.initialHost.event('precommit');
    // Prepare the replay clock while the worker is still waiting on the open exchange.
    running.peer.send('expire-replay');
    await running.peer.event('stock-clock-expired');
    const { result, persisted } = await running.shutdown();
    // Both rollback and durable commit without a route are valid shutdown outcomes.
    expect(result).toMatchObject({ aborted: true, routed: false });
    expect([
      { state: 'ordered', stored: false, bound: false },
      { state: 'redeemed', stored: true, bound: true },
    ]).toContainEqual(persisted);
    const terminal = await running.peer.event('stock-stopped');
    // A clean socket close can terminate the worker without checking the replay clock.
    expect(['WS_CONNECTION_UNAVAILABLE', 'WS_CONNECTION_TIMEOUT']).toContain(terminal.code);
    await running.waitForWorkerExit();
    expect(running.peer.count('stock-accepted')).toBe(0);
  });

  it('requires a decoder before loading the workflow source', async () => {
    const running = await connectStock(runtime, 'stock-no-decoder');
    await expect(running.peer.event('stock-stopped')).resolves.toMatchObject({
      code: 'WORKFLOW_NOT_EXECUTABLE',
      decoderRequired: true,
    });
    await expect(running.snapshot()).resolves.toMatchObject({ redeemed: true, received: 0 });
  });

  it('ends without presenting anything when the TLS peer is untrusted', async () => {
    const running = await connectStock(runtime, 'stock-untrusted');
    await expect(running.peer.event('stock-stopped')).resolves.toMatchObject({ code: 'WS_POLICY_REJECTED' });
    await expect(running.snapshot()).resolves.toMatchObject({ unchanged: true });
    expect(running.initialHost.count('stock-attempt')).toBe(0);
  });

  it('boots without the exchange mode through the ordinary HMAC client', async () => {
    const running = await connectStock(runtime, 'stock-legacy');
    const accepted = await running.peer.event('stock-accepted');
    expect(accepted.principal).not.toBe(CorePartyKind.jobRun);
    expect(accepted.payload).toBeUndefined();
    await expect(running.snapshot()).resolves.toMatchObject({ unchanged: true, received: 1 });
    expect(running.initialHost.count('stock-attempt')).toBe(0);
  });
});

describe.each(['node', 'bun'] as const)('public boot worker exchange on %s', (runtime) => {
  // Node receives the resolved socket address, so localhost can resolve to an accepted literal.
  const rejectedHosts = ['0.0.0.0', ...(runtime === 'bun' ? (['localhost'] as const) : [])] as const;
  it.each(rejectedHosts)('rejects %s before binding the worker exchange', async (rejectBindHost) => {
    const { test, storage, proof } = await prepareCase(false);
    const host = startHost(test, runtime, 'boot-protected', { database: storage.url, proof, rejectBindHost });
    const { port, message, transportRegistered } = await host.event('boot-rejected');
    expect(message).toBe(
      rejectBindHost === 'localhost'
        ? 'Worker exchange test mode requires a loopback listener with a matching Bun socket address'
        : 'Worker exchange test mode requires a loopback listener',
    );
    expect(transportRegistered).toBe(false);
    expect(host.count('boot-listening')).toBe(0);
    const socket = createConnection({ host: rejectBindHost === '0.0.0.0' ? '127.0.0.1' : rejectBindHost, port });
    test.context.onTestFinished(() => {
      socket.destroy();
    });
    // events.once rejects on the socket error while waiting for a successful connection.
    await expect(once(socket, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it.each([
    ['keeps exchange off by default', 'boot-default'],
    ['admits an opted-in worker after startup', 'admit'],
    ['admits an opted-in worker without explicit auth', 'loopback-auth'],
    ['admits an opted-in worker on IPv4-mapped loopback', 'mapped-loopback'],
    ['preserves the live route on owner rollback', 'rollback'],
    ['retires the live route on owner commit', 'commit'],
  ] as const)('%s', async (_description, outcome) => {
    const scenario = outcome === 'boot-default' ? 'boot-default' : 'boot-protected';
    const { test, storage, proof } = await prepareCase(false);
    const omitLegacyAuth = outcome === 'loopback-auth';
    const bindHost = outcome === 'mapped-loopback' ? '::ffff:127.0.0.1' : undefined;
    const host = startHost(test, runtime, scenario, { database: storage.url, proof, omitLegacyAuth, bindHost });
    const { port } = await host.event('boot-listening');
    await host.event('boot-owner-held');
    const ca = await readFile(join(certDirectory, 'cert.pem'));
    function present() {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/bus/exchange`, { ca, handshakeTimeout: 1_000 });
      ws.on('error', () => {});
      test.context.onTestFinished(() => ws.terminate());
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'connection-exchange',
            exchange: WORKER_REDEMPTION_EXCHANGE,
            presented: { jobRunId: RUN_ID, oneTimeToken: fixtureToken, runtimeSecret: TEST_RUNTIME_SECRET, proof },
          }),
        ),
      );
      return ws;
    }

    if (scenario === 'boot-protected') {
      const [code] = await abortableWait(once(present(), 'close'), test.context.signal);
      expect(code).toBe(1011);
    }
    host.send('release');
    await host.event('ready');
    host.send('boot-snapshot');
    await expect(host.event('boot-snapshot')).resolves.toMatchObject({
      reads: 0,
      proofChecks: 0,
      promotions: 0,
      accepted: false,
      bound: false,
    });

    const legacy = new WebSocketClientTransport({
      url: `wss://127.0.0.1:${port}/bus`,
      auth: omitLegacyAuth ? undefined : new HmacAuth({ secret: 'shared-test-credential' }),
      autoReconnect: false,
      createWebSocket: (endpoint) => new WebSocket(endpoint, { ca }),
    });
    test.context.onTestFinished(() => legacy.disconnect());
    await legacy.connect();
    await abortableWait(legacy.ready, test.context.signal);
    await legacy.disconnect();

    const ws = present();
    const sync = Promise.withResolvers<void>();
    ws.on('message', (raw) => {
      if (JSON.parse(String(raw)).type === 'subscribe-sync-complete') sync.resolve();
    });
    if (scenario === 'boot-default') {
      const closed = new Promise<number>((resolve) => ws.once('close', resolve));
      await expect(abortableWait(closed, test.context.signal)).resolves.toBe(1006);
    } else {
      const [raw] = await abortableWait(once(ws, 'message'), test.context.signal);
      expect(WorkerExchangeReplySchema.parse(JSON.parse(String(raw)))).toMatchObject({
        payload: { order: 'boot-order' },
      });
      await abortableWait(sync.promise, test.context.signal);
    }
    host.send('boot-snapshot');
    const snapshot = await host.event('boot-snapshot');
    if (scenario === 'boot-default') {
      expect(snapshot).toMatchObject({ reads: 0, proofChecks: 0, promotions: 0, accepted: false, bound: false });
    } else {
      expect(snapshot.reads).toBeGreaterThan(0);
      expect(snapshot).toMatchObject({ proofChecks: 1, promotions: 1, accepted: true, bound: true });
      if (outcome === 'rollback') {
        host.send('boot-rollback');
        await expect(host.event('boot-ending')).resolves.toMatchObject({ closed: false, connections: 1 });
        expect(ws.readyState).toBe(WebSocket.OPEN);
      }
      if (outcome === 'commit') {
        const closed = abortableWait(once(ws, 'close'), test.context.signal);
        host.send('boot-close');
        await expect(host.event('boot-ending')).resolves.toMatchObject({ closed: true, connections: 0 });
        const [code] = await closed;
        expect(code).toBe(1008);
      }
    }
  });
});

/**
 * Own one database for one test, including any replacement host.
 * @param seed - Whether to migrate the smaller non-boot fixture instead of leaving storage to full boot.
 * @returns Current test, isolated storage and independent allocation proof.
 */
async function prepareCase(seed = true) {
  const test = getCurrentTest();
  if (test === undefined) throw new Error('Exchange process setup requires a current test');
  const started = performance.now();
  const storage = await createRestartDatabase(certDirectory, seed);
  reportTiming('case database', started);
  test.context.onTestFinished(() => storage.cleanup());
  return { test, storage, proof: randomBytes(16).toString('hex') };
}

/**
 * Start a freshly compiled native host on the isolated database.
 * @param test - Owner of the child process.
 * @param runtime - Native host runtime.
 * @param scenario - Independent connection case.
 * @param start - Start data delivered on private IPC, withheld for a standby host.
 * @param mark - Optional failure-only recorder for the test case.
 */
function startHost(
  test: ExchangeTest,
  runtime: ExchangeRuntime,
  scenario: ExchangeScenario,
  start?: ExchangeHostStart,
  mark?: MarkExchangePhase,
): ExchangeProcess {
  const hostFile = join(processDirectory, 'worker-exchange-host-process.mjs');
  const advanceRefusal =
    scenario === 'oversized' ||
    scenario === 'stock-refused' ||
    (scenario !== MEASURED_REFUSAL && refusalScenarios.some((item) => item === scenario));
  const started = performance.now();
  const child = fork(
    hostFile,
    [scenario, runtime, certDirectory, advanceRefusal ? 'advance-refusal' : '', storageDirectory],
    {
      execPath: runtime === 'bun' ? 'bun' : process.execPath,
      ...(mark ? { env: { ...process.env, WORKER_EXCHANGE_TIMINGS: '1' } } : {}),
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  child.once('spawn', () => reportTiming('host spawn', started));
  const host = new ExchangeProcess(child, 'host', test.context.signal, mark);
  test.context.onTestFinished(() => host.stop(test.timeout));
  if (start !== undefined) host.send(start);
  return host;
}

/**
 * Start the raw protocol probe or stock worker in its own process.
 * @param test - Owner of the child process.
 * @param entry - Executable probe.
 * @param args - Public fixture arguments.
 * @param trustCertificate - Trust the generated CA in the stock TLS client.
 * @param mark - Optional failure-only recorder for the test case.
 */
function startPeer(
  test: ExchangeTest,
  entry: 'peer' | 'stock',
  args: string[],
  trustCertificate = false,
  mark?: MarkExchangePhase,
) {
  const started = performance.now();
  const child = fork(join(processDirectory, `worker-exchange-${entry}-process.mjs`), args, {
    execArgv: [],
    env: {
      ...(trustCertificate ? { NODE_EXTRA_CA_CERTS: join(certDirectory, 'cert.pem') } : {}),
      ...(timings || mark ? { WORKER_EXCHANGE_TIMINGS: '1' } : {}),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.once('spawn', () => reportTiming('worker spawn', started));
  const peer = new ExchangeProcess(child, 'peer', test.context.signal, mark);
  test.context.onTestFinished(() => peer.stop(test.timeout));
  return peer;
}

/**
 * Launch the native host and the separate wire probe.
 * @param runtime - Native host runtime.
 * @param scenario - Independent connection case.
 */
async function connect(runtime: ExchangeRuntime, scenario: ExchangeScenario) {
  const { test, storage, proof } = await prepareCase();
  const host = startHost(test, runtime, scenario, { database: storage.url, proof });
  const peer = startPeer(test, 'peer', [scenario, certDirectory]);
  const { port } = await host.event('ready');
  peer.send({ port, proof });
  return {
    host,
    peer,
    databaseUrl: storage.url,
    connectOtherRun() {
      const other = startPeer(test, 'peer', [scenario, certDirectory]);
      other.send({ port, proof, otherRun: true });
      return other;
    },
    connectIdentity(presentation: 'valid' | 'invalid') {
      const reconnect = startPeer(test, 'peer', [
        presentation === 'valid' ? 'local-takeover-identity' : 'identity-wrong',
        certDirectory,
      ]);
      reconnect.send({ port, proof });
      return reconnect;
    },
    async snapshot() {
      host.send('snapshot');
      return (await host.event('snapshot')).snapshot;
    },
  };
}

/**
 * Start two active native TLS hosts sharing one isolated PostgreSQL database.
 * @param runtime - Native runtime for both hosts.
 * @param listenerTag - Unique tag to hold the second host's notification reconnect, when supplied.
 * @param scenario - Test provider and worker mode.
 * @returns Independent owner and listener processes with supervisor-owned setup.
 */
async function startTwoHosts(
  runtime: ExchangeRuntime,
  listenerTag?: string,
  scenario: 'two-host-revoke' | 'stock-listener-outage' = 'two-host-revoke',
) {
  const { test, storage, proof } = await prepareCase();
  const caseId = randomUUID();
  const topics = { terminal: `test-run-closed:${caseId}`, fence: `test-run-rollback-fence:${caseId}` };
  const owner = startHost(test, runtime, scenario, {
    database: storage.url,
    proof,
    wake: { role: 'owner', ...topics },
  });
  const ownerReady = await owner.event('ready');
  const listener = startHost(test, runtime, scenario, {
    database: storage.url,
    proof,
    wake: { role: 'listener', ...topics, listenerTag },
  });
  const { port } = await listener.event('ready');
  expect(port).not.toBe(ownerReady.port);
  return { owner, listener, test, proof, port, database: storage.url };
}

/**
 * Establish a worker exchange and verify initial subscription routing.
 * @param runtime - Native runtime for both hosts.
 * @param listenerTag - Optional tag to hold recovery.
 * @returns Both hosts and a worker with a live route.
 */
async function connectTwoHosts(runtime: ExchangeRuntime, listenerTag?: string) {
  const hosts = await startTwoHosts(runtime, listenerTag);
  const { test, listener, port, proof } = hosts;
  const peer = startPeer(test, 'peer', ['two-host-revoke', certDirectory]);
  peer.send({ port, proof });
  await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
  listener.send('probe-delivery');
  await expect(listener.event('local-delivery')).resolves.toMatchObject({ delivered: true });
  return { ...hosts, peer };
}

describe.each(['node', 'bun'] as const)('worker exchange on %s', (runtime) => {
  it('takes over only the same live run after verifying an identity reconnect', async () => {
    const {
      host,
      peer: incumbent,
      connectOtherRun,
      connectIdentity,
      databaseUrl,
    } = await connect(runtime, 'local-takeover');
    await incumbent.event('accepted');
    const unrelated = connectOtherRun();
    await unrelated.event('accepted');
    const sibling = await openExchangeDatabase(databaseUrl);
    const database = createHostDatabase(sibling.db);
    const read = (run = RUN_ID) => database.transaction((tx) => readRedemptionOwnerRow(tx, run));
    try {
      const before = await read();
      const issuerKey = before?.booking.identityRevocationKey;
      expect(issuerKey !== undefined && (await read(OTHER_RUN_ID))?.booking.identityRevocationKey === issuerKey).toBe(
        true,
      );
      const refused = connectIdentity('invalid');
      await expect(refused.event('closed')).resolves.toMatchObject({ code: 1008, successReplies: 0 });
      incumbent.send('probe');
      await expect(incumbent.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });

      incumbent.send('pause-wire');
      await incumbent.event('local-peer-paused');
      const replacement = connectIdentity('valid');
      await expect(replacement.event('local-takeover-identity')).resolves.toMatchObject({
        expiresAt: before?.stored?.accepted.expiresAt,
      });
      await expect(replacement.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
      await expect(host.event('local-takeover-published')).resolves.toMatchObject({ retiredDuringPublication: true });
      await expect(host.event('local-retired')).resolves.toMatchObject({ direct: false, subscribed: false });
      host.send('release-native-close');
      incumbent.send('resume-wire');
      await expect(incumbent.event('closed')).resolves.toMatchObject({ code: 1008, successReplies: 1 });
      await host.event('local-native-closed');

      host.send('probe-local-route');
      await expect(host.event('local-route')).resolves.toMatchObject({ delivered: true });
      await replacement.event('local-route-delivered');
      replacement.send('probe');
      await expect(replacement.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
      unrelated.send('probe');
      await expect(unrelated.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
      expect(isDeepStrictEqual(await read(), before)).toBe(true);
      await expect(database.transaction((tx) => readRedemptionOwnerEndings(tx, RUN_ID))).resolves.toHaveLength(0);
    } finally {
      await sibling.cleanup();
    }
  });

  it('fences the replacement when local invalidation reenters incumbent retirement', async () => {
    const { host, peer: incumbent, connectIdentity, snapshot } = await connect(runtime, 'local-takeover-invalidates');
    await incumbent.event('accepted');
    const replacement = connectIdentity('valid');
    await expect(host.event('local-retired')).resolves.toMatchObject({ direct: false, subscribed: false });
    await expect(incumbent.event('closed')).resolves.toMatchObject({ code: 1008, successReplies: 1 });
    await expect(replacement.event('closed')).resolves.toMatchObject({ code: 1008, successReplies: 0 });
    await expect(snapshot()).resolves.toMatchObject({ received: 1, advertised: 1, redeemed: true });
  });

  it('revokes a verified bootstrap while the committed admission is still being returned', async () => {
    const { host, peer, snapshot } = await connect(runtime, 'local-promotion');
    await host.event('committed');
    host.send('close-run');
    await expect(host.event('local-transition-held')).resolves.toMatchObject({ closed: true, facts: 1 });
    host.send('release-terminal');
    await expect(host.event('local-terminal')).resolves.toMatchObject({ closed: true, revoked: true, facts: 1 });
    await expect(peer.event('closed')).resolves.toMatchObject({ code: 1008, successReplies: 0 });
    host.send('release');
    await host.event('exchange-finished');
    expect(host.count('local-promotion-queued')).toBe(0);
    await expect(snapshot()).resolves.toMatchObject({ received: 0, advertised: 0 });
  });

  it.each([
    'close-run',
    'rollback-run',
  ] as const)('publishes a pending bootstrap route only for a live owner after %s', async (command) => {
    const { host, peer, snapshot, databaseUrl } = await connect(runtime, 'local-promotion');
    await host.event('committed');
    const closed = command === 'close-run';
    host.send(command);
    await expect(host.event('local-transition-held')).resolves.toMatchObject({
      closed,
      revoked: closed,
      facts: Number(closed),
    });
    const sibling = await openExchangeDatabase(databaseUrl);
    try {
      const database = createHostDatabase(sibling.db);
      await expect(database.transaction((tx) => readRedemptionOwnerRow(tx, RUN_ID))).resolves.toMatchObject({
        state: closed ? 'closed' : 'redeemed',
        revoked: closed,
      });
    } finally {
      await sibling.cleanup();
    }

    host.send('release');
    await host.event('local-promotion-queued');
    host.send('probe-local-route');
    await expect(host.event('local-route')).resolves.toMatchObject({ delivered: false });
    host.send('release-terminal');
    await expect(host.event('local-terminal')).resolves.toMatchObject({
      closed,
      revoked: closed,
      facts: Number(closed),
    });
    if (!closed) {
      await expect(host.event('local-promotion-reading')).resolves.toMatchObject({ completedTerminalTurns: 1 });
      await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
      host.send('probe-local-route');
      await expect(host.event('local-route')).resolves.toMatchObject({ delivered: true });
      await peer.event('local-route-delivered');
      peer.send('probe');
      await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
      peer.send('drop');
    }
    await expect(peer.event('closed')).resolves.toMatchObject(
      closed ? { code: 1008, successReplies: 0 } : { successReplies: 1 },
    );
    if (closed) expect(host.count('local-promotion-reading')).toBe(0);
    await expect(snapshot()).resolves.toMatchObject({ received: closed ? 0 : 2, advertised: Number(!closed) });
  });

  it.each([
    'local-promotion-repeats',
    'local-promotion-hangs',
  ] as const)('keeps one published route after %s', async (scenario) => {
    const { host, peer, snapshot } = await connect(runtime, scenario);
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
    await host.event('local-promotion-hook-ended');
    peer.send('probe');
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
    await expect(snapshot()).resolves.toMatchObject({ received: 2, advertised: 1 });
    peer.send('drop');
    await expect(peer.event('closed')).resolves.toMatchObject({ successReplies: 1 });
  });

  it('leaves a promotion unroutable after synchronous host interruption', async () => {
    const { host, peer, snapshot } = await connect(runtime, 'local-promotion-aborts');
    await expect(peer.event('closed')).resolves.toMatchObject({ code: 1011, successReplies: 0 });
    await expect(snapshot()).resolves.toMatchObject({ redeemed: true, received: 0 });
    expect(host.count('failed')).toBe(0);
  });

  it.skipIf(dialect !== 'postgres')('retires a live exchange on another host after the owner commits', async () => {
    const { owner, listener, peer } = await connectTwoHosts(runtime);

    owner.send('rollback-run');
    // A separate commit on the same PostgreSQL channel fences earlier notifications.
    await expect(listener.event('remote-rollback-fence')).resolves.toMatchObject({
      terminalWakes: 0,
      closed: false,
      revoked: false,
      facts: 0,
    });
    expect(listener.count('local-retired')).toBe(0);
    peer.send('probe');
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });

    owner.send('close-run');
    await owner.event('run-closed');
    await expect(listener.event('remote-terminal-fact')).resolves.toMatchObject({ facts: 1 });
    await expect(listener.event('local-retired')).resolves.toMatchObject({ direct: false, subscribed: false });
    await expect(peer.event('closed')).resolves.toMatchObject({ code: 1008, successReplies: 1 });
    owner.send('snapshot');
    listener.send('snapshot');
    await expect(owner.event('snapshot')).resolves.toMatchObject({ snapshot: { received: 0 } });
    await expect(listener.event('snapshot')).resolves.toMatchObject({ snapshot: { received: 2 } });
  });

  it.skipIf(dialect !== 'postgres')(
    'withdraws exchange routes during listener loss and refuses the missed remote close after resync',
    async () => {
      const listenerTag = `worker-exchange-${randomUUID()}`;
      const { owner, listener, peer, database, test, port, proof } = await connectTwoHosts(runtime, listenerTag);
      const attemptIdentity = () => {
        const candidate = startPeer(test, 'peer', ['identity-closed', certDirectory]);
        candidate.send({ port, proof });
        return candidate.event('closed');
      };

      const pending = attemptIdentity();
      await listener.event('remote-promotion-held');
      expect(listener.count('remote-listener-disconnected')).toBe(0);
      await terminateExchangeTestListener(database, listenerTag);
      await listener.event('remote-reconnect-held');
      expect(listener.count('remote-listener-disconnected')).toBe(1);
      await expect(listener.event('local-retired')).resolves.toMatchObject({ direct: false, subscribed: false });
      await expect(peer.event('closed')).resolves.toMatchObject({ code: 1011, successReplies: 1 });
      await expect(pending).resolves.toMatchObject({ code: 1011, successReplies: 0 });
      await expect(attemptIdentity()).resolves.toMatchObject({ code: 1011, successReplies: 0 });

      const legacy = startPeer(test, 'peer', ['legacy', certDirectory]);
      legacy.send({ port, proof });
      await expect(legacy.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.anonymous });

      owner.send('close-run');
      await owner.event('run-closed');
      expect(listener.count('remote-resync-reconciled')).toBe(0);

      listener.send('release');
      await listener.event('remote-reconcile-held');
      await expect(attemptIdentity()).resolves.toMatchObject({ code: 1011, successReplies: 0 });
      expect(listener.count('remote-resync-reconciled')).toBe(0);

      listener.send('release-reconcile');
      await expect(listener.event('remote-resync-reconciled')).resolves.toMatchObject({
        facts: 1,
        terminalWakes: 0,
      });
      expect(listener.count('remote-listener-disconnected')).toBe(1);
      await expect(attemptIdentity()).resolves.toMatchObject({ code: 1008, successReplies: 0 });
    },
  );

  it.skipIf(dialect !== 'postgres')(
    'reconnects the stock worker by identity after the latest listener recovery and preserves its expiry',
    async () => {
      const listenerTag = `worker-exchange-${randomUUID()}`;
      const { owner, listener, test, port, database, proof } = await startTwoHosts(
        runtime,
        listenerTag,
        'stock-listener-outage',
      );
      const { auth } = await owner.event('stock-launch');
      const peer = startPeer(test, 'stock', [], true);
      peer.send({ port, auth, requireDecoder: false, reconnect: true });
      const first = await peer.event('stock-status');

      await terminateExchangeTestListener(database, listenerTag);
      await listener.event('remote-reconnect-held');
      await listener.event('local-retired');
      listener.send('release');
      await listener.event('remote-reconcile-held');

      await terminateExchangeTestListener(database, listenerTag);
      await listener.event('remote-reconnect-held');
      await listener.event('remote-reconcile-held');
      expect(listener.count('remote-listener-disconnected')).toBe(2);
      listener.send('release-reconcile');
      await listener.event('remote-resync-superseded');
      const candidate = startPeer(test, 'peer', ['identity-closed', certDirectory]);
      candidate.send({ port, proof });
      await expect(candidate.event('closed')).resolves.toMatchObject({ code: 1011, successReplies: 0 });
      expect(listener.count('identity-attempt')).toBe(0);
      expect(listener.count('remote-resync-reconciled')).toBe(0);

      listener.send('release-reconcile');
      await expect(listener.event('remote-resync-reconciled')).resolves.toMatchObject({ facts: 0, terminalWakes: 0 });

      await expect(peer.event('stock-status')).resolves.toMatchObject({ expiresAt: first.expiresAt });
      expect(peer.count('stock-stopped')).toBe(0);
      expect(listener.count('stock-attempt')).toBe(1);
      expect(listener.count('identity-attempt')).toBe(1);
    },
  );

  it('retires only the locally revoked run after its terminal commit', async () => {
    const { host, peer, snapshot, connectOtherRun } = await connect(runtime, 'local-revoke');
    await peer.event('accepted');
    const other = connectOtherRun();
    await other.event('accepted');
    host.send('rollback-run');
    await expect(host.event('local-terminal')).resolves.toMatchObject({
      closed: false,
      revoked: false,
      grace: false,
      facts: 0,
    });
    peer.send('probe');
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
    host.send('grace-run');
    await expect(host.event('local-terminal')).resolves.toMatchObject({
      closed: false,
      revoked: false,
      grace: true,
      facts: 0,
    });
    host.send('probe-delivery');
    await expect(host.event('local-delivery')).resolves.toMatchObject({ delivered: true });

    peer.send('probe-held');
    await host.event('local-inbound-held');
    host.send('close-run');
    await expect(host.event('local-terminal')).resolves.toMatchObject({ closed: true, revoked: true, facts: 1 });
    await expect(host.event('local-retired')).resolves.toMatchObject({ direct: false, subscribed: false });
    await expect(peer.event('closed')).resolves.toMatchObject({ code: 1008, successReplies: 1 });
    expect(host.count('local-retired')).toBe(0);
    other.send('probe');
    await expect(other.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
    await expect(snapshot()).resolves.toMatchObject({ received: 4 });
  });

  it('retires a local exchange at its idle expiry without further traffic', async () => {
    const { host, peer, snapshot, connectOtherRun } = await connect(runtime, 'local-expiry');
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
    const other = connectOtherRun();
    await other.event('accepted');
    await expect(host.event('local-retired')).resolves.toMatchObject({ direct: false, subscribed: false });
    await expect(peer.event('closed')).resolves.toMatchObject({ code: 1008, successReplies: 1 });
    expect(host.count('local-retired')).toBe(0);
    other.send('probe');
    await expect(other.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
    await expect(snapshot()).resolves.toMatchObject({ redeemed: true, received: 3 });
  });

  it('releases routing only after the owner commit', async () => {
    const { host, peer, snapshot } = await connect(runtime, 'committed');
    await Promise.all([host.event('precommit'), peer.event('preframes')]);
    host.send('release');
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
    await expect(peer.event('closed')).resolves.toMatchObject({ successReplies: 1 });
    await expect(snapshot()).resolves.toEqual({
      unchanged: false,
      redeemed: true,
      bound: true,
      deadlineMatches: true,
      received: 1,
      advertised: 0,
      noCredentials: true,
    });
  });

  it('wakes pending proof preparation after provision correlation commits', async () => {
    const { host, peer, snapshot } = await connect(runtime, 'correlation');
    await host.event('pending-correlation');
    host.send('release');
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
    await expect(snapshot()).resolves.toMatchObject({ redeemed: true, bound: true, received: 1 });
  });

  it.each(refusalScenarios)('refuses %s without changing storage', async (scenario) => {
    const { peer, snapshot } = await connect(runtime, scenario);
    const result = await peer.event('closed');
    expect(result.code).toBe(1008);
    expect(result.reply).toBe(refusal);
    await expect(snapshot()).resolves.toMatchObject({
      unchanged: true,
      received: 0,
      advertised: 0,
      noCredentials: true,
    });
    if (scenario === MEASURED_REFUSAL) {
      console.info(`Exchange refusal (${dialect}, ${runtime}, ${scenario}): ${result.latencyMs.toFixed(2)} ms`);
    }
  });

  it.each([
    ['just-under', TEST_EXCHANGE_BUDGET - 1],
    ['exact', TEST_EXCHANGE_BUDGET],
  ] as const)('commits a multibyte reply %s the budget', async (scenario, bytes) => {
    const { peer, snapshot } = await connect(runtime, scenario);
    await expect(peer.event('accepted')).resolves.toMatchObject({ bytes });
    await expect(snapshot()).resolves.toMatchObject({ redeemed: true, bound: true, deadlineMatches: true });
  });

  it('applies the input size limit before redemption', async () => {
    const { peer, snapshot } = await connect(runtime, 'oversized');
    const result = await peer.event('closed');
    expect(result.code).toBe(runtime === 'node' ? 1009 : 1008);
    expect(result.reply).toBe(runtime === 'node' ? undefined : refusal);
    await expect(snapshot()).resolves.toMatchObject({
      unchanged: true,
      received: 0,
      advertised: 0,
      noCredentials: true,
    });
    if (runtime === 'node') {
      console.info(`Exchange refusal (${dialect}, ${runtime}, oversized): ${result.latencyMs.toFixed(2)} ms`);
    }
  });

  it.each([
    'storage-interrupted',
    'storage-read-interrupted',
  ] as const)('leaves %s after proof retryable and unroutable', async (scenario) => {
    const { peer, snapshot } = await connect(runtime, scenario);
    const result = await peer.event('closed');
    expect(result.code).toBe(1011);
    expect(result.reply).toBeUndefined();
    await expect(snapshot()).resolves.toMatchObject({ unchanged: true, received: 0, advertised: 0 });
  });

  it('rolls back when the absolute exchange deadline elapses during transaction open', async () => {
    const { peer, snapshot } = await connect(runtime, 'deadline-after-begin');
    const result = await peer.event('closed');
    expect(result.code).toBe(1011);
    expect(result.reply).toBeUndefined();
    await expect(snapshot()).resolves.toMatchObject({ unchanged: true, received: 0, advertised: 0 });
  });

  it('only routes a replay when the absolute exchange deadline elapses during a durable commit', async () => {
    const { peer, snapshot } = await connect(runtime, 'deadline-after-commit');
    const result = await peer.event('closed');
    expect(result).toMatchObject({ code: 1011, successReplies: 0 });
    expect(result.reply).toBeUndefined();
    await expect(snapshot()).resolves.toMatchObject({
      redeemed: true,
      bound: true,
      received: 0,
      advertised: 0,
    });
    peer.send('replay');
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
  });

  it('rolls back pending redemption on transport stop and admits a fresh presentation on a new transport', async () => {
    const { host, peer, snapshot } = await connect(runtime, 'transport-stopped');
    await host.event('precommit');
    host.send('stop-transport');
    await expect(host.event('transport-stopped')).resolves.toMatchObject({ abortedBeforeRelease: true });
    await expect(peer.event('closed')).resolves.toMatchObject({ successReplies: 0 });
    await host.event('exchange-finished');
    await expect(snapshot()).resolves.toMatchObject({ unchanged: true, redeemed: false, bound: false, received: 0 });
    const { port } = await host.event('restarted');
    peer.send(port);
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
    await expect(snapshot()).resolves.toMatchObject({ redeemed: true, bound: true, received: 1 });
  });

  it('rolls back when the peer disconnects before commit', async () => {
    const { host, peer, snapshot } = await connect(runtime, 'dropped');
    await Promise.all([host.event('precommit'), peer.event('preframes')]);
    peer.send('drop');
    await Promise.all([peer.event('closed'), host.event('peer-gone')]);
    host.send('release');
    await expect(snapshot()).resolves.toMatchObject({ unchanged: true, received: 0, advertised: 0 });
  });

  it('discards a digest read after the peer closes without starting the authoritative read', async () => {
    const running = await connect(runtime, 'dropped-digest');
    await closeAtBarrier(running, 'digest');
    await Promise.all([running.host.event('exchange-finished'), running.host.event('digest-finished')]);
    await expect(running.snapshot()).resolves.toMatchObject({
      unchanged: true,
      received: 0,
      advertised: 0,
      digestReadFollowups: 0,
    });
  });

  it('retains a commit after the peer closes and allows only the replay to route', async () => {
    const running = await connect(runtime, 'dropped-commit');
    await closeAtBarrier(running, 'commit');
    await running.host.event('exchange-finished');
    await expect(running.snapshot()).resolves.toMatchObject({
      redeemed: true,
      bound: true,
      received: 0,
      advertised: 0,
    });
    running.peer.send('replay');
    await expect(running.peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
  });

  it('keeps a committed exchange unroutable when the host stops before registration', async () => {
    const { host, peer, snapshot } = await connect(runtime, 'host-aborted');
    await host.event('committed');
    host.send('abort-host');
    await expect(peer.event('closed')).resolves.toMatchObject({ code: 1011, successReplies: 0 });
    await expect(snapshot()).resolves.toMatchObject({ redeemed: true, bound: true, received: 0, advertised: 0 });
  });

  it('refuses to send credentials to an untrusted certificate', async () => {
    const { peer, snapshot } = await connect(runtime, 'untrusted');
    await peer.event('tls-rejected');
    await expect(snapshot()).resolves.toMatchObject({ unchanged: true, received: 0, advertised: 0 });
  });

  it('refuses a peer without the legacy credential on the composed port', async () => {
    const { peer, snapshot } = await connect(runtime, 'anonymous');
    await expect(peer.event('closed')).resolves.toMatchObject({ code: 1008 });
    await expect(snapshot()).resolves.toMatchObject({ unchanged: true, received: 0, advertised: 0 });
  });

  it('keeps ordinary HMAC setup available', async () => {
    const { peer, snapshot } = await connect(runtime, 'legacy');
    await peer.event('accepted');
    await expect(snapshot()).resolves.toMatchObject({ unchanged: true, received: 1 });
  });

  it('refuses an upgrade while all exchange slots are in use', async () => {
    const { peer, snapshot } = await connect(runtime, 'capacity');
    const result = await peer.event('capacity-refused');
    expect(result.status).toBe(503);
    await expect(snapshot()).resolves.toMatchObject({ unchanged: true, received: 0, advertised: 0 });
    console.info(`Exchange refusal (${dialect}, ${runtime}, capacity): ${result.latencyMs.toFixed(2)} ms`);
    peer.send('present');
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
  });

  it('releases a silent exchange slot when its input window ends', async () => {
    const { host, peer, snapshot } = await connect(runtime, 'silent');
    await host.event('input-window');
    host.send('expire-input');
    await expect(peer.event('silent-closed')).resolves.toMatchObject({ code: 1006 });
    await expect(peer.event('accepted')).resolves.toMatchObject({ principal: CorePartyKind.jobRun });
    await expect(snapshot()).resolves.toMatchObject({ redeemed: true, bound: true, received: 1 });
  });
});

/**
 * Drop the peer after the test host has reached a named storage boundary.
 * @param running - Currently running independent process pair.
 * @param boundary - Host milestone at which to close the socket.
 */
async function closeAtBarrier({ host, peer }: Awaited<ReturnType<typeof connect>>, boundary: 'digest' | 'commit') {
  await host.event(boundary);
  peer.send('drop');
  await Promise.all([peer.event('closed'), host.event('peer-gone')]);
  host.send('release');
}
