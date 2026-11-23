import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import { CONNECTOR_EXIT_OBSERVATION_MS, GenerationRetirementLedger } from '@makaio/ai-adapters-core';
import type { IJsonlTransport, MessageListener, TransportEnd, TransportStatus } from '@makaio/subprocess';
import type { ConnectionManagerContext } from '../connection-manager.js';
import {
  CodexConnectionResetError,
  connectorTransport,
  initializeConnection,
  resetClient,
  superviseGenerationEnd,
} from '../connection-manager.js';
import type { JsonRpcClient } from '../../utils/jsonRpcClient.js';
import {
  createFakeAppServerTransport,
  MockJsonRpcClient,
  transportEnd,
  type FakeAppServerTransport,
} from '../../__tests__/shared.js';

/** One call the connection manager made into the connector. */
type ConnectorCall =
  | { readonly kind: 'error'; readonly message: string; readonly terminate: boolean }
  | { readonly kind: 'requested-finalisation'; readonly end: TransportEnd };

/** Observable connection state a reset is expected to have cleared. */
interface HarnessState {
  readonly client: JsonRpcClient | undefined;
  readonly ownedTransport: IJsonlTransport | undefined;
  readonly connected: boolean;
  readonly handlersRegistered: boolean;
  readonly disabledNativeTools: ReadonlySet<string>;
}

/** Inputs of one harness. */
interface HarnessOptions {
  /** Client the connector starts out holding. */
  readonly client?: JsonRpcClient;
  /** Transport the connector starts out owning. */
  readonly ownedTransport?: IJsonlTransport;
  /** Transport injected into the connector instead of a spawned one. */
  readonly injectedTransport?: IJsonlTransport;
  /** Working directory a spawned app-server runs in. */
  readonly cwd?: string;
  /** Binary a spawned app-server runs. */
  readonly binaryPath?: string;
}

/** Connection-manager context around recorded connector calls. */
interface Harness {
  readonly context: ConnectionManagerContext;
  readonly state: () => HarnessState;
  /** Every call the manager made into the connector, in order. */
  readonly calls: ConnectorCall[];
  /** Every transport the manager spawned, in order. */
  readonly spawned: IJsonlTransport[];
  /** The connector-lifetime ledger the reset retires generations against. */
  readonly generations: GenerationRetirementLedger;
  /** Single-flight holder for {@link initializeConnection}. */
  readonly inflight: { promise: Promise<void> | undefined };
}

/**
 * Build mutable connection state that records what the manager asks of the connector.
 * @param options - Initial client and transport, or where a spawned app-server runs.
 * @returns Connection-manager harness.
 */
function createHarness(options: HarnessOptions = {}): Harness {
  let client = options.client;
  let ownedTransport = options.ownedTransport;
  let connected = options.client !== undefined;
  let handlersRegistered = options.client !== undefined;
  let disabledNativeTools: ReadonlySet<string> = new Set(['bash']);
  const generations = new GenerationRetirementLedger('codex app-server process');
  const calls: ConnectorCall[] = [];
  const spawned: IJsonlTransport[] = [];

  return {
    generations,
    calls,
    spawned,
    inflight: { promise: undefined },
    context: {
      getJsonRpcClient: () => client,
      setJsonRpcClient: (value) => {
        client = value;
      },
      getInjectedJsonRpcClient: () => undefined,
      getInjectedTransport: () => options.injectedTransport,
      getOwnedTransport: () => ownedTransport,
      setOwnedTransport: (value) => {
        if (value !== undefined) spawned.push(value);
        ownedTransport = value;
      },
      getIsConnected: () => connected,
      setIsConnected: (value) => {
        connected = value;
      },
      setClientHandlersRegistered: (value) => {
        handlersRegistered = value;
      },
      setDisabledNativeTools: (value) => {
        disabledNativeTools = value;
      },
      cwd: options.cwd ?? tmpdir(),
      env: {},
      adapterName: 'codex-app-server',
      clientId: 'codex',
      clientExecution:
        options.binaryPath === undefined
          ? undefined
          : { binaryPath: options.binaryPath, env: {}, configDir: null, source: 'managed', version: null },
      getAccountLogin: () => undefined,
      harnessId: undefined,
      globalBus: MakaioBus,
      generations,
      registerClientHandlers: () => undefined,
      handleError: (error, terminate) => {
        calls.push({ kind: 'error', message: error instanceof Error ? error.message : String(error), terminate });
        // Like the connector, whose terminal error aborts it and closes its client.
        if (terminate) client?.close();
      },
      finalizeRequestedShutdown: (end) => {
        calls.push({ kind: 'requested-finalisation', end });
      },
    },
    state: () => ({ client, ownedTransport, connected, handlersRegistered, disabledNativeTools }),
  };
}

/**
 * Build a harness holding a connected client over a fake owned transport.
 * @param closeClient - Client close behaviour injected by the test.
 * @param closeTransport - Transport close behaviour injected by the test.
 * @returns The harness and the fake transport it owns.
 */
function createResetHarness(
  closeClient: () => void,
  closeTransport: () => void,
): { readonly harness: Harness; readonly fake: FakeAppServerTransport } {
  const client = new MockJsonRpcClient();
  client.close = closeClient;
  const fake = createFakeAppServerTransport(closeTransport);
  return { harness: createHarness({ client, ownedTransport: fake.transport }), fake };
}

/**
 * Build an injected app-server channel that answers `initialize` with an error
 * and, like every transport, ends with a requested end when it is closed.
 * @returns The channel.
 */
function createHandshakeRefusingTransport(): IJsonlTransport {
  const listeners = new Set<MessageListener>();
  const ended = Promise.withResolvers<TransportEnd>();
  let status: TransportStatus = 'writable';
  return {
    send: (message) => {
      if (!('method' in message) || message.method !== 'initialize' || !('id' in message)) return;
      const response = { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'not ready' } };
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener(response);
      });
    },
    close: () => {
      if (status !== 'ended') {
        status = 'ended';
        ended.resolve(transportEnd('requested'));
      }
      return ended.promise;
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ended: ended.promise,
    exitObserved: new Promise(() => undefined),
    get status() {
      return status;
    },
  };
}

/**
 * Let every queued promise reaction and timer callback of the current turn run.
 * @returns Promise settled on the next macrotask.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('Codex connection manager cleanup', () => {
  it('resets and closes an owned process client after a failed ready handshake', async () => {
    const closeClient = vi.fn();
    const closeTransport = vi.fn();
    const { harness, fake } = createResetHarness(closeClient, closeTransport);

    fake.publishExit();
    await resetClient(harness.context);
    const state = harness.state();

    expect(state.connected).toBe(false);
    expect(state.handlersRegistered).toBe(false);
    expect(state.disabledNativeTools.size).toBe(0);
    expect(closeClient).toHaveBeenCalledOnce();
    expect(closeTransport).not.toHaveBeenCalled();
    expect(state.ownedTransport).toBeUndefined();
    expect(state.client).toBeUndefined();
  });

  it('attempts transport fallback, clears retry state, and sanitizes simultaneous reset failures', async () => {
    const closeClient = vi.fn(() => {
      throw new Error('client close echoed private-api-key');
    });
    const closeTransport = vi.fn(() => {
      throw new Error('transport close echoed private-api-key');
    });
    const { harness, fake } = createResetHarness(closeClient, closeTransport);

    fake.publishExit();
    let resetError: unknown;
    try {
      await resetClient(harness.context);
    } catch (error) {
      resetError = error;
    }
    const state = harness.state();

    expect(resetError).toBeInstanceOf(AggregateError);
    expect((resetError as AggregateError).errors).toEqual([
      expect.objectContaining<Partial<CodexConnectionResetError>>({ reason: 'client-close-failed' }),
      expect.objectContaining<Partial<CodexConnectionResetError>>({ reason: 'transport-close-failed' }),
    ]);
    expect((resetError as Error).message).not.toContain('private-api-key');
    expect(closeClient).toHaveBeenCalledOnce();
    expect(closeTransport).toHaveBeenCalledOnce();
    expect(state.ownedTransport).toBeUndefined();
    expect(state.client).toBeUndefined();
    // Even a reset that could not close cleanly books its generation: that is the
    // case where the predecessor is most likely still alive.
    expect(harness.generations.unretiredDetail()).toBeUndefined();
  });
});

/**
 * One evaluation of each generation's end, bound to that generation: a close
 * issued while an unexpected end is delivered finalises nothing a second time.
 *
 * The transport derives the cause from the order of what it observed, so the
 * evaluation only has to decide whose end it is: a generation that still answers
 * for the connector finalises the connector's turn, and one a reset superseded
 * reaches nothing — not the generation that replaced it, and not its turn.
 */
describe('Codex generation end evaluation', () => {
  it('ends an injected transport whose handshake failed, and terminates through its requested end', async () => {
    const injected = createHandshakeRefusingTransport();
    const harness = createHarness({ injectedTransport: injected });
    // As the connector constructor does for an injected transport.
    superviseGenerationEnd(harness.context, injected);

    await expect(initializeConnection(createTestCall(), harness.context, harness.inflight)).rejects.toThrow(
      'not ready',
    );
    await settle();

    // An injected transport cannot be replaced, so the reset ends it for good.
    expect(injected.status).toBe('ended');
    expect(harness.calls).toEqual([{ kind: 'requested-finalisation', end: transportEnd('requested') }]);
    expect(harness.state().client).toBeUndefined();
  });

  it('finalises a requested end of the current generation locally, once, without a terminal error', async () => {
    const fake = createFakeAppServerTransport();
    const harness = createHarness({ ownedTransport: fake.transport });

    superviseGenerationEnd(harness.context, fake.transport);
    fake.publishEnd(transportEnd('requested'));
    await settle();

    expect(harness.calls).toEqual([{ kind: 'requested-finalisation', end: transportEnd('requested') }]);
  });

  it.each([
    ['an unexpected end', transportEnd('unexpected', { kind: 'exited', code: 4, signal: null })],
    [
      'a failed spawn',
      transportEnd('spawn-failed', {
        kind: 'spawn-failed',
        error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
      }),
    ],
  ])('terminates on %s of the current generation, once', async (_label, end) => {
    const fake = createFakeAppServerTransport();
    const harness = createHarness({ ownedTransport: fake.transport });

    superviseGenerationEnd(harness.context, fake.transport);
    fake.publishEnd(end);
    await settle();

    expect(harness.calls).toEqual([
      {
        kind: 'error',
        message: expect.stringMatching(/^codex app-server (ended unexpectedly|failed to start)/),
        terminate: true,
      },
    ]);
  });

  it.each([
    'requested',
    'unexpected',
  ] as const)('lets a %s end of a superseded generation reach neither the new generation nor its turn', async (cause) => {
    const previous = createFakeAppServerTransport();
    const current = createFakeAppServerTransport();
    const harness = createHarness({ ownedTransport: previous.transport });
    superviseGenerationEnd(harness.context, previous.transport);
    superviseGenerationEnd(harness.context, current.transport);

    // A reset released the previous generation and a retry replaced it.
    harness.context.setOwnedTransport(current.transport);
    previous.publishEnd(transportEnd(cause));
    await settle();

    expect(harness.calls).toEqual([]);

    current.publishEnd(transportEnd('unexpected', { kind: 'exited', code: 4, signal: null }));
    await settle();

    expect(harness.calls).toEqual([
      { kind: 'error', message: 'codex app-server ended unexpectedly: exited with code 4', terminate: true },
    ]);
  });
});

// Case 226, codex arms 1 and 2 — I33 at this connector's own choke point.
describe('Codex generation retirement (I33)', () => {
  it('arm 1 — the reset consumes the dropped process exit before it returns', async () => {
    const { harness, fake } = createResetHarness(
      () => undefined,
      () => undefined,
    );
    const order: string[] = [];

    // Ordering, not a call count: a reset that merely *dropped* the transport
    // would also finish, so what is asserted is that the reset had not returned
    // while the predecessor's end was still unobserved.
    const reset = resetClient(harness.context).then(() => {
      order.push('reset-returned');
    });
    await Promise.resolve();
    expect(order).toEqual([]);

    order.push('exit-published');
    fake.publishExit();
    await reset;

    expect(order).toEqual(['exit-published', 'reset-returned']);
    expect(harness.generations.unretiredDetail()).toBeUndefined();
  });

  it('arm 2 — a stuck predecessor completes the reset, caps every later class, and a late exit lifts the cap', async () => {
    vi.useFakeTimers();
    try {
      const { harness, fake } = createResetHarness(
        () => undefined,
        () => undefined,
      );

      const reset = resetClient(harness.context);
      // The end report alone is no evidence: it also arrives for an exit nobody saw.
      fake.publishEnd(transportEnd('requested', { kind: 'unobserved', reason: 'signal-denied' }));
      await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
      // A stuck predecessor never blocks the rebuild: the reset still resolves.
      await expect(reset).resolves.toBeUndefined();

      const detail = harness.generations.unretiredDetail();
      expect(detail).toContain('codex app-server process generation 1');
      // The class the connector would otherwise be entitled to is capped, and the
      // reason travels with it.
      expect(harness.generations.capReport({ evidence: 'exited' })).toEqual({
        evidence: 'detached',
        detail,
      });

      // The real exit arrives after the budget: the ledger was still watching.
      fake.publishExit({ kind: 'exited', code: null, signal: 'SIGKILL' });
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.generations.unretiredDetail()).toBeUndefined();
      expect(harness.generations.capReport({ evidence: 'exited' })).toEqual({ evidence: 'exited' });
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Fake app-server: answers `initialize`, exits 4 on `die`, and stays alive otherwise. */
const ANSWERING_APP_SERVER = `
const send = (message, done) => process.stdout.write(JSON.stringify(message) + '\\n', done);
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: {} });
  if (request.method === 'die') process.exit(4);
});
`;

/** Fake app-server: completes the handshake, then exits cleanly although nobody asked it to. */
const EXIT_AFTER_HANDSHAKE = `
const send = (message, done) => process.stdout.write(JSON.stringify(message) + '\\n', done);
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: {} });
  if (request.method === 'initialized') process.exit(0);
});
`;

/**
 * Fake app-server whose first generation refuses \`initialize\` and leaves a
 * grandchild holding its stdout, so that generation's end is reported a drain
 * window after its exit; every later generation answers like
 * {@link ANSWERING_APP_SERVER}.
 */
const REFUSE_FIRST_GENERATION = `
const fs = require('node:fs');
const generation = fs.readdirSync('.').filter((name) => name.startsWith('generation-')).length + 1;
fs.writeFileSync('generation-' + generation, String(process.pid));
if (generation === 1) {
  const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    stdio: ['ignore', 'inherit', 'ignore'],
  });
  grandchild.unref();
  fs.writeFileSync('grandchild', String(grandchild.pid));
}
const send = (message, done) => process.stdout.write(JSON.stringify(message) + '\\n', done);
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize' && generation === 1) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'not ready' } });
  } else if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {} });
  }
  if (request.method === 'die') process.exit(4);
});
`;

/** Working directories {@link appServerCwd} created; removed after each test. */
const appServerDirs: string[] = [];

/**
 * Create a working directory holding an \`app-server\` script for \`node\` to run.
 * @param source - Node source for the script.
 * @returns Directory for the harness to spawn the app-server in.
 */
function appServerCwd(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-generation-'));
  appServerDirs.push(dir);
  writeFileSync(join(dir, 'app-server'), source, 'utf8');
  chmodSync(join(dir, 'app-server'), 0o755);
  return dir;
}

const harnesses: Harness[] = [];

/**
 * Build a harness that spawns a real fake app-server through the production path.
 * @param source - Node source of the fake app-server.
 * @returns The harness and the directory the app-server runs in.
 */
function createSpawningHarness(source: string): { readonly harness: Harness; readonly cwd: string } {
  const cwd = appServerCwd(source);
  const harness = createHarness({ cwd, binaryPath: process.execPath });
  harnesses.push(harness);
  return { harness, cwd };
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).flatMap((harness) => harness.spawned.map((transport) => transport.close())));
  for (const dir of appServerDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Each phase of a generation's end with a real fake app-server, through the
 * production spawn and handshake path.
 */
describe('Codex generation end with a real app-server', () => {
  it('reports a spawn failure as exactly one terminal error', async () => {
    const harness = createHarness({ binaryPath: '/definitely/missing/codex-binary' });
    harnesses.push(harness);

    await expect(initializeConnection(createTestCall(), harness.context, harness.inflight)).rejects.toThrow();
    await settle();

    expect(harness.calls).toEqual([
      {
        kind: 'error',
        message: 'codex app-server failed to start: could not be spawned (ENOENT)',
        terminate: true,
      },
    ]);
    // A spawn that never produced a process is an observed end, so nothing is left unproven.
    expect(harness.generations.unretiredDetail()).toBeUndefined();
  });

  it('completes the handshake, then reports exactly one terminal error for an unexpected exit 0', async () => {
    const { harness } = createSpawningHarness(EXIT_AFTER_HANDSHAKE);

    await initializeConnection(createTestCall(), harness.context, harness.inflight);
    expect(harness.state().connected).toBe(true);
    await harness.spawned[0]?.ended;
    await settle();

    expect(harness.calls).toEqual([
      { kind: 'error', message: 'codex app-server ended unexpectedly: exited with code 0', terminate: true },
    ]);
  });

  it('finalises a requested close exactly once and raises no terminal error', async () => {
    const { harness } = createSpawningHarness(ANSWERING_APP_SERVER);
    await initializeConnection(createTestCall(), harness.context, harness.inflight);

    harness.context.getJsonRpcClient()?.close();
    const end = await harness.spawned[0]?.ended;
    await settle();

    expect(end?.cause).toBe('requested');
    expect(harness.calls).toEqual([{ kind: 'requested-finalisation', end }]);
  });

  it('finalises once when the client closes its transport while the unexpected end is delivered', async () => {
    const { harness } = createSpawningHarness(ANSWERING_APP_SERVER);
    await initializeConnection(createTestCall(), harness.context, harness.inflight);
    const client = harness.context.getJsonRpcClient();

    // The client closes the transport from inside the end delivery; that close
    // comes after the exit, so it changes neither the cause nor the count.
    await expect(client?.request('die', {})).rejects.toThrow('ended unexpectedly: exited with code 4');
    const end = await harness.spawned[0]?.ended;
    await settle();

    expect(end?.cause).toBe('unexpected');
    expect(harness.calls).toEqual([
      { kind: 'error', message: 'codex app-server ended unexpectedly: exited with code 4', terminate: true },
    ]);
  });

  it('keeps the end of a reset generation away from the generation that replaced it and from its turn', async () => {
    const { harness, cwd } = createSpawningHarness(REFUSE_FIRST_GENERATION);
    try {
      await expect(initializeConnection(createTestCall(), harness.context, harness.inflight)).rejects.toThrow(
        'not ready',
      );
      const [first] = harness.spawned;

      await initializeConnection(createTestCall(), harness.context, harness.inflight);
      const second = harness.spawned[1];
      expect(connectorTransport(harness.context)).toBe(second);

      // The reset closed the first generation; its end is held a drain window
      // behind its exit by the grandchild, so it arrives while the retry is live.
      await expect(first?.ended).resolves.toMatchObject({ cause: 'requested', drain: { kind: 'timed-out' } });
      await settle();
      expect(harness.calls).toEqual([]);

      await expect(harness.context.getJsonRpcClient()?.request('die', {})).rejects.toThrow('exited with code 4');
      await second?.ended;
      await settle();

      expect(harness.calls).toEqual([
        { kind: 'error', message: 'codex app-server ended unexpectedly: exited with code 4', terminate: true },
      ]);
    } finally {
      process.kill(Number(readFileSync(join(cwd, 'grandchild'), 'utf8')), 'SIGKILL');
    }
  });
});
