/**
 * Case 206d, codex arm — the class this connector reports comes from the exit
 * observation its transport settles, not from a hard-coded value.
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
import type { StdioTransport } from '../utils/createStdioTransport.js';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  MockJsonRpcClient,
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
 * An injected transport whose child exit the test settles.
 * @param exited - Exit observation the connector's teardown will consume.
 * @returns A transport in the shape the connector speaks through.
 */
function makeTransport(exited: Promise<number | null>): StdioTransport {
  return {
    send: () => undefined,
    close: () => undefined,
    onMessage: () => undefined,
    onError: () => undefined,
    exited,
    shutdownRequested: () => false,
  };
}

describe('CodexAppServerConnector teardown evidence', () => {
  let ctx: ConnectorTestContext | undefined;

  afterEach(() => {
    if (ctx) cleanupConnectorTestContext(ctx);
    ctx = undefined;
    vi.useRealTimers();
  });

  it('reports `exited` from the observed end of the app-server process', async () => {
    ctx = await createConnectorTestContext({ transport: makeTransport(Promise.resolve(null)) });

    await expect(ctx.connector.close()).resolves.toEqual({ evidence: 'exited' });
  });

  it('reports `detached` when the end it asked for is not observed inside the budget', async () => {
    const neverExits = new Promise<number | null>(() => {});
    ctx = await createConnectorTestContext({ transport: makeTransport(neverExits) });

    vi.useFakeTimers();
    const closing = ctx.connector.close();
    await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
    const report = await closing;

    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('codex app-server process');
  });

  it('reports `detached` — never an observed class — when it owned no process at all', async () => {
    ctx = await createConnectorTestContext();

    const report = await ctx.connector.close();

    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('owned no app-server process');
  });

  it('reports `detached` after a teardown that ran cleanly, because it watched nothing itself', async () => {
    ctx = await createConnectorTestContext({ transport: makeTransport(Promise.resolve(null)) });
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
      transport: makeTransport(Promise.resolve(null)),
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
      transport: makeTransport(Promise.resolve(null)),
    });

    await expect(ctx.connector.close()).rejects.toThrow('Codex app-server client close failed.');

    const report = await ctx.connector.close();

    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain('graceful close');
    expect(report.detail).toContain('client-close-failed');
  });
});
