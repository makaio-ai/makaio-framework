import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorePartyKind } from '@makaio/core';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { abortableWait } from '@makaio/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCurrentTest } from 'vitest/suite';
import { buildExchangeProcesses } from './worker-exchange-process-build.js';
import { readDispatch } from '../dispatch-store.js';
import { readRedemptionOwnerRow } from './redemption-owner-fixture.js';
import {
  createRestartDatabase,
  openExchangeDatabase,
  prepareExchangeDatabase,
} from './worker-exchange-restart-storage.js';
import {
  TEST_EXCHANGE_BUDGET,
  MEASURED_REFUSAL,
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
const timings = process.env['WORKER_EXCHANGE_TIMINGS'] === '1';

const refusal = '{"type":"connection-exchange-result","reject":"rejected"}';
const dialect = process.env['MAKAIO_STORAGE_TEST_DIALECT'] ?? 'sqlite';
const refusalScenarios = [
  'unknown',
  'foreign',
  'wrong-secret',
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

  /**
   * @param child - Independent process with an IPC channel.
   * @param role - Process purpose used in failure reports.
   * @param testSignal - Lifetime of the running Vitest test.
   */
  public constructor(
    private readonly child: ChildProcess,
    private readonly role: 'host' | 'peer',
    private readonly testSignal: AbortSignal,
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
    child.on('message', (message: ExchangeMessage) => {
      if (message.kind === 'phase') {
        console.info(`Exchange phase ${message.phase}: ${message.ms.toFixed(2)} ms`);
        return;
      }
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
        throw new Error(`Exchange ${this.role} stopped before ${kind} (${reason})`);
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
 */
async function connectStock(runtime: ExchangeRuntime, scenario: StockExchangeScenario) {
  const { test, storage, proof } = await prepareCase();
  const args = scenario === 'stock-dns-retry' ? ['dns-retry'] : [];
  const peer = startPeer(test, 'stock', args, scenario !== 'stock-untrusted');
  const initialHost = startHost(test, runtime, scenario, { database: storage.url, proof });
  let host = initialHost;
  const replacement =
    scenario === 'stock-lost' || scenario === 'stock-dropped' || scenario === 'stock-expired'
      ? startHost(test, runtime, scenario)
      : undefined;
  const [{ port }, { auth }] = await Promise.all([
    host.event('ready'),
    host.event('stock-launch'),
    replacement?.event('host-loaded'),
  ]);
  if (scenario === 'stock-offline') await host.stop(test.timeout);
  peer.send({ port, auth, requireDecoder: scenario === 'stock-no-decoder' });
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
      // Module loading is complete, but the replacement opens storage and TLS only after the clock event.
      host = replacement;
      host.send({ database: storage.url, proof, expiredAt, port });
      await host.event('ready');
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

  it('receives its order and opens a run-authenticated connection', async () => {
    const running = await connectStock(runtime, 'stock-success');
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
    const { result, persisted } = await running.shutdown();
    // Both rollback and durable commit without a route are valid shutdown outcomes.
    expect(result).toMatchObject({ aborted: true, routed: false });
    expect([
      { state: 'ordered', stored: false, bound: false },
      { state: 'redeemed', stored: true, bound: true },
    ]).toContainEqual(persisted);
    running.peer.send('expire-replay');
    const terminal = await running.peer.event('stock-stopped');
    // A clean stop can close the socket permanently before the replay bound is reached.
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

/**
 * Own one database for one test, including any replacement host.
 * @returns Current test, isolated storage and independent allocation proof.
 */
async function prepareCase() {
  const test = getCurrentTest();
  if (test === undefined) throw new Error('Exchange process setup requires a current test');
  const started = performance.now();
  const storage = await createRestartDatabase(certDirectory);
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
 */
function startHost(
  test: ExchangeTest,
  runtime: ExchangeRuntime,
  scenario: ExchangeScenario,
  start?: ExchangeHostStart,
): ExchangeProcess {
  const hostFile = join(processDirectory, 'worker-exchange-host-process.mjs');
  const advanceRefusal =
    scenario === 'oversized' ||
    scenario === 'stock-refused' ||
    (scenario !== MEASURED_REFUSAL && refusalScenarios.some((item) => item === scenario));
  const started = performance.now();
  const child = fork(hostFile, [scenario, runtime, certDirectory, advanceRefusal ? 'advance-refusal' : ''], {
    execPath: runtime === 'bun' ? 'bun' : process.execPath,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.once('spawn', () => reportTiming('host spawn', started));
  const host = new ExchangeProcess(child, 'host', test.context.signal);
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
 */
function startPeer(test: ExchangeTest, entry: 'peer' | 'stock', args: string[], trustCertificate = false) {
  const started = performance.now();
  const child = fork(join(processDirectory, `worker-exchange-${entry}-process.mjs`), args, {
    execArgv: [],
    env: {
      ...(trustCertificate ? { NODE_EXTRA_CA_CERTS: join(certDirectory, 'cert.pem') } : {}),
      ...(timings ? { WORKER_EXCHANGE_TIMINGS: '1' } : {}),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.once('spawn', () => reportTiming('worker spawn', started));
  const peer = new ExchangeProcess(child, 'peer', test.context.signal);
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
    async snapshot() {
      host.send('snapshot');
      return (await host.event('snapshot')).snapshot;
    },
  };
}

describe.each(['node', 'bun'] as const)('worker exchange on %s', (runtime) => {
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
