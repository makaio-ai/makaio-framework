/**
 * Proves that `hook.handle` (hostLocalRequest) stays local in an isolated
 * execution host connected to an authority via transport.
 *
 * This integration test mirrors the topology of
 * `isolated-workflow-runtime.integration.test.ts` but focuses on the
 * hook dispatch locality invariant rather than session lifecycle.  It uses
 * in-process bidirectional transports instead of WebSocket to keep the test
 * fast and deterministic while still exercising real bus instances.
 *
 * Invariants proved:
 * 1. An inbound hook.handle request at the isolated runtime dispatches only
 *    its local handlers, not the authority's.
 * 2. Even when the isolated runtime's bus has seeded knowledge of the
 *    authority's handler at higher priority, hostLocalRequest blocks relay.
 */

import { describe, expect, it, vi } from 'vitest';
import { createBusNamespace } from '@makaio/core';
import {
  createBusInstance,
  createBusContext,
  hostLocalRequest,
  CorrelationTracker,
  handleCorrelationResponse,
  type BusMessage,
  type BusRequestMessage,
  type BusTransport,
} from '@makaio/bus-core';
import { ClientHookHandleResponseSchema, RawClientHookPayloadSchema } from '@makaio/subsystem-client';

// ---------------------------------------------------------------------------
// Namespace — mirrors client:<id> hook.handle registration
// ---------------------------------------------------------------------------

const IsolatedClientNs = createBusNamespace('client:isolated-hook-test', {
  'hook.handle': hostLocalRequest({
    request: RawClientHookPayloadSchema,
    response: ClientHookHandleResponseSchema,
  }),
});

// ---------------------------------------------------------------------------
// Minimal in-process bidirectional transport
// ---------------------------------------------------------------------------

/**
 * One side of a bidirectional in-process transport with simulateReceive.
 */
interface TransportSide extends BusTransport {
  /**
   * Inject a message into this side's inbound handler.
   * @param message - Message to deliver
   */
  simulateReceive(message: BusMessage): Promise<void>;
}

/**
 * Create a bidirectional in-process transport pair.
 * @param label - Unique label for transport naming
 * @returns Linked transport sides
 */
function createTransportPair(label: string): {
  readonly authority: TransportSide;
  readonly worker: TransportSide;
} {
  type Handler = (message: BusMessage) => Promise<void>;

  const corrAuth = new CorrelationTracker();
  const corrWorker = new CorrelationTracker();

  let handlerAuth: Handler | undefined;
  let handlerWorker: Handler | undefined;

  /**
   * Deliver a message asynchronously to the target handler.
   * @param message - Message to deliver
   * @param target - Target handler
   */
  function deliver(message: BusMessage, target: Handler | undefined): void {
    if (!target) return;
    queueMicrotask(() => {
      void target(message);
    });
  }

  /**
   * Build a send function for one side of the pair.
   * @param getPeer - Accessor for the peer's handler
   * @param correlations - Correlation tracker for outbound requests
   * @returns Transport send method
   */
  function buildSend(getPeer: () => Handler | undefined, correlations: CorrelationTracker): BusTransport['send'] {
    return function send(message: BusMessage, timeout?: number): Promise<unknown> {
      deliver(message, getPeer());
      if (message.type === 'request') {
        return correlations.track(message.correlationId, timeout ?? 30_000) as Promise<unknown>;
      }
      return Promise.resolve(true);
    } as BusTransport['send'];
  }

  const authority: TransportSide = {
    name: `${label}-authority`,
    connect: async () => {},
    disconnect: async () => {
      corrAuth.cleanup();
    },
    subscribe: async () => {},
    unsubscribe: async () => {},
    onReceive(handler: Handler): () => void {
      handlerAuth = async (msg: BusMessage): Promise<void> => {
        if (handleCorrelationResponse(msg, corrAuth)) return;
        await handler(msg);
      };
      return () => {
        handlerAuth = undefined;
      };
    },
    send: buildSend(() => handlerWorker, corrAuth),
    simulateReceive: async (msg: BusMessage): Promise<void> => {
      if (handlerAuth) await handlerAuth(msg);
    },
  };

  const worker: TransportSide = {
    name: `${label}-worker`,
    connect: async () => {},
    disconnect: async () => {
      corrWorker.cleanup();
    },
    subscribe: async () => {},
    unsubscribe: async () => {},
    onReceive(handler: Handler): () => void {
      handlerWorker = async (msg: BusMessage): Promise<void> => {
        if (handleCorrelationResponse(msg, corrWorker)) return;
        await handler(msg);
      };
      return () => {
        handlerWorker = undefined;
      };
    },
    send: buildSend(() => handlerAuth, corrWorker),
    simulateReceive: async (msg: BusMessage): Promise<void> => {
      if (handlerWorker) await handlerWorker(msg);
    },
  };

  return { authority, worker };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isolated execution host hook.handle locality', () => {
  it('inbound hook.handle at isolated worker dispatches only local handlers', async () => {
    const pair = createTransportPair('locality-1');

    const authorityBus = createBusInstance({ context: createBusContext() });
    const workerBus = createBusInstance({ context: createBusContext() });

    authorityBus.registerNamespace(IsolatedClientNs);
    workerBus.registerNamespace(IsolatedClientNs);

    // Authority handler at very high priority — must never be invoked
    const authoritySpy = vi.fn();
    const cleanupAuth = authorityBus.on(
      IsolatedClientNs.subjects.hook.handle,
      (ctx) => {
        authoritySpy();
        ctx.setResult({
          exitCode: 1,
          stdout: '',
          stderr: 'authority must not handle this',
        });
      },
      { priority: 1000 },
    );

    // Worker handler at normal priority
    const workerSpy = vi.fn();
    const cleanupWorker = workerBus.on(
      IsolatedClientNs.subjects.hook.handle,
      (ctx) => {
        workerSpy();
        ctx.setResult({
          exitCode: 0,
          stdout: 'handled-by-worker',
          stderr: '',
        });
      },
      { priority: 100 },
    );

    authorityBus.registerTransport(pair.authority);
    workerBus.registerTransport(pair.worker);

    // Worker knows about authority's handler — hostLocalRequest prevents
    // relay, so the authority's handler must never be reached.
    workerBus
      .getContext()
      .remoteRequestHandlers.set('client:isolated-hook-test.hook.handle', [
        { transport: pair.worker.name, priority: 1000 },
      ]);

    try {
      // Simulate inbound request arriving at the worker (e.g. from the
      // workflow engine or a CLI bridge attached to this worker host).
      await pair.worker.simulateReceive({
        type: 'request',
        namespace: 'client:isolated-hook-test',
        subject: 'hook.handle',
        payload: {
          eventName: 'PreToolUse',
          receivedAt: Date.now(),
          payload: { toolName: 'edit_file' },
        },
        correlationId: 'iso-corr-1',
        messageId: 'iso-msg-1',
        timeout: 5000,
      } satisfies BusRequestMessage);

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(workerSpy).toHaveBeenCalledOnce();
      expect(authoritySpy).not.toHaveBeenCalled();
    } finally {
      cleanupAuth();
      cleanupWorker();
      authorityBus.disconnect();
      workerBus.disconnect();
    }
  });

  it('authority-originated request reaches worker and is handled locally, not relayed back', async () => {
    const pair = createTransportPair('locality-2');

    const authorityBus = createBusInstance({ context: createBusContext() });
    const workerBus = createBusInstance({ context: createBusContext() });

    authorityBus.registerNamespace(IsolatedClientNs);
    workerBus.registerNamespace(IsolatedClientNs);

    // Authority has NO local handler — it purely routes to the worker

    // Worker handler
    const workerSpy = vi.fn();
    const cleanupWorker = workerBus.on(
      IsolatedClientNs.subjects.hook.handle,
      (ctx) => {
        workerSpy();
        ctx.setResult({
          exitCode: 0,
          stdout: 'worker-response',
          stderr: '',
        });
      },
      { priority: 100 },
    );

    authorityBus.registerTransport(pair.authority);
    workerBus.registerTransport(pair.worker);

    // Authority knows about worker's handler
    authorityBus
      .getContext()
      .remoteRequestHandlers.set('client:isolated-hook-test.hook.handle', [
        { transport: pair.authority.name, priority: 100 },
      ]);

    try {
      // Authority sends request — routes to worker via transport.
      // Worker handles it locally (hostLocalRequest) — no further relay.
      const result = await authorityBus.request(
        IsolatedClientNs.subjects.hook.handle,
        {
          eventName: 'PostToolUse',
          receivedAt: Date.now(),
          payload: { toolName: 'read_file' },
        },
        { timeout: 5000 },
      );

      expect(workerSpy).toHaveBeenCalledOnce();
      expect(result.stdout).toBe('worker-response');
      expect(result.exitCode).toBe(0);
    } finally {
      cleanupWorker();
      authorityBus.disconnect();
      workerBus.disconnect();
    }
  });
});
