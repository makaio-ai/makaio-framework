/**
 * Tests for hostLocalRequest subscription and dispatch semantics.
 *
 * Host-local request subjects accept direct remote ingress — a transport may
 * deliver the request to this host — but the receiving bus must never relay
 * the request onward to other transports after ingress. The receiver resolves
 * this from registered subject metadata or owner-derived subscription
 * provenance; a caller-supplied request-wire flag is never trusted.
 *
 * Covers the 10 required proofs:
 * 1. Local handler is advertised to each directly connected transport.
 * 2. Only receiver-local priorities are advertised; foreign priorities never forwarded.
 * 3. Locally originated request reaches a directly advertised remote handler.
 * 4. Remotely received request dispatches receiver-local handlers only.
 * 5. Receiver resolves host-local semantics from registered metadata, not wire flags.
 * 6. Remote ingress does not wait for unrelated pending transport readiness.
 * 7. Existing priority-cursor semantics for local-middleware-to-direct-host chain.
 * 8. A—B—C topology: A cannot reach C's handler through B.
 * 9. Missing direct ownership returns NoHandler promptly.
 * 10. Existing ordinary request routing, localSubject, and collector-only unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import {
  createBusInstance,
  createBusContext,
  hostLocalRequest,
  localSubject,
  NoHandlerError,
  waitForSubscriptionPropagation,
  type BusMessage,
  type BusRequestMessage,
  type BusTransport,
} from '../index.js';
import { createBidirectionalTransportPair, MockTransport } from './helpers/transport-fixtures.js';

// ---------------------------------------------------------------------------
// Test namespace definitions
// ---------------------------------------------------------------------------

const HostLocalNamespaceDef = createBusNamespace('hostLocal', {
  resolve: hostLocalRequest({
    request: z.object({ capabilityId: z.string() }),
    response: z.object({ available: z.boolean() }),
  }),
  ordinary: {
    request: z.object({ id: z.string() }),
    response: z.object({ value: z.string() }),
  },
  localOnly: localSubject({
    request: z.object({ id: z.string() }),
    response: z.object({ ok: z.boolean() }),
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register the shared test namespace on all given bus instances.
 * @param buses - Bus instances to register the namespace on
 */
function registerTestNamespace(...buses: Array<ReturnType<typeof createBusInstance>>): void {
  for (const bus of buses) {
    bus.registerNamespace(HostLocalNamespaceDef);
  }
}

/**
 * Create a deferred promise whose resolution is externally controlled.
 * @returns A deferred with `promise`, `resolve`, and `reject`
 */
function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Proof 1: Local handler is advertised to each directly connected transport
// ---------------------------------------------------------------------------

describe('Proof 1: local handler advertised to connected transports', () => {
  it('advertises local handler priorities to a connected transport via subscribe', async () => {
    const busA = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA);

    const subscribeSpy = vi.fn<BusTransport['subscribe']>();
    const transport: BusTransport = {
      name: 'test-transport',
      send: vi.fn(async () => true) as BusTransport['send'],
      onReceive: vi.fn(() => () => {}),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      subscribe: subscribeSpy,
      unsubscribe: vi.fn(async () => {}),
    };

    // Register handler at priority 100 BEFORE transport is connected
    const cleanup = busA.on(
      HostLocalNamespaceDef.subjects.resolve,
      (ctx) => {
        ctx.setResult({ available: true });
      },
      { priority: 100 },
    );

    // Register transport — syncAllSubjectsToTransport will push advertised state
    const reg = busA.getContext().transportRegistry.registerTransport('test-transport' as never, transport);

    // Allow the microtask chain to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    try {
      // Transport should have received a subscribe call for hostLocal.resolve
      // with priority 100 in the priorities array.
      const resolveSubscribes = subscribeSpy.mock.calls.filter(([subject]) => subject === 'hostLocal.resolve');
      expect(resolveSubscribes.length).toBeGreaterThanOrEqual(1);

      // Check that the priority 100 is in the advertised priorities
      const lastCall = resolveSubscribes[resolveSubscribes.length - 1];
      const priorities = lastCall[2] as number[];
      expect(priorities).toContain(100);
      expect(lastCall[3]).toBe('first-hop-only');
    } finally {
      cleanup();
      reg.unregister();
      busA.disconnect();
    }
  });

  it('advertises handler priority when handler registered after transport', async () => {
    const busA = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA);

    const subscribeSpy = vi.fn<BusTransport['subscribe']>();
    const transport: BusTransport = {
      name: 'test-transport-2',
      send: vi.fn(async () => true) as BusTransport['send'],
      onReceive: vi.fn(() => () => {}),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      subscribe: subscribeSpy,
      unsubscribe: vi.fn(async () => {}),
    };

    const reg = busA.getContext().transportRegistry.registerTransport('test-transport-2' as never, transport);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    subscribeSpy.mockClear();

    // Register handler AFTER transport is already connected
    const cleanup = busA.on(
      HostLocalNamespaceDef.subjects.resolve,
      (ctx) => {
        ctx.setResult({ available: false });
      },
      { priority: 200 },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    try {
      const resolveSubscribes = subscribeSpy.mock.calls.filter(([subject]) => subject === 'hostLocal.resolve');
      expect(resolveSubscribes.length).toBeGreaterThanOrEqual(1);

      const lastCall = resolveSubscribes[resolveSubscribes.length - 1];
      const priorities = lastCall[2] as number[];
      expect(priorities).toContain(200);
      expect(lastCall[3]).toBe('first-hop-only');
    } finally {
      cleanup();
      reg.unregister();
      busA.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 2: Only receiver-local priorities advertised; foreign never forwarded
// ---------------------------------------------------------------------------

describe('Proof 2: foreign priorities never re-advertised for hostLocalRequest', () => {
  it('advertises only direct local ownership and removes it through real A-B-C subscriptions', async () => {
    const pairAB = createBidirectionalTransportPair({
      label: 'host-local-subscriptions-ab',
      propagateSubscriptions: true,
    });
    const pairBC = createBidirectionalTransportPair({
      label: 'host-local-subscriptions-bc',
      propagateSubscriptions: true,
    });
    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    const busC = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA, busB, busC);

    busA.registerTransport(pairAB.sideA);
    busB.registerTransport(pairAB.sideB);
    busB.registerTransport(pairBC.sideA);
    busC.registerTransport(pairBC.sideB);

    const cleanup = busA.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
      ctx.setResult({ available: true });
    });

    try {
      await waitForSubscriptionPropagation(cleanup);

      expect(busB.getContext().remoteRequestHandlers.get('hostLocal.resolve')).toEqual([
        { transport: pairAB.sideB.name, priority: 0 },
      ]);
      expect(busC.getContext().remoteRequestHandlers.has('hostLocal.resolve')).toBe(false);

      cleanup();
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(busB.getContext().remoteRequestHandlers.has('hostLocal.resolve')).toBe(false);
      expect(busC.getContext().remoteRequestHandlers.has('hostLocal.resolve')).toBe(false);
    } finally {
      busA.disconnect();
      busB.disconnect();
      busC.disconnect();
    }
  });

  it('does not include foreign priorities in advertised state for hostLocalRequest subjects', async () => {
    const busB = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busB);

    // busB has a local handler at priority 50
    const cleanup = busB.on(
      HostLocalNamespaceDef.subjects.resolve,
      (ctx) => {
        ctx.setResult({ available: true });
      },
      { priority: 50 },
    );

    // Simulate that busB has learned foreign priorities from busA
    busB.getContext().remoteRequestHandlers.set('hostLocal.resolve', [{ transport: 'transport-to-a', priority: 300 }]);

    // Now connect a new transport (to busC) and observe what is advertised
    const subscribeSpy = vi.fn<BusTransport['subscribe']>();
    const transportToC: BusTransport = {
      name: 'transport-to-c',
      send: vi.fn(async () => true) as BusTransport['send'],
      onReceive: vi.fn(() => () => {}),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      subscribe: subscribeSpy,
      unsubscribe: vi.fn(async () => {}),
    };

    const reg = busB.getContext().transportRegistry.registerTransport('transport-to-c' as never, transportToC);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    try {
      const resolveSubscribes = subscribeSpy.mock.calls.filter(([subject]) => subject === 'hostLocal.resolve');
      expect(resolveSubscribes.length).toBeGreaterThanOrEqual(1);

      const lastCall = resolveSubscribes[resolveSubscribes.length - 1];
      const priorities = lastCall[2] as number[];

      // Only local priority 50 should be advertised, NOT foreign priority 300
      expect(priorities).toContain(50);
      expect(priorities).not.toContain(300);
    } finally {
      cleanup();
      reg.unregister();
      busB.disconnect();
    }
  });

  it('re-advertises foreign priorities for ordinary (non-hostLocalRequest) subjects', async () => {
    const busB = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busB);

    // busB has a local handler at priority 50 for ordinary subject
    const cleanup = busB.on(
      HostLocalNamespaceDef.subjects.ordinary,
      (ctx) => {
        ctx.setResult({ value: 'test' });
      },
      { priority: 50 },
    );

    // Simulate that busB has learned foreign priorities from busA for ordinary
    busB.getContext().remoteRequestHandlers.set('hostLocal.ordinary', [{ transport: 'transport-to-a', priority: 300 }]);
    busB
      .getContext()
      .remoteSubscriptionDeliveryClasses.set('hostLocal.ordinary', new Map([['transport-to-a', 'relayable']]));

    const subscribeSpy = vi.fn<BusTransport['subscribe']>();
    const transportToC: BusTransport = {
      name: 'transport-to-c-2',
      send: vi.fn(async () => true) as BusTransport['send'],
      onReceive: vi.fn(() => () => {}),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      subscribe: subscribeSpy,
      unsubscribe: vi.fn(async () => {}),
    };

    const reg = busB.getContext().transportRegistry.registerTransport('transport-to-c-2' as never, transportToC);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    try {
      const ordinarySubscribes = subscribeSpy.mock.calls.filter(([subject]) => subject === 'hostLocal.ordinary');
      expect(ordinarySubscribes.length).toBeGreaterThanOrEqual(1);

      const lastCall = ordinarySubscribes[ordinarySubscribes.length - 1];
      const priorities = lastCall[2] as number[];

      // Both local 50 AND foreign 300 should be advertised for ordinary subjects
      expect(priorities).toContain(50);
      expect(priorities).toContain(300);
      expect(lastCall[3]).toBe('relayable');
    } finally {
      cleanup();
      reg.unregister();
      busB.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 3: Locally originated request reaches directly advertised remote handler
// ---------------------------------------------------------------------------

describe('Proof 3: local request reaches directly advertised remote handler', () => {
  it('dispatches to a remote handler for a hostLocalRequest subject', async () => {
    const { sideA, sideB } = createBidirectionalTransportPair({
      label: 'proof3',
    });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });

    registerTestNamespace(busA, busB);

    // busB has a local handler
    const cleanupB = busB.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
      ctx.setResult({ available: true });
    });

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    // Seed remote handler knowledge on busA
    busA.getContext().remoteRequestHandlers.set('hostLocal.resolve', [{ transport: sideA.name, priority: 0 }]);

    try {
      const result = await busA.request(HostLocalNamespaceDef.subjects.resolve, { capabilityId: 'test-cap' });
      expect(result.available).toBe(true);
    } finally {
      cleanupB();
      busA.disconnect();
      busB.disconnect();
    }
  });

  it('dispatches once when wildcard ownership also produces an exact first-hop guard', async () => {
    const pair = createBidirectionalTransportPair({
      label: 'p3-wildcard-guard',
      propagateSubscriptions: true,
    });
    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA, busB);

    busA.registerTransport(pair.sideA);
    busB.registerTransport(pair.sideB);

    const handlerSpy = vi.fn();
    const cleanup = busB.on(
      HostLocalNamespaceDef.subjects.$all,
      () => {
        handlerSpy();
      },
      { handlerKind: 'request' },
    );

    try {
      await waitForSubscriptionPropagation(cleanup);
      expect(busA.getContext().remoteRequestHandlers.get('hostLocal.*')).toEqual([
        { transport: pair.sideA.name, priority: 0 },
      ]);
      expect(busA.getContext().remoteRequestHandlers.get('hostLocal.resolve')).toEqual([
        { transport: pair.sideA.name, priority: 0 },
      ]);

      await expect(
        busA.request(HostLocalNamespaceDef.subjects.resolve, { capabilityId: 'direct-wildcard' }),
      ).rejects.toThrow(NoHandlerError);
      expect(handlerSpy).toHaveBeenCalledOnce();
    } finally {
      cleanup();
      busA.disconnect();
      busB.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 4: Remotely received request dispatches receiver-local handlers only
// ---------------------------------------------------------------------------

describe('Proof 4: inbound hostLocalRequest uses only local handlers', () => {
  it('does not relay to a third transport when receiving a hostLocalRequest', async () => {
    const { sideA: sideAB_A, sideB: sideAB_B } = createBidirectionalTransportPair({ label: 'p4-ab' });
    const { sideA: sideBC_B, sideB: sideBC_C } = createBidirectionalTransportPair({ label: 'p4-bc' });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    const busC = createBusInstance({ context: createBusContext() });

    registerTestNamespace(busA, busB, busC);

    // busB has a local handler
    const cleanupB = busB.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
      ctx.setResult({ available: true });
    });

    // busC has a handler that should NEVER be reached
    const handlerCSpy = vi.fn();
    const cleanupC = busC.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
      handlerCSpy();
      ctx.setResult({ available: false });
    });

    busA.registerTransport(sideAB_A);
    busB.registerTransport(sideAB_B);
    busB.registerTransport(sideBC_B);
    busC.registerTransport(sideBC_C);

    // busA knows busB has a handler
    busA.getContext().remoteRequestHandlers.set('hostLocal.resolve', [{ transport: sideAB_A.name, priority: 0 }]);

    // busB also knows busC has a handler (via subscribe propagation for ordinary
    // subjects, but for hostLocalRequest these are NOT re-advertised; we seed
    // them manually to prove dispatch suppression regardless)
    busB.getContext().remoteRequestHandlers.set('hostLocal.resolve', [{ transport: sideBC_B.name, priority: 0 }]);

    try {
      const result = await busA.request(HostLocalNamespaceDef.subjects.resolve, { capabilityId: 'test-cap' });

      // busB's handler should have responded
      expect(result.available).toBe(true);

      // busC's handler must NOT have been invoked
      expect(handlerCSpy).not.toHaveBeenCalled();
    } finally {
      cleanupB();
      cleanupC();
      busA.disconnect();
      busB.disconnect();
      busC.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 5: Receiver resolves semantics from metadata, not wire flags
// ---------------------------------------------------------------------------

describe('Proof 5: receiver resolves hostLocalRequest from metadata, not wire flag', () => {
  it('treats a registered hostLocalRequest subject as local-only regardless of wire message', async () => {
    const { sideB } = createBidirectionalTransportPair({
      label: 'p5',
    });
    const { sideA: sideBC_B, sideB: sideBC_C } = createBidirectionalTransportPair({ label: 'p5-bc' });

    const busB = createBusInstance({ context: createBusContext() });
    const busC = createBusInstance({ context: createBusContext() });

    registerTestNamespace(busB, busC);

    // busB has local handler
    const cleanupB = busB.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
      ctx.setResult({ available: true });
    });

    // busC has handler — should not be reached because busB enforces localOnly
    const handlerCSpy = vi.fn();
    const cleanupC = busC.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
      handlerCSpy();
      ctx.setResult({ available: false });
    });

    busB.registerTransport(sideB);
    busB.registerTransport(sideBC_B);
    busC.registerTransport(sideBC_C);

    // Seed busB's knowledge of busC's handler
    busB.getContext().remoteRequestHandlers.set('hostLocal.resolve', [{ transport: sideBC_B.name, priority: 0 }]);

    try {
      // Inject a request directly into busB's transport — the wire message
      // carries no hostLocalRequest flag. busB must resolve it from metadata.
      await sideB.simulateReceive({
        type: 'request',
        namespace: 'hostLocal',
        subject: 'resolve',
        payload: { capabilityId: 'test' },
        correlationId: 'proof5-corr',
        messageId: 'proof5-msg',
        timeout: 5000,
      } satisfies BusRequestMessage);

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // busC's handler must NOT have been called
      expect(handlerCSpy).not.toHaveBeenCalled();
    } finally {
      cleanupB();
      cleanupC();
      busB.disconnect();
      busC.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 6: Remote ingress does not wait for unrelated pending transport readiness
// ---------------------------------------------------------------------------

describe('Proof 6: inbound hostLocalRequest skips readiness gate', () => {
  it('does not wait for pending transports when dispatching inbound hostLocalRequest', async () => {
    const sentMessages: BusMessage[] = [];
    const { sideB } = createBidirectionalTransportPair({
      label: 'p6',
      spy: (message) => sentMessages.push(message),
    });

    const busB = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busB);

    // busB has a local handler — use a spy to verify it executes
    const handlerSpy = vi.fn();
    const cleanupB = busB.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
      handlerSpy();
      ctx.setResult({ available: true });
    });

    busB.registerTransport(sideB);

    // Register a second transport with a never-resolving ready promise
    const neverReady: BusTransport = {
      name: 'never-ready-transport',
      send: vi.fn(async () => true) as BusTransport['send'],
      onReceive: vi.fn(() => () => {}),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      ready: new Promise<void>(() => {}), // never resolves
    };

    const neverReadyReg = busB
      .getContext()
      .transportRegistry.registerTransport('never-ready-transport' as never, neverReady);

    try {
      // Inject an inbound request. With localOnly: true (from hostLocalRequest
      // enforcement), the readiness gate is skipped, so this should resolve
      // immediately rather than hanging on the never-settling ready promise.
      await sideB.simulateReceive({
        type: 'request',
        namespace: 'hostLocal',
        subject: 'resolve',
        payload: { capabilityId: 'test' },
        correlationId: 'proof6-corr',
        messageId: 'proof6-msg',
        timeout: 500,
      } satisfies BusRequestMessage);

      // Allow the microtask chain to settle
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // Handler must have been invoked — proves the readiness gate was skipped
      expect(handlerSpy).toHaveBeenCalledOnce();

      // Verify the response was sent back through the transport
      const response = sentMessages.find(
        (m) => m.type === 'response' && 'correlationId' in m && m.correlationId === 'proof6-corr',
      );
      expect(response).toBeDefined();
      expect(response).toMatchObject({
        type: 'response',
        correlationId: 'proof6-corr',
        result: { available: true },
      });
    } finally {
      cleanupB();
      neverReadyReg.unregister();
      busB.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 7: Existing priority-cursor semantics for local-middleware chain
// ---------------------------------------------------------------------------

describe('Proof 7: priority-cursor semantics intact for hostLocalRequest', () => {
  it('local middleware at higher priority chains to local terminal handler', async () => {
    const { sideA, sideB } = createBidirectionalTransportPair({
      label: 'p7',
    });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });

    registerTestNamespace(busA, busB);

    const executionOrder: string[] = [];

    // busB: middleware at priority 200
    const cleanupB200 = busB.on(
      HostLocalNamespaceDef.subjects.resolve,
      async (ctx) => {
        executionOrder.push('busB-200');
        await ctx.next();
      },
      { priority: 200 },
    );

    // busB: terminal handler at priority 0
    const cleanupB0 = busB.on(
      HostLocalNamespaceDef.subjects.resolve,
      (ctx) => {
        executionOrder.push('busB-0');
        ctx.setResult({ available: true });
      },
      { priority: 0 },
    );

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    // busA knows about busB's handler (advertised priorities)
    busA.getContext().remoteRequestHandlers.set('hostLocal.resolve', [{ transport: sideA.name, priority: 200 }]);

    try {
      const result = await busA.request(HostLocalNamespaceDef.subjects.resolve, { capabilityId: 'cursor-test' });

      // Both busB handlers should run in priority order
      expect(executionOrder).toEqual(['busB-200', 'busB-0']);
      expect(result.available).toBe(true);
    } finally {
      cleanupB200();
      cleanupB0();
      busA.disconnect();
      busB.disconnect();
    }
  });

  it('ordinary first hop carries no cursor and includes the terminal handler', async () => {
    const { sideA, sideB } = createBidirectionalTransportPair({
      label: 'p7b',
    });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });

    registerTestNamespace(busA, busB);

    // busB: terminal handler at priority 0 (default)
    const cleanupB = busB.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
      ctx.setResult({ available: true });
    });

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    // busA knows about busB's handler at priority 0
    busA.getContext().remoteRequestHandlers.set('hostLocal.resolve', [{ transport: sideA.name, priority: 0 }]);

    try {
      const result = await busA.request(HostLocalNamespaceDef.subjects.resolve, { capabilityId: 'no-cursor-test' });

      // Direct first hop — no cursor sent, terminal handler must run
      expect(result.available).toBe(true);
    } finally {
      cleanupB();
      busA.disconnect();
      busB.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 8: A—B—C topology: A cannot reach C's handler through B
// ---------------------------------------------------------------------------

describe('Proof 8: A—B—C topology prevents relay through B', () => {
  it('preserves first-hop-only semantics through a schema-less relay control plane', async () => {
    const pairAB = createBidirectionalTransportPair({
      label: 'p8-schema-less-ab',
      propagateSubscriptions: true,
    });
    const pairBC = createBidirectionalTransportPair({
      label: 'p8-schema-less-bc',
      propagateSubscriptions: true,
    });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    const busC = createBusInstance({ context: createBusContext() });

    // B is intentionally schema-less: only the owner and caller know the schema.
    registerTestNamespace(busA, busC);

    busA.registerTransport(pairAB.sideA);
    busB.registerTransport(pairAB.sideB);
    const registrationBC = busB.registerTransport(pairBC.sideA);
    busC.registerTransport(pairBC.sideB);

    const handlerCSpy = vi.fn();
    let cleanupC = busC.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
      handlerCSpy();
      ctx.setResult({ available: true });
    });

    try {
      await waitForSubscriptionPropagation(cleanupC);

      expect(busB.getContext().remoteRequestHandlers.get('hostLocal.resolve')).toEqual([
        { transport: pairBC.sideA.name, priority: 0 },
      ]);
      expect(busB.getContext().remoteSubscriptionDeliveryClasses.get('hostLocal.resolve')?.get(pairBC.sideA.name)).toBe(
        'first-hop-only',
      );
      expect(busA.getContext().remoteRequestHandlers.has('hostLocal.resolve')).toBe(false);

      // Force a stale/forged A→B route. B must still enforce the owner-derived
      // subscription provenance and refuse to turn ingress into a second hop.
      busA.getContext().remoteRequestHandlers.set('hostLocal.resolve', [{ transport: pairAB.sideA.name, priority: 0 }]);

      await expect(
        busA.request(HostLocalNamespaceDef.subjects.resolve, { capabilityId: 'schema-less-relay' }),
      ).rejects.toThrow(NoHandlerError);
      expect(handlerCSpy).not.toHaveBeenCalled();

      cleanupC();
      await vi.waitFor(() => {
        expect(busB.getContext().remoteSubscriptionDeliveryClasses.has('hostLocal.resolve')).toBe(false);
      });

      cleanupC = busC.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
        ctx.setResult({ available: true });
      });
      await waitForSubscriptionPropagation(cleanupC);
      expect(busB.getContext().remoteSubscriptionDeliveryClasses.has('hostLocal.resolve')).toBe(true);

      registrationBC.unregister();
      expect(busB.getContext().remoteSubscriptionDeliveryClasses.has('hostLocal.resolve')).toBe(false);
    } finally {
      cleanupC();
      busA.disconnect();
      busB.disconnect();
      busC.disconnect();
    }
  });

  it('guards host-local subjects covered by a relayable wildcard handler', async () => {
    const pairAB = createBidirectionalTransportPair({
      label: 'p8-wildcard-ab',
      propagateSubscriptions: true,
    });
    const pairBC = createBidirectionalTransportPair({
      label: 'p8-wildcard-bc',
      propagateSubscriptions: true,
    });
    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    const busC = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA, busC);

    busA.registerTransport(pairAB.sideA);
    busB.registerTransport(pairAB.sideB);
    busB.registerTransport(pairBC.sideA);
    busC.registerTransport(pairBC.sideB);

    const handlerCSpy = vi.fn();
    const cleanupC = busC.on(
      HostLocalNamespaceDef.subjects.$all,
      () => {
        handlerCSpy();
      },
      { handlerKind: 'request' },
    );

    try {
      await waitForSubscriptionPropagation(cleanupC);

      expect(busB.getContext().remoteSubscriptionDeliveryClasses.get('hostLocal.*')?.get(pairBC.sideA.name)).toBe(
        'relayable',
      );
      expect(busB.getContext().remoteSubscriptionDeliveryClasses.get('hostLocal.resolve')?.get(pairBC.sideA.name)).toBe(
        'first-hop-only',
      );
      expect(busA.getContext().remoteRequestHandlers.get('hostLocal.*')).toEqual([
        { transport: pairAB.sideA.name, priority: 0 },
      ]);

      await expect(
        busA.request(HostLocalNamespaceDef.subjects.resolve, { capabilityId: 'wildcard-relay' }),
      ).rejects.toThrow(NoHandlerError);
      expect(handlerCSpy).not.toHaveBeenCalled();
    } finally {
      cleanupC();
      busA.disconnect();
      busB.disconnect();
      busC.disconnect();
    }
  });

  it("A cannot reach C's hostLocalRequest handler through B", async () => {
    const pairAB = createBidirectionalTransportPair({ label: 'p8-ab' });
    const pairBC = createBidirectionalTransportPair({ label: 'p8-bc' });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    const busC = createBusInstance({ context: createBusContext() });

    registerTestNamespace(busA, busB, busC);

    // busC has a handler
    const handlerCSpy = vi.fn();
    const cleanupC = busC.on(HostLocalNamespaceDef.subjects.resolve, (ctx) => {
      handlerCSpy();
      ctx.setResult({ available: true });
    });

    // busB has NO local handler for resolve — it could only relay

    busA.registerTransport(pairAB.sideA);
    busB.registerTransport(pairAB.sideB);
    busB.registerTransport(pairBC.sideA);
    busC.registerTransport(pairBC.sideB);

    // busA thinks busB can handle resolve (seeded manually; in practice this
    // would not happen because busB does not re-advertise foreign priorities
    // for hostLocalRequest subjects, but we seed it to prove dispatch-level
    // suppression as a defense-in-depth)
    busA.getContext().remoteRequestHandlers.set('hostLocal.resolve', [{ transport: pairAB.sideA.name, priority: 0 }]);

    // busB has learned about busC's handler
    busB.getContext().remoteRequestHandlers.set('hostLocal.resolve', [{ transport: pairBC.sideA.name, priority: 0 }]);

    try {
      // busA's request should get NoHandlerError because busB has no local
      // handler and cannot relay to busC.
      await expect(
        busA.request(HostLocalNamespaceDef.subjects.resolve, { capabilityId: 'test' }, { timeout: 2000 }),
      ).rejects.toThrow(NoHandlerError);

      // busC's handler must NOT have been invoked
      expect(handlerCSpy).not.toHaveBeenCalled();
    } finally {
      cleanupC();
      busA.disconnect();
      busB.disconnect();
      busC.disconnect();
    }
  });

  it('A CAN reach C through B for ordinary (non-hostLocalRequest) subjects', async () => {
    const pairAB = createBidirectionalTransportPair({ label: 'p8b-ab' });
    const pairBC = createBidirectionalTransportPair({ label: 'p8b-bc' });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    const busC = createBusInstance({ context: createBusContext() });

    registerTestNamespace(busA, busB, busC);

    // busC has a handler for ordinary subject
    const cleanupC = busC.on(HostLocalNamespaceDef.subjects.ordinary, (ctx) => {
      ctx.setResult({ value: 'from-C' });
    });

    busA.registerTransport(pairAB.sideA);
    busB.registerTransport(pairAB.sideB);
    busB.registerTransport(pairBC.sideA);
    busC.registerTransport(pairBC.sideB);

    // busA knows busB has a handler (or relay) for ordinary
    busA.getContext().remoteRequestHandlers.set('hostLocal.ordinary', [{ transport: pairAB.sideA.name, priority: 0 }]);

    // busB knows about busC's handler for ordinary subject
    busB.getContext().remoteRequestHandlers.set('hostLocal.ordinary', [{ transport: pairBC.sideA.name, priority: 0 }]);
    busB
      .getContext()
      .remoteSubscriptionDeliveryClasses.set('hostLocal.ordinary', new Map([[pairBC.sideA.name, 'relayable']]));

    try {
      const result = await busA.request(
        HostLocalNamespaceDef.subjects.ordinary,
        { id: 'relay-test' },
        { timeout: 2000 },
      );

      // Ordinary subjects CAN relay through B to reach C
      expect(result.value).toBe('from-C');
    } finally {
      cleanupC();
      busA.disconnect();
      busB.disconnect();
      busC.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 9: Missing direct ownership returns NoHandler promptly
// ---------------------------------------------------------------------------

describe('Proof 9: missing direct ownership returns NoHandler promptly', () => {
  it('returns NoHandlerError when no handler exists for hostLocalRequest subject', async () => {
    const busA = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA);

    // No handler registered — should get NoHandlerError immediately
    try {
      await expect(
        busA.request(HostLocalNamespaceDef.subjects.resolve, { capabilityId: 'missing' }, { timeout: 2000 }),
      ).rejects.toThrow(NoHandlerError);
    } finally {
      busA.disconnect();
    }
  });

  it('returns NoHandlerError promptly after subscribe-sync for hostLocalRequest with no direct handler', async () => {
    const deferred = createDeferred();
    const busA = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busA);

    const transport: BusTransport = {
      name: 'deferred-transport',
      send: vi.fn(async () => true) as BusTransport['send'],
      onReceive: vi.fn(() => () => {}),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      ready: deferred.promise,
    };

    const reg = busA.getContext().transportRegistry.registerTransport('deferred-transport' as never, transport);

    // Resolve ready quickly but without seeding any handlers
    setTimeout(() => {
      deferred.resolve();
    }, 5);

    try {
      // Since the subject uses hostLocalRequest, and the caller (busA) is
      // not an inbound transport message, the request goes through normal
      // dispatch. Without a local handler or remote handler, it should fail
      // promptly after the readiness gate resolves.
      await expect(
        busA.request(HostLocalNamespaceDef.subjects.resolve, { capabilityId: 'no-handler' }, { timeout: 2000 }),
      ).rejects.toThrow(NoHandlerError);
    } finally {
      reg.unregister();
      busA.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 10: Existing ordinary, localSubject, collector-only unchanged
// ---------------------------------------------------------------------------

describe('Proof 10: existing routing behaviors unchanged', () => {
  it('ordinary request still routes through transports normally', async () => {
    const { sideA, sideB } = createBidirectionalTransportPair({
      label: 'p10-ordinary',
    });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });

    registerTestNamespace(busA, busB);

    const cleanupB = busB.on(HostLocalNamespaceDef.subjects.ordinary, (ctx) => {
      ctx.setResult({ value: 'ordinary-works' });
    });

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    busA.getContext().remoteRequestHandlers.set('hostLocal.ordinary', [{ transport: sideA.name, priority: 0 }]);

    try {
      const result = await busA.request(HostLocalNamespaceDef.subjects.ordinary, { id: 'test' });
      expect(result.value).toBe('ordinary-works');
    } finally {
      cleanupB();
      busA.disconnect();
      busB.disconnect();
    }
  });

  it('localSubject still rejects remote requests with LocalSubjectError', async () => {
    const mockTransport = new MockTransport('p10-local-transport');

    const busB = createBusInstance({ context: createBusContext() });
    registerTestNamespace(busB);

    // Register handler — it should NOT be called for remote requests
    const handlerSpy = vi.fn();
    const cleanupB = busB.on(HostLocalNamespaceDef.subjects.localOnly, (ctx) => {
      handlerSpy();
      ctx.setResult({ ok: true });
    });

    busB.registerTransport(mockTransport);

    try {
      // Inject a request for a local-only subject — should get LocalSubjectError
      await mockTransport.simulateReceive({
        type: 'request',
        namespace: 'hostLocal',
        subject: 'localOnly',
        payload: { id: 'test' },
        correlationId: 'p10-local-corr',
        messageId: 'p10-local-msg',
        timeout: 5000,
      } satisfies BusRequestMessage);

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // The handler must NOT have been called — local subjects reject remote requests
      expect(handlerSpy).not.toHaveBeenCalled();

      // The transport should have received an error response
      expect(mockTransport.messages).toHaveLength(1);
      expect(mockTransport.messages[0]).toMatchObject({
        type: 'response',
        correlationId: 'p10-local-corr',
        error: expect.objectContaining({
          message: expect.stringContaining('local-only'),
        }),
      });
    } finally {
      cleanupB();
      busB.disconnect();
    }
  });

  it('namespace registry correctly tracks all three subject types', () => {
    const bus = createBusInstance({ context: createBusContext() });
    registerTestNamespace(bus);

    const registry = bus.getContext().namespaceRegistry;

    // hostLocalRequest subject
    expect(registry.isHostLocalRequestSubject('hostLocal.resolve')).toBe(true);
    expect(registry.isLocalSubject('hostLocal.resolve')).toBe(false);

    // ordinary subject
    expect(registry.isHostLocalRequestSubject('hostLocal.ordinary')).toBe(false);
    expect(registry.isLocalSubject('hostLocal.ordinary')).toBe(false);

    // localSubject
    expect(registry.isLocalSubject('hostLocal.localOnly')).toBe(true);
    expect(registry.isHostLocalRequestSubject('hostLocal.localOnly')).toBe(false);

    bus.disconnect();
  });

  it('RegisteredSubjectSchema includes hostLocalRequest flag', () => {
    const bus = createBusInstance({ context: createBusContext() });
    registerTestNamespace(bus);

    const registry = bus.getContext().namespaceRegistry;
    const subjects = registry.listRegisteredSubjects();

    const resolveSubject = subjects.find((s) => s.fullSubject === 'hostLocal.resolve');
    expect(resolveSubject).toBeDefined();
    expect(resolveSubject!.hostLocalRequest).toBe(true);

    const ordinarySubject = subjects.find((s) => s.fullSubject === 'hostLocal.ordinary');
    expect(ordinarySubject).toBeDefined();
    expect(ordinarySubject!.hostLocalRequest).toBe(false);

    bus.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Namespace collision: routing metadata mismatch detection
// ---------------------------------------------------------------------------

describe('namespace collision: routing metadata mismatch throws', () => {
  it('throws when hostLocalRequest is registered first and plain request second', () => {
    const bus = createBusInstance({ context: createBusContext() });

    // First registration: resolve is hostLocalRequest
    const defWithHostLocal = createBusNamespace('collisionTest', {
      resolve: hostLocalRequest({
        request: z.object({ id: z.string() }),
        response: z.object({ ok: z.boolean() }),
      }),
    });
    bus.registerNamespace(defWithHostLocal);

    // Second registration: resolve is a plain request (no hostLocalRequest wrapper)
    const defWithoutHostLocal = createBusNamespace('collisionTest', {
      resolve: {
        request: z.object({ id: z.string() }),
        response: z.object({ ok: z.boolean() }),
      },
    });

    expect(() => bus.registerNamespace(defWithoutHostLocal)).toThrow(/routing metadata.*hostLocalRequest/i);

    bus.disconnect();
  });

  it('throws when plain request is registered first and hostLocalRequest second', () => {
    const bus = createBusInstance({ context: createBusContext() });

    // First registration: resolve is a plain request
    const defWithoutHostLocal = createBusNamespace('collisionTest2', {
      resolve: {
        request: z.object({ id: z.string() }),
        response: z.object({ ok: z.boolean() }),
      },
    });
    bus.registerNamespace(defWithoutHostLocal);

    // Second registration: resolve is hostLocalRequest
    const defWithHostLocal = createBusNamespace('collisionTest2', {
      resolve: hostLocalRequest({
        request: z.object({ id: z.string() }),
        response: z.object({ ok: z.boolean() }),
      }),
    });

    expect(() => bus.registerNamespace(defWithHostLocal)).toThrow(/routing metadata.*hostLocalRequest/i);

    bus.disconnect();
  });

  it('throws when localSubject and plain subject collide', () => {
    const bus = createBusInstance({ context: createBusContext() });

    const defWithLocal = createBusNamespace('collisionTest3', {
      event: localSubject(z.object({ id: z.string() })),
    });
    bus.registerNamespace(defWithLocal);

    const defWithoutLocal = createBusNamespace('collisionTest3', {
      event: z.object({ id: z.string() }),
    });

    expect(() => bus.registerNamespace(defWithoutLocal)).toThrow(/routing metadata.*local/i);

    bus.disconnect();
  });

  it('allows idempotent re-registration with identical routing metadata', () => {
    const bus = createBusInstance({ context: createBusContext() });

    const def = createBusNamespace('collisionTest4', {
      resolve: hostLocalRequest({
        request: z.object({ id: z.string() }),
        response: z.object({ ok: z.boolean() }),
      }),
    });

    // First and second registration should both succeed
    bus.registerNamespace(def);
    expect(() => bus.registerNamespace(def)).not.toThrow();

    bus.disconnect();
  });
});
