import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CorePartyKind } from '@makaio/core';
import { abortableWait } from '@makaio/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCurrentTest } from 'vitest/suite';
import {
  TEST_EXCHANGE_BUDGET,
  MEASURED_REFUSAL,
  type ExchangeCommand,
  type ExchangeMessage,
  type ExchangeRuntime,
  type ExchangeScenario,
} from './worker-exchange-process-types.js';

type MessageKind = ExchangeMessage['kind'];

const refusal = '{"type":"connection-exchange-result","reject":"rejected"}';
const dialect = process.env['MAKAIO_STORAGE_TEST_DIALECT'] ?? 'sqlite';
const refusalScenarios = [
  'unknown',
  'foreign',
  'wrong-secret',
  'expired',
  'revoked',
  'proof',
  'proof-interrupted',
  'plaintext',
  'malformed',
  'over',
  'stored-over',
  'rollback',
] as const;

let certDirectory: string;

beforeAll(async () => {
  certDirectory = await mkdtemp(join(tmpdir(), 'worker-exchange-'));
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
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      join(certDirectory, 'key.pem'),
      '-out',
      join(certDirectory, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
});

afterAll(async () => {
  await rm(certDirectory, { recursive: true, force: true });
});

/** Track milestones and process lifetime for a single test child. */
class ExchangeProcess {
  private readonly history: ExchangeMessage[] = [];
  private readonly channel = new AbortController();
  private readonly exited = Promise.withResolvers<void>();

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
      this.history.push(message);
      if (message.kind === 'failed') this.channel.abort(message.stage);
    });
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
  public send(command: ExchangeCommand | number): void {
    this.child.send(command, (error) => {
      if (error != null) this.channel.abort('IPC write failed');
    });
  }

  /**
   * Stop the process and wait for exit or failed spawn.
   * @param timeout - The current test's existing timeout, reused for teardown.
   */
  public async stop(timeout: number): Promise<void> {
    if (this.role === 'host') {
      if (this.child.connected) this.send('stop');
    } else {
      this.killIfRunning();
    }
    try {
      await abortableWait(this.exited.promise, AbortSignal.timeout(timeout));
    } catch {
      this.killIfRunning();
      await abortableWait(this.exited.promise, AbortSignal.timeout(timeout)).catch(() => undefined);
      throw new Error(`Exchange ${this.role} did not exit after shutdown`);
    }
    if (this.role === 'host' && !this.testSignal.aborted && this.child.exitCode !== 0) {
      throw new Error('Exchange host exited unsuccessfully during teardown');
    }
  }

  /** Terminate a running child without waiting for its own event loop. */
  private killIfRunning(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }
}

/**
 * Launch a host that creates its own database.
 * @param test - Current test and its lifetime.
 * @param runtime - Native host runtime.
 * @param scenario - Independent connection case.
 */
function startHost(
  test: NonNullable<ReturnType<typeof getCurrentTest>>,
  runtime: ExchangeRuntime,
  scenario: ExchangeScenario,
) {
  const hostFile = fileURLToPath(new URL('./worker-exchange-host-process.ts', import.meta.url));
  const advanceRefusal =
    scenario === 'oversized' || (scenario !== MEASURED_REFUSAL && refusalScenarios.some((item) => item === scenario));
  const hostArguments = [scenario, runtime, certDirectory, ...(advanceRefusal ? ['advance-refusal'] : [])];
  const host = new ExchangeProcess(
    fork(hostFile, hostArguments, {
      execPath: runtime === 'bun' ? 'bun' : process.execPath,
      execArgv: runtime === 'bun' ? [] : ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }),
    'host',
    test.context.signal,
  );
  test.context.onTestFinished(() => host.stop(test.timeout));
  return host;
}

/**
 * Launch one host and independent worker.
 * @param runtime - Native host runtime.
 * @param scenario - Independent connection case.
 */
async function connect(runtime: ExchangeRuntime, scenario: ExchangeScenario) {
  const test = getCurrentTest();
  if (test === undefined) throw new Error('Exchange process setup requires a current test');
  const host = startHost(test, runtime, scenario);
  const peerFile = fileURLToPath(new URL('./worker-exchange-peer-process.ts', import.meta.url));
  const peer = new ExchangeProcess(
    fork(peerFile, [scenario, certDirectory], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }),
    'peer',
    test.context.signal,
  );
  test.context.onTestFinished(() => peer.stop(test.timeout));
  const { port } = await host.event('ready');
  peer.send(port);
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
