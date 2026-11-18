/**
 * Case 206d, codex arm — the class this connector reports comes from the exit
 * observation its transport settles (`exitObserved`, never the end report), not
 * from a hard-coded value.
 *
 * The transport is injected rather than spawned: the seam under test is the
 * connector's *consumption* of an exit observation, and the transport's own
 * production of one is driven through a real subprocess in its own suite. Nothing
 * about the classification itself is substituted.
 *
 * Case 206, codex arm (I29) is here too, and it is about the termination marker
 * rather than a swallow: a teardown that *failed* still marks the connector
 * terminated, so every later teardown has to be told which kind of teardown it is
 * inheriting from. The JSON-RPC client is the only fault injected — the connector's
 * own recording and reporting are the code under test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CONNECTOR_EXIT_OBSERVATION_MS } from '@makaio/ai-adapters-core';
import { createJsonlTransport, type IJsonlTransport, type TransportEnd } from '@makaio/subprocess';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  createFakeAppServerTransport,
  MockJsonRpcClient,
  transportEnd,
  type ConnectorTestContext,
} from './shared.js';

/** A client whose close cannot be delivered, so a teardown provably fails. */
class UnclosableJsonRpcClient extends MockJsonRpcClient {
  /** @throws Always — the failure a real close raises when the peer is unreachable. */
  public override close(): never {
    throw new Error('app-server client close refused');
  }
}

/**
 * An injected transport whose child exit has already been observed.
 * @returns A transport in the shape the connector speaks through.
 */
function exitedTransport(): IJsonlTransport {
  const fake = createFakeAppServerTransport();
  fake.publishExit();
  return fake.transport;
}

/**
 * Connector inputs whose client ends the transport when it is closed, as a real
 * client does: the close returns once the end report was delivered, and a
 * teardown now waits for that report as well as for the exit.
 * @param end - The end report the transport delivers on close.
 * @param observeExit - Whether the child's exit is observed too.
 * @returns A transport and the client that owns it.
 */
function endingOnClose(
  end: TransportEnd,
  observeExit: boolean,
): { transport: IJsonlTransport; jsonRpcClient: MockJsonRpcClient } {
  const fake = createFakeAppServerTransport();
  if (observeExit) fake.publishExit();
  const jsonRpcClient = new MockJsonRpcClient();
  jsonRpcClient.onClose = () => fake.publishEnd(end);
  return { transport: fake.transport, jsonRpcClient };
}

/**
 * A real child process behind a real JSONL transport, standing in for an
 * injected app-server: it runs until it is asked to stop.
 * @returns The transport; the child ignores nothing and ends on the stop request.
 */
function liveAppServerTransport(): IJsonlTransport {
  return createJsonlTransport({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    processName: 'test app-server',
    onStdoutEnd: 'ignore',
    killGraceMs: 2_000,
  });
}

describe('CodexAppServerConnector teardown evidence', () => {
  let ctx: ConnectorTestContext | undefined;

  afterEach(() => {
    if (ctx) cleanupConnectorTestContext(ctx);
    ctx = undefined;
    vi.useRealTimers();
  });

  it('reports `exited` from the observed end of the app-server process', async () => {
    ctx = await createConnectorTestContext(endingOnClose(transportEnd('requested'), true));

    await expect(ctx.connector.close()).resolves.toEqual({ evidence: 'exited' });
  });

  it('reports `detached` when the end it asked for is not observed inside the budget', async () => {
    // The end report arrives without the exit ever being seen; only the exit is evidence.
    ctx = await createConnectorTestContext(
      endingOnClose(transportEnd('requested', { kind: 'unobserved', reason: 'observation-timeout' }), false),
    );

    vi.useFakeTimers();
    const closing = ctx.connector.close();
    await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
    const report = await closing;

    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('codex app-server process');
  });

  it('reports `detached` when the transport gave up watching and reported the end as unobserved', async () => {
    // The end report fulfils for an end nobody saw; only the exit observation is
    // evidence, and it never fulfils here.
    const fake = createFakeAppServerTransport();
    ctx = await createConnectorTestContext({ transport: fake.transport });

    vi.useFakeTimers();
    const closing = ctx.connector.close();
    fake.publishEnd(transportEnd('requested', { kind: 'unobserved', reason: 'signal-denied' }));
    await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
    const report = await closing;

    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('its end was not observed');
  });

  it('reports `detached` — never an observed class — when it owned no process at all', async () => {
    ctx = await createConnectorTestContext();

    const report = await ctx.connector.close();

    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('owned no app-server process');
  });

  it('reports `detached` after a teardown that ran cleanly, because it watched nothing itself', async () => {
    ctx = await createConnectorTestContext(endingOnClose(transportEnd('requested'), true));
    await ctx.connector.close();

    // The control arm for the two below: a marker set by a *delivered* teardown
    // still supports `detached`, and the fix must not weaken that to `unknown`.
    const report = await ctx.connector.close();

    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('An earlier teardown closed this connector');
  });

  // Case 206, codex arm: a known-failed teardown may not be inherited as a clean one.
  it('claims no observed class after a panic abort whose client close failed (I29)', async () => {
    ctx = await createConnectorTestContext({
      jsonRpcClient: new UnclosableJsonRpcClient(),
      transport: exitedTransport(),
    });

    expect(() => ctx?.connector.abort()).toThrow('Codex app-server client close failed.');

    // The abort left the connector flagged terminated. Reporting `detached` here
    // would claim we let go of a client we never managed to close.
    const report = await ctx.connector.close();

    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain('panic abort');
  });

  it('claims no observed class after a graceful close whose client close failed (I29)', async () => {
    ctx = await createConnectorTestContext({
      jsonRpcClient: new UnclosableJsonRpcClient(),
      transport: exitedTransport(),
    });

    await expect(ctx.connector.close()).rejects.toThrow('Codex app-server client close failed.');

    const report = await ctx.connector.close();

    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain('graceful close');
    expect(report.detail).toContain('client-close-failed');
  });

  // The connector waits for the end of the transport it holds, so it has to be
  // the one that asks for it: a client closes only the transport it was built
  // on, and before the first connection there is no client, while an injected
  // client is not built on the injected transport at all.
  describe('with an injected transport nobody else closes', () => {
    let transport: IJsonlTransport | undefined;

    afterEach(async () => {
      await transport?.close();
      transport = undefined;
    });

    it('requests the end itself when it closes before a client exists', async () => {
      transport = liveAppServerTransport();
      ctx = await createConnectorTestContext({ transport, withoutJsonRpcClient: true });

      await expect(ctx.connector.close()).resolves.toEqual({ evidence: 'exited' });

      expect(transport.status).toBe('ended');
      await expect(transport.ended).resolves.toMatchObject({ cause: 'requested' });
    }, 10_000);

    it('requests the end itself when the injected client is not built on the transport', async () => {
      transport = liveAppServerTransport();
      ctx = await createConnectorTestContext({ transport });

      await expect(ctx.connector.close()).resolves.toEqual({ evidence: 'exited' });

      expect(transport.status).toBe('ended');
    }, 10_000);

    it('requests the end itself when it aborts before a client exists', async () => {
      transport = liveAppServerTransport();
      ctx = await createConnectorTestContext({ transport, withoutJsonRpcClient: true });

      ctx.connector.abort();

      await expect(transport.ended).resolves.toMatchObject({ cause: 'requested' });
    }, 10_000);

    it('still requests the end when closing the client throws', async () => {
      transport = liveAppServerTransport();
      ctx = await createConnectorTestContext({ transport, jsonRpcClient: new UnclosableJsonRpcClient() });

      await expect(ctx.connector.close()).rejects.toThrow('Codex app-server client close failed.');

      await expect(transport.ended).resolves.toMatchObject({ cause: 'requested' });
    }, 10_000);
  });
});
