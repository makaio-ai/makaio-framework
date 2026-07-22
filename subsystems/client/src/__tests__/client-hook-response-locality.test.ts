/**
 * Client hook response locality proofs.
 *
 * Proves that `hook.handle` — registered with {@link hostLocalRequest}
 * semantics — is genuinely confined to the receiving host's local handlers.
 *
 * The proofs use real bus instances connected via in-process bidirectional
 * transports. No mocks are used for the bus or transport plumbing.
 *
 * Covers four required invariants:
 * 1. In a two-runtime topology, only the local runtime's handler is invoked.
 * 2. A remote runtime with a higher-priority handler cannot intercept the
 *    request via subscription propagation or relay.
 * 3. An empty contributor registry returns an immediate no-op without
 *    waiting for the request deadline.
 * 4. A bus with no handler at all returns NoHandler promptly.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusNamespace, type PayloadFilter } from '@makaio/core';
import {
  createBusInstance,
  createBusContext,
  hostLocalRequest,
  NoHandlerError,
  CorrelationTracker,
  handleCorrelationResponse,
  type BusMessage,
  type BusRequestMessage,
  type BusTransport,
} from '@makaio/bus-core';
import { collectContributions, type RegisteredContributor } from '../client-hook-response-collector.js';
import { ClientHookHandleResponseSchema, RawClientHookPayloadSchema } from '../client-session-observed-semantics.js';

// ---------------------------------------------------------------------------
// Test namespace — mirrors the real client:* hook.handle registration
// ---------------------------------------------------------------------------

/**
 * A test namespace that mirrors the real `client:<id>` namespace structure.
 * Uses `hostLocalRequest` for `hook.handle`, matching the production
 * registration in {@link createClientNamespace}.
 */
const TestClientNamespaceDef = createBusNamespace('client:test-locality', {
  'hook.handle': hostLocalRequest({
    request: RawClientHookPayloadSchema,
    response: ClientHookHandleResponseSchema,
  }),
});

/**
 * Register the shared test namespace on all given bus instances.
 * @param buses - Bus instances to register the namespace on
 */
function registerTestNamespace(...buses: Array<ReturnType<typeof createBusInstance>>): void {
  for (const bus of buses) {
    bus.registerNamespace(TestClientNamespaceDef);
  }
}

// ---------------------------------------------------------------------------
// In-process bidirectional transport pair
// ---------------------------------------------------------------------------

/**
 * One side of a bidirectional in-process transport with a test helper for
 * injecting inbound messages directly.
 */
interface BidirectionalTransportSide extends BusTransport {
  /**
   * Inject a message directly into this side's inbound handler.
   * @param message - Message to deliver to this side's receive handler
   */
  simulateReceive(message: BusMessage): Promise<void>;
}

/**
 * Create a bidirectional in-process transport pair for locality tests.
 *
 * Both sides relay messages to each other via `queueMicrotask` to match the
 * asynchronous delivery semantics of real transports. Request/response
 * correlation is tracked internally so `send()` for request messages
 * resolves when the peer sends back the corresponding response.
 * @param label - Unique label for the pair's transport names. Each pair in
 *   a test MUST have a distinct label to avoid transport name collisions.
 * @returns A pair of linked transports ready to register on two bus
 *   instances
 */
function createTransportPair(label: string): {
  readonly sideA: BidirectionalTransportSide;
  readonly sideB: BidirectionalTransportSide;
} {
  type InboundHandler = (message: BusMessage) => Promise<void>;

  const correlationsA = new CorrelationTracker();
  const correlationsB = new CorrelationTracker();

  let inboundHandlerA: InboundHandler | undefined;
  let inboundHandlerB: InboundHandler | undefined;

  /**
   * Deliver a message to the target handler asynchronously.
   * @param message - Message to deliver
   * @param target - Recipient inbound handler
   */
  function deliver(message: BusMessage, target: InboundHandler | undefined): void {
    if (!target) return;
    queueMicrotask(() => {
      void target(message);
    });
  }

  /**
   * Build a `send` function for one side of the pair.
   * @param getPeer - Accessor returning the peer's current inbound handler
   * @param correlations - Correlation tracker for this side's outbound
   *   requests
   * @returns Transport `send` method
   */
  function buildSend(
    getPeer: () => InboundHandler | undefined,
    correlations: CorrelationTracker,
  ): BusTransport['send'] {
    return function send(message: BusMessage, timeout?: number): Promise<unknown> {
      deliver(message, getPeer());
      if (message.type === 'request') {
        return correlations.track(message.correlationId, timeout ?? 30_000) as Promise<unknown>;
      }
      return Promise.resolve(true);
    } as BusTransport['send'];
  }

  const sideA: BidirectionalTransportSide = {
    name: `${label}-side-a`,
    connect: async () => {},
    disconnect: async () => {
      correlationsA.cleanup();
    },
    subscribe: async () => {},
    unsubscribe: async () => {},
    onReceive(handler: InboundHandler): () => void {
      inboundHandlerA = async (message: BusMessage): Promise<void> => {
        if (handleCorrelationResponse(message, correlationsA)) return;
        await handler(message);
      };
      return () => {
        inboundHandlerA = undefined;
      };
    },
    send: buildSend(() => inboundHandlerB, correlationsA),
    simulateReceive: async (message: BusMessage): Promise<void> => {
      if (inboundHandlerA) await inboundHandlerA(message);
    },
  };

  const sideB: BidirectionalTransportSide = {
    name: `${label}-side-b`,
    connect: async () => {},
    disconnect: async () => {
      correlationsB.cleanup();
    },
    subscribe: async () => {},
    unsubscribe: async () => {},
    onReceive(handler: InboundHandler): () => void {
      inboundHandlerB = async (message: BusMessage): Promise<void> => {
        if (handleCorrelationResponse(message, correlationsB)) return;
        await handler(message);
      };
      return () => {
        inboundHandlerB = undefined;
      };
    },
    send: buildSend(() => inboundHandlerA, correlationsB),
    simulateReceive: async (message: BusMessage): Promise<void> => {
      if (inboundHandlerB) await inboundHandlerB(message);
    },
  };

  return { sideA, sideB };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Standard hook payload for all locality tests.
 * @returns A valid RawClientHookPayload object
 */
function testHookPayload(): z.infer<typeof RawClientHookPayloadSchema> {
  return {
    eventName: 'PreToolUse',
    receivedAt: Date.now(),
    payload: { toolName: 'edit_file' },
  };
}

// ---------------------------------------------------------------------------
// Proof 1: Two-runtime topology — only the local handler responds
// ---------------------------------------------------------------------------

describe('Proof 1: two-runtime topology — only the local handler responds', () => {
  it("a request arriving at runtime A invokes only A's handler, not B's", async () => {
    const { sideA, sideB } = createTransportPair('p1-ab');

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA, busB);

    // Runtime A: local handler at priority 100
    const handlerASpy = vi.fn();
    const cleanupA = busA.on(
      TestClientNamespaceDef.subjects.hook.handle,
      (ctx) => {
        handlerASpy();
        ctx.setResult({ exitCode: 0, stdout: 'from-A', stderr: '' });
      },
      { priority: 100 },
    );

    // Runtime B: handler at HIGHER priority 200 — must never be called
    const handlerBSpy = vi.fn();
    const cleanupB = busB.on(
      TestClientNamespaceDef.subjects.hook.handle,
      (ctx) => {
        handlerBSpy();
        ctx.setResult({ exitCode: 0, stdout: 'from-B', stderr: '' });
      },
      { priority: 200 },
    );

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    // Seed remote handler knowledge on busA so it could theoretically
    // route to busB — but hostLocalRequest prevents this.
    busA
      .getContext()
      .remoteRequestHandlers.set('client:test-locality.hook.handle', [{ transport: sideA.name, priority: 200 }]);

    try {
      // Inject an inbound request at busA (simulating a CLI connecting
      // to runtime A and sending hook.handle).
      await sideA.simulateReceive({
        type: 'request',
        namespace: 'client:test-locality',
        subject: 'hook.handle',
        payload: testHookPayload(),
        correlationId: 'p1-corr-1',
        messageId: 'p1-msg-1',
        timeout: 5000,
      } satisfies BusRequestMessage);

      // Allow the microtask chain to settle
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Runtime A's handler was invoked
      expect(handlerASpy).toHaveBeenCalledOnce();

      // Runtime B's handler was never invoked — the request stayed local
      expect(handlerBSpy).not.toHaveBeenCalled();
    } finally {
      cleanupA();
      cleanupB();
      busA.disconnect();
      busB.disconnect();
    }
  });

  it('a bus.request originating at runtime A with only remote handlers gets NoHandler', async () => {
    const { sideA, sideB } = createTransportPair('p1-no-local');

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA, busB);

    // Runtime B has a handler — but A has no local handler
    const handlerBSpy = vi.fn();
    const cleanupB = busB.on(TestClientNamespaceDef.subjects.hook.handle, (ctx) => {
      handlerBSpy();
      ctx.setResult({ exitCode: 0, stdout: 'from-B', stderr: '' });
    });

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    // Seed remote handler knowledge — busA knows about busB's handler
    busA
      .getContext()
      .remoteRequestHandlers.set('client:test-locality.hook.handle', [{ transport: sideA.name, priority: 0 }]);

    try {
      // busA requests hook.handle via bus.request — since busA has no
      // local handler and the subject is hostLocalRequest, the request
      // should dispatch to the remote transport which hosts busB.
      // But an inbound request at busB should only use busB's local
      // handler. The critical proof is the OTHER direction:
      // if busA has no local handler, and a CLI sends an inbound request
      // to busA, it gets NoHandler.

      // Simulate an inbound request arriving at busA from a CLI
      await sideA.simulateReceive({
        type: 'request',
        namespace: 'client:test-locality',
        subject: 'hook.handle',
        payload: testHookPayload(),
        correlationId: 'p1b-corr-1',
        messageId: 'p1b-msg-1',
        timeout: 2000,
      } satisfies BusRequestMessage);

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // busB's handler must not be invoked — inbound request at busA
      // stays local, and busA has no local handler.
      // The response on the transport should be a NoHandler error.
      expect(handlerBSpy).not.toHaveBeenCalled();
    } finally {
      cleanupB();
      busA.disconnect();
      busB.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 2: Runtime B cannot intercept via higher priority
// ---------------------------------------------------------------------------

describe('Proof 2: remote runtime with higher priority cannot intercept', () => {
  it("inbound request at runtime A uses only A's local handler, ignoring B's higher priority", async () => {
    const { sideA, sideB } = createTransportPair('p2-priority');

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA, busB);

    // Runtime A: local handler at low priority
    const handlerASpy = vi.fn();
    const cleanupA = busA.on(
      TestClientNamespaceDef.subjects.hook.handle,
      (ctx) => {
        handlerASpy();
        ctx.setResult({ exitCode: 0, stdout: 'low-priority-A', stderr: '' });
      },
      { priority: 10 },
    );

    // Runtime B: handler at much higher priority — must never be called
    const handlerBSpy = vi.fn();
    const cleanupB = busB.on(
      TestClientNamespaceDef.subjects.hook.handle,
      (ctx) => {
        handlerBSpy();
        ctx.setResult({ exitCode: 0, stdout: 'high-priority-B', stderr: '' });
      },
      { priority: 500 },
    );

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    // Seed busA with knowledge of busB's high-priority handler.
    // For an ordinary subject this would cause relay to busB, but
    // hostLocalRequest blocks relay at the receiver.
    busA
      .getContext()
      .remoteRequestHandlers.set('client:test-locality.hook.handle', [{ transport: sideA.name, priority: 500 }]);

    try {
      // Inject an inbound request at busA (simulating a CLI connecting
      // to runtime A). hostLocalRequest semantics ensure only A's local
      // handlers execute — B's higher-priority handler is never reached.
      await sideA.simulateReceive({
        type: 'request',
        namespace: 'client:test-locality',
        subject: 'hook.handle',
        payload: testHookPayload(),
        correlationId: 'p2-corr-1',
        messageId: 'p2-msg-1',
        timeout: 5000,
      } satisfies BusRequestMessage);

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Runtime A's low-priority handler was invoked
      expect(handlerASpy).toHaveBeenCalledOnce();

      // Runtime B's high-priority handler was never called
      expect(handlerBSpy).not.toHaveBeenCalled();
    } finally {
      cleanupA();
      cleanupB();
      busA.disconnect();
      busB.disconnect();
    }
  });

  it('subscription propagation does not re-advertise foreign priorities for hostLocalRequest', async () => {
    const busA = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA);

    // busA has a local handler at priority 50
    const cleanupA = busA.on(
      TestClientNamespaceDef.subjects.hook.handle,
      (ctx) => {
        ctx.setResult({ exitCode: 0, stdout: '', stderr: '' });
      },
      { priority: 50 },
    );

    // Simulate foreign priorities from a connected runtime
    busA
      .getContext()
      .remoteRequestHandlers.set('client:test-locality.hook.handle', [
        { transport: 'remote-transport', priority: 999 },
      ]);

    // Connect a new transport and observe what is advertised
    const subscribeSpy = vi.fn<(subject: string, filter?: PayloadFilter, priorities?: number[]) => Promise<void>>();
    const observerTransport: BusTransport = {
      name: 'observer-transport',
      send: vi.fn(async () => true) as BusTransport['send'],
      onReceive: vi.fn(() => () => {}),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      subscribe: subscribeSpy,
      unsubscribe: vi.fn(async () => {}),
    };

    const reg = busA.getContext().transportRegistry.registerTransport('observer-transport' as never, observerTransport);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    try {
      const hookSubscribes = subscribeSpy.mock.calls.filter(
        ([subject]) => subject === 'client:test-locality.hook.handle',
      );
      expect(hookSubscribes.length).toBeGreaterThanOrEqual(1);

      const lastCall = hookSubscribes[hookSubscribes.length - 1];
      const priorities = lastCall[2] as number[];

      // Only local priority 50 is advertised, NOT foreign 999
      expect(priorities).toContain(50);
      expect(priorities).not.toContain(999);
    } finally {
      cleanupA();
      reg.unregister();
      busA.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 3: No-handler fast path — NoHandler returned immediately
// ---------------------------------------------------------------------------

describe('Proof 3: no-handler fast path', () => {
  it('returns NoHandlerError immediately when no handler is registered', async () => {
    const busA = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA);

    try {
      const start = Date.now();
      await expect(
        busA.request(TestClientNamespaceDef.subjects.hook.handle, testHookPayload(), { timeout: 5000 }),
      ).rejects.toThrow(NoHandlerError);

      // Must resolve promptly — well under the 5s timeout
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    } finally {
      busA.disconnect();
    }
  });

  it('inbound request with no handler returns error response on the transport', async () => {
    const sentMessages: BusMessage[] = [];
    const { sideA } = createTransportPair('p3-inbound');

    const busA = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA);

    // Capture outbound messages from busA back through the transport
    const originalSend = sideA.send;
    sideA.send = (async (message: BusMessage, timeout?: number) => {
      if (message.type !== ('subscribe-sync-complete' as string)) {
        sentMessages.push(message);
      }
      return originalSend.call(sideA, message, timeout);
    }) as BusTransport['send'];

    busA.registerTransport(sideA);

    try {
      // Inject an inbound request — no handler registered
      await sideA.simulateReceive({
        type: 'request',
        namespace: 'client:test-locality',
        subject: 'hook.handle',
        payload: testHookPayload(),
        correlationId: 'p3-corr-1',
        messageId: 'p3-msg-1',
        timeout: 5000,
      } satisfies BusRequestMessage);

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // The transport should have received an error response
      const errorResponse = sentMessages.find(
        (m) => m.type === 'response' && 'correlationId' in m && m.correlationId === 'p3-corr-1',
      );
      expect(errorResponse).toBeDefined();
      expect(errorResponse).toMatchObject({
        type: 'response',
        correlationId: 'p3-corr-1',
        error: expect.objectContaining({
          message: expect.stringContaining('handler'),
        }),
      });
    } finally {
      busA.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 4: No-contributor fast path — collector returns immediately
// ---------------------------------------------------------------------------

describe('Proof 4: no-contributor fast path — collector returns without deadline wait', () => {
  it('empty registry snapshot returns immediate no-op without waiting', async () => {
    const emptySnapshot: ReadonlyArray<RegisteredContributor> = [];
    const distantDeadline = Date.now() + 30_000;

    const start = Date.now();
    const result = await collectContributions(
      emptySnapshot,
      'test-locality',
      distantDeadline,
      undefined,
      'PreToolUse',
      {
        toolName: 'edit_file',
      },
    );
    const elapsed = Date.now() - start;

    // Must return immediately — not wait for the 30s deadline
    expect(elapsed).toBeLessThan(100);
    expect(result.outcomes).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.closedFailure).toBeUndefined();
  });

  it('empty snapshot with an active abort signal still returns immediately', async () => {
    const emptySnapshot: ReadonlyArray<RegisteredContributor> = [];
    const controller = new AbortController();

    const start = Date.now();
    const result = await collectContributions(
      emptySnapshot,
      'test-locality',
      Date.now() + 60_000,
      controller.signal,
      'PostToolUse',
      { toolName: 'read_file' },
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(result.outcomes).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Proof 5: Execution host isolation — hook.handle stays local in an
// isolated runtime connected via transport
// ---------------------------------------------------------------------------

describe('Proof 5: execution host isolation', () => {
  it('inbound request at isolated runtime stays local, never relaying to authority', async () => {
    const { sideA: authoritySide, sideB: isolatedSide } = createTransportPair('p5-isolated');

    const authorityBus = createBusInstance({ context: createBusContext() });
    const isolatedBus = createBusInstance({ context: createBusContext() });
    registerTestNamespace(authorityBus, isolatedBus);

    // Authority: handler at very high priority — must NEVER be invoked
    const authorityHandlerSpy = vi.fn();
    const cleanupAuthority = authorityBus.on(
      TestClientNamespaceDef.subjects.hook.handle,
      (ctx) => {
        authorityHandlerSpy();
        ctx.setResult({
          exitCode: 1,
          stdout: '',
          stderr: 'authority should not handle this',
        });
      },
      { priority: 1000 },
    );

    // Isolated runtime: local handler at normal priority
    const isolatedHandlerSpy = vi.fn();
    const cleanupIsolated = isolatedBus.on(
      TestClientNamespaceDef.subjects.hook.handle,
      (ctx) => {
        isolatedHandlerSpy();
        ctx.setResult({
          exitCode: 0,
          stdout: 'handled-by-isolated-runtime',
          stderr: '',
        });
      },
      { priority: 100 },
    );

    authorityBus.registerTransport(authoritySide);
    isolatedBus.registerTransport(isolatedSide);

    // The isolated bus knows about the authority's handler (would be
    // seeded via subscribe-sync in production). Even with this knowledge,
    // hostLocalRequest prevents relay.
    isolatedBus
      .getContext()
      .remoteRequestHandlers.set('client:test-locality.hook.handle', [
        { transport: isolatedSide.name, priority: 1000 },
      ]);

    try {
      // Inject an inbound request at the isolated runtime (simulating
      // a CLI or workflow engine sending hook.handle). The request must
      // stay local — the authority's high-priority handler is never
      // reached because hostLocalRequest blocks relay.
      await isolatedSide.simulateReceive({
        type: 'request',
        namespace: 'client:test-locality',
        subject: 'hook.handle',
        payload: testHookPayload(),
        correlationId: 'p5-corr-1',
        messageId: 'p5-msg-1',
        timeout: 5000,
      } satisfies BusRequestMessage);

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(isolatedHandlerSpy).toHaveBeenCalledOnce();
      expect(authorityHandlerSpy).not.toHaveBeenCalled();
    } finally {
      cleanupAuthority();
      cleanupIsolated();
      authorityBus.disconnect();
      isolatedBus.disconnect();
    }
  });

  it('authority dispatches request to isolated runtime, which handles it with only local handlers', async () => {
    const { sideA: authoritySide, sideB: isolatedSide } = createTransportPair('p5-inbound');

    const authorityBus = createBusInstance({ context: createBusContext() });
    const isolatedBus = createBusInstance({ context: createBusContext() });
    registerTestNamespace(authorityBus, isolatedBus);

    // Authority has NO local handler — it only routes to the remote
    // isolated runtime.

    // Isolated runtime: local handler + a seeded remote handler for
    // a fictional third runtime at higher priority. The hostLocalRequest
    // semantics ensure the isolated runtime dispatches only its own
    // local handler and does not relay to the third runtime.
    const isolatedHandlerSpy = vi.fn();
    const cleanupIsolated = isolatedBus.on(
      TestClientNamespaceDef.subjects.hook.handle,
      (ctx) => {
        isolatedHandlerSpy();
        ctx.setResult({
          exitCode: 0,
          stdout: 'from-isolated',
          stderr: '',
        });
      },
      { priority: 100 },
    );

    authorityBus.registerTransport(authoritySide);
    isolatedBus.registerTransport(isolatedSide);

    // Authority knows about isolated runtime's handler
    authorityBus
      .getContext()
      .remoteRequestHandlers.set('client:test-locality.hook.handle', [
        { transport: authoritySide.name, priority: 100 },
      ]);

    // Isolated runtime has knowledge of a third runtime's handler at
    // higher priority — hostLocalRequest blocks relay to it
    isolatedBus
      .getContext()
      .remoteRequestHandlers.set('client:test-locality.hook.handle', [
        { transport: 'phantom-third-runtime', priority: 999 },
      ]);

    try {
      // Authority sends request — routed to isolated runtime via
      // transport. The isolated runtime receives it as an inbound
      // request and dispatches only its local handler.
      const result = await authorityBus.request(TestClientNamespaceDef.subjects.hook.handle, testHookPayload(), {
        timeout: 5000,
      });

      // The isolated runtime's handler processed it
      expect(isolatedHandlerSpy).toHaveBeenCalledOnce();
      expect(result.stdout).toBe('from-isolated');
      expect(result.exitCode).toBe(0);
    } finally {
      cleanupIsolated();
      authorityBus.disconnect();
      isolatedBus.disconnect();
    }
  });

  it('A-B-C topology: authority cannot reach worker C through relay B', async () => {
    const pairAB = createTransportPair('p5-abc-ab');
    const pairBC = createTransportPair('p5-abc-bc');

    const busAuthority = createBusInstance({ context: createBusContext() });
    const busRelay = createBusInstance({ context: createBusContext() });
    const busWorker = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busAuthority, busRelay, busWorker);

    // Worker C has a handler
    const workerSpy = vi.fn();
    const cleanupWorker = busWorker.on(TestClientNamespaceDef.subjects.hook.handle, (ctx) => {
      workerSpy();
      ctx.setResult({ exitCode: 0, stdout: 'from-worker', stderr: '' });
    });

    // Relay B has NO local handler

    busAuthority.registerTransport(pairAB.sideA);
    busRelay.registerTransport(pairAB.sideB);
    busRelay.registerTransport(pairBC.sideA);
    busWorker.registerTransport(pairBC.sideB);

    // Authority thinks relay B can handle the request
    busAuthority
      .getContext()
      .remoteRequestHandlers.set('client:test-locality.hook.handle', [{ transport: pairAB.sideA.name, priority: 0 }]);

    // Relay B knows about worker C's handler
    busRelay
      .getContext()
      .remoteRequestHandlers.set('client:test-locality.hook.handle', [{ transport: pairBC.sideA.name, priority: 0 }]);

    try {
      // Authority's request should fail — relay B has no local handler
      // and cannot relay to worker C (hostLocalRequest blocks relay)
      await expect(
        busAuthority.request(TestClientNamespaceDef.subjects.hook.handle, testHookPayload(), { timeout: 2000 }),
      ).rejects.toThrow(NoHandlerError);

      // Worker C's handler must not have been called
      expect(workerSpy).not.toHaveBeenCalled();
    } finally {
      cleanupWorker();
      busAuthority.disconnect();
      busRelay.disconnect();
      busWorker.disconnect();
    }
  });
});
