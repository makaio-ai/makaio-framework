import { describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { CONNECTOR_EXIT_OBSERVATION_MS, GenerationRetirementLedger } from '@makaio/ai-adapters-core';
import type { ConnectionManagerContext } from '../connection-manager.js';
import {
  CodexConnectionResetError,
  connectorTransport,
  resetClient,
  wireRequestedShutdownFinalisation,
} from '../connection-manager.js';
import type { JsonRpcClient } from '../../utils/jsonRpcClient.js';
import type { StdioTransport } from '../../utils/createStdioTransport.js';
import { MockJsonRpcClient } from '../../__tests__/shared.js';

/** Observable connection state a reset is expected to have cleared. */
interface ResetHarnessState {
  readonly client: JsonRpcClient | undefined;
  readonly ownedTransport: StdioTransport | undefined;
  readonly connected: boolean;
  readonly handlersRegistered: boolean;
  readonly disabledNativeTools: ReadonlySet<string>;
}

/** Harness around one reset: injectable close behaviour plus the retirement ledger. */
interface ResetHarness {
  readonly context: ConnectionManagerContext;
  readonly state: () => ResetHarnessState;
  /** Publishes the dropped child's exit, standing in for the real `exit` event. */
  readonly publishExit: () => void;
  /** The connector-lifetime ledger the reset retires generations against. */
  readonly generations: GenerationRetirementLedger;
  /** The transport the harness starts out owning, for identity assertions. */
  readonly transport: StdioTransport;
  /** Marks the transport as having been asked to shut down, as `close()` does. */
  readonly requestShutdown: () => void;
  /** Every requested-shutdown finalisation the context was asked to run. */
  readonly finalisations: Array<{ code: number | null; terminate: boolean }>;
}

/**
 * Build mutable connection state around injectable cleanup operations.
 *
 * The transport's `exited` is settled by {@link ResetHarness.publishExit} rather
 * than by a real child, because the seam under test is the reset's *consumption*
 * of an exit observation — not the transport's production of one, which the
 * transport's own suite drives through a real subprocess.
 * @param closeClient - Client close behavior injected by the test
 * @param closeTransport - Transport close behavior injected by the test
 * @returns Mutable connection-manager harness and observable state reader
 */
function createResetHarness(closeClient: () => void, closeTransport: () => void): ResetHarness {
  const mockClient = new MockJsonRpcClient();
  mockClient.close = closeClient;
  let client: JsonRpcClient | undefined = mockClient;
  let settleExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settleExit = resolve;
  });
  let shutdownRequested = false;
  const transport: StdioTransport = {
    send: () => undefined,
    close: closeTransport,
    onMessage: () => undefined,
    onError: () => undefined,
    exited,
    shutdownRequested: () => shutdownRequested,
  };
  let ownedTransport: StdioTransport | undefined = transport;
  let connected = true;
  let handlersRegistered = true;
  let disabledNativeTools: ReadonlySet<string> = new Set(['bash']);
  const generations = new GenerationRetirementLedger('codex app-server process');
  const finalisations: Array<{ code: number | null; terminate: boolean }> = [];

  return {
    generations,
    transport,
    finalisations,
    requestShutdown: () => {
      shutdownRequested = true;
    },
    publishExit: () => settleExit(null),
    context: {
      getJsonRpcClient: () => client,
      setJsonRpcClient: (value) => {
        client = value;
      },
      getInjectedJsonRpcClient: () => undefined,
      getInjectedTransport: () => undefined,
      getOwnedTransport: () => ownedTransport,
      setOwnedTransport: (value) => {
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
      cwd: '/tmp',
      env: {},
      adapterName: 'codex-app-server',
      clientId: 'codex',
      clientExecution: undefined,
      getAccountLogin: () => undefined,
      harnessId: undefined,
      globalBus: MakaioBus,
      generations,
      registerClientHandlers: () => undefined,
      handleError: () => undefined,
      finalizeRequestedShutdown: (code, terminate) => {
        finalisations.push({ code, terminate });
      },
    },
    state: () => ({ client, ownedTransport, connected, handlersRegistered, disabledNativeTools }),
  };
}

describe('Codex connection manager cleanup', () => {
  it('resets and closes an owned process client after a failed ready handshake', async () => {
    const closeClient = vi.fn();
    const closeTransport = vi.fn();
    const harness = createResetHarness(closeClient, closeTransport);

    harness.publishExit();
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
    const harness = createResetHarness(closeClient, closeTransport);

    harness.publishExit();
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
 * Whose shutdown an expected exit belongs to (#1140 Wave 4 F13).
 *
 * A transport's shutdown marker only says that *somebody in this runtime* asked
 * for the exit. Two parties can be that somebody, and they must not get the same
 * answer: a `close`/`abort` of the connector is its end, while a `resetClient`
 * dropping one app-server generation after a failed handshake is not.
 */
describe('Codex requested-shutdown finalisation', () => {
  it('terminates on the exit of the transport the connector still holds', async () => {
    const harness = createResetHarness(
      () => undefined,
      () => undefined,
    );

    wireRequestedShutdownFinalisation(harness.context, harness.transport);
    harness.requestShutdown();
    harness.publishExit();
    await harness.transport.exited;
    await Promise.resolve();

    expect(connectorTransport(harness.context)).toBe(harness.transport);
    expect(harness.finalisations).toEqual([{ code: null, terminate: true }]);
  });

  it('finalises a reset generation exit without terminating the connector', async () => {
    // The failed-handshake path: `resetClient` closes a transport whose shutdown
    // marker is set, so its exit *is* expected — but it is expected by the reset,
    // not by a connector that is ending. Terminating here discarded the API-key
    // login, so the retry reconnected unauthenticated, and the later close
    // reported a repeat teardown instead of closing the process that retry had
    // spawned.
    // The client close is what marks the transport, exactly as the real one does.
    let markShutdown: () => void = () => undefined;
    const harness = createResetHarness(
      () => markShutdown(),
      () => undefined,
    );
    markShutdown = harness.requestShutdown;

    wireRequestedShutdownFinalisation(harness.context, harness.transport);
    const reset = resetClient(harness.context);
    harness.publishExit();
    await reset;

    // The connector no longer holds it, which is the whole distinction.
    expect(connectorTransport(harness.context)).toBeUndefined();
    // The interrupted turn is still finalised — that half was never the problem.
    expect(harness.finalisations).toEqual([{ code: null, terminate: false }]);
  });
});

// Case 226, codex arms 1 and 2 — I33 at this connector's own choke point.
describe('Codex generation retirement (I33)', () => {
  it('arm 1 — the reset consumes the dropped process exit before it returns', async () => {
    const harness = createResetHarness(
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
    harness.publishExit();
    await reset;

    expect(order).toEqual(['exit-published', 'reset-returned']);
    expect(harness.generations.unretiredDetail()).toBeUndefined();
  });

  it('arm 2 — an exit that never arrives completes the reset and caps every later class', async () => {
    vi.useFakeTimers();
    try {
      const harness = createResetHarness(
        () => undefined,
        () => undefined,
      );

      const reset = resetClient(harness.context);
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
    } finally {
      vi.useRealTimers();
    }
  });
});
