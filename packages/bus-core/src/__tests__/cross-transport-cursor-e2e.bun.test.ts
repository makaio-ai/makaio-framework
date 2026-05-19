/**
 * E2E tests for cross-transport priority cursor semantics.
 *
 * These tests exercise REAL dispatch on both sides of a bidirectional
 * in-process transport pair. No transport stubs — the receiving bus runs
 * its full dispatch loop and sends back a real response message.
 *
 * Covers:
 * - Test A: cursor value in outbound BusRequestMessage equals priority of preceding local handler
 * - Test B: receiver skips handlers at or above the cursor (starts below it)
 * - Test C: full interleaved three-hop chain (busA:400 → busB:300 → busA:100)
 * - Test D: same-priority remote-to-remote cursor bump (remoteA:300 → remoteB:300)
 * - Test E: fire-and-forget ctx.next() propagates downstream result
 * - Test F: fire-and-forget ctx.next() propagates downstream errors
 * - Test G: remote NoHandlerError falls through to local handler (real registry on both sides)
 */

import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { createBusInstance, createBusContext, type BusRequestMessage, RequestError, NoHandlerError } from '../index.js';
import { createBidirectionalTransportPair } from './helpers/transport-fixtures.js';

// ---------------------------------------------------------------------------
// Isolated namespace for cursor E2E tests
// ---------------------------------------------------------------------------

// We use a fresh bus instance just for namespace registration so the schemas
// are available to the isolated instances created in each test.
const schemaRegistry = createBusInstance({ context: createBusContext() });

const CursorNamespaceDefinition = createBusNamespace('cursorE2e', {
  compute: {
    request: z.object({ value: z.number() }),
    response: z.object({ result: z.number(), handledBy: z.string() }),
  },
});

const { subjects: CursorSubjects } = schemaRegistry.registerNamespace(CursorNamespaceDefinition);

/**
 * Register the shared cursor namespace on isolated bus instances used by tests.
 * @param buses - Bus instances that should accept cursor test subjects.
 */
function registerCursorNamespace(...buses: Array<ReturnType<typeof createBusInstance>>): void {
  for (const bus of buses) {
    bus.registerNamespace(CursorNamespaceDefinition);
  }
}

declare module '../index.js' {
  interface BusSubjectsNamespace {
    cursorE2e: typeof CursorSubjects;
  }
}

// ---------------------------------------------------------------------------
// Test A: cursor in outbound BusRequestMessage equals priority of preceding local handler
// ---------------------------------------------------------------------------

describe('Test A: cursor in outbound request equals preceding local handler priority', () => {
  it('sends priority=400 cursor to busB when local:400 immediately precedes remote:300', async () => {
    const capturedMessages: BusRequestMessage[] = [];

    const { sideA, sideB } = createBidirectionalTransportPair({
      spy: (message, direction) => {
        if (direction === 'a-to-b' && message.type === 'request') {
          capturedMessages.push(message as BusRequestMessage);
        }
      },
    });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });

    registerCursorNamespace(busA, busB);

    // busA: local handler at priority 400 — delegates to next()
    const cleanupA400 = busA.on(
      CursorSubjects.compute,
      async (ctx) => {
        await ctx.next();
      },
      { priority: 400 },
    );

    // busA: local fallback handler at priority 100 — returns a result if remote doesn't handle
    const cleanupA100 = busA.on(
      CursorSubjects.compute,
      (ctx) => {
        ctx.setResult({ result: 100, handledBy: 'busA-100' });
      },
      { priority: 100 },
    );

    // busB: local handler at priority 300 — handles the request
    const cleanupB300 = busB.on(
      CursorSubjects.compute,
      (ctx) => {
        ctx.setResult({ result: 300, handledBy: 'busB-300' });
      },
      { priority: 300 },
    );

    // Register transports on both sides
    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    // Seed remoteRequestHandlers manually (subscribe propagation is no-op for this pair)
    busA
      .getContext()
      .remoteRequestHandlers.set('cursorE2e.compute', [{ transport: 'in-process-side-a', priority: 300 }]);

    try {
      const result = await busA.request(CursorSubjects.compute, { value: 1 });

      // busB's handler at 300 should handle the request
      expect(result.handledBy).toBe('busB-300');
      expect(result.result).toBe(300);

      // The A→B request message must carry priority=400 (preceding local entry's priority)
      // because 400 !== 300 so no bump is applied: cursor = merged[nextIndex-2].priority = 400
      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0].priority).toBe(400);
    } finally {
      busA.disconnect();
      busB.disconnect();
      cleanupA400();
      cleanupA100();
      cleanupB300();
    }
  });
});

// ---------------------------------------------------------------------------
// Test B: receiver starts dispatch below the cursor
// ---------------------------------------------------------------------------

describe('Test B: receiver starts dispatch strictly below the cursor', () => {
  it('only runs handlers with priority < cursor, skipping those at or above', async () => {
    const executionOrder: string[] = [];

    const { sideA, sideB } = createBidirectionalTransportPair();

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });

    registerCursorNamespace(busA, busB);

    // busB handlers at three priority tiers
    const cleanupB500 = busB.on(
      CursorSubjects.compute,
      (ctx) => {
        executionOrder.push('busB-500');
        ctx.setResult({ result: 500, handledBy: 'busB-500' });
      },
      { priority: 500 },
    );

    const cleanupB300 = busB.on(
      CursorSubjects.compute,
      (ctx) => {
        executionOrder.push('busB-300');
        ctx.setResult({ result: 300, handledBy: 'busB-300' });
      },
      { priority: 300 },
    );

    const cleanupB100 = busB.on(
      CursorSubjects.compute,
      (ctx) => {
        executionOrder.push('busB-100');
        ctx.setResult({ result: 100, handledBy: 'busB-100' });
      },
      { priority: 100 },
    );

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    try {
      // Inject a BusRequestMessage directly into busB with priority cursor = 300.
      // Dispatch on busB must start strictly below 300, so only the priority-100
      // handler runs (500 and 300 are not < 300).
      await sideB.simulateReceive({
        type: 'request',
        namespace: 'cursorE2e',
        subject: 'compute',
        payload: { value: 42 },
        correlationId: 'test-b-corr',
        messageId: 'test-b-msg',
        timeout: 5_000,
        priority: 300,
      } satisfies BusRequestMessage);

      // Allow the microtask chain to settle
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      // Only the priority-100 handler should have run
      expect(executionOrder).toEqual(['busB-100']);
    } finally {
      busA.disconnect();
      busB.disconnect();
      cleanupB500();
      cleanupB300();
      cleanupB100();
    }
  });
});

// ---------------------------------------------------------------------------
// Test C: full interleaved three-hop chain (busA:400 → busB:300 → busA:100)
// ---------------------------------------------------------------------------

describe('Test C: full interleaved three-hop chain busA:400 → busB:300 → busA:100', () => {
  it('executes handlers in priority order across two bus instances', async () => {
    const executionOrder: string[] = [];

    const { sideA, sideB } = createBidirectionalTransportPair();

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });

    registerCursorNamespace(busA, busB);

    // busA: priority 400 — intercepts then delegates
    const cleanupA400 = busA.on(
      CursorSubjects.compute,
      async (ctx) => {
        executionOrder.push('busA-400');
        await ctx.next();
      },
      { priority: 400 },
    );

    // busA: priority 100 — terminal handler
    const cleanupA100 = busA.on(
      CursorSubjects.compute,
      (ctx) => {
        executionOrder.push('busA-100');
        ctx.setResult({ result: 100, handledBy: 'busA-100' });
      },
      { priority: 100 },
    );

    // busB: priority 300 — delegates to next()
    const cleanupB300 = busB.on(
      CursorSubjects.compute,
      async (ctx) => {
        executionOrder.push('busB-300');
        await ctx.next();
      },
      { priority: 300 },
    );

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    // busA knows that busB handles cursorE2e.compute at priority 300
    busA
      .getContext()
      .remoteRequestHandlers.set('cursorE2e.compute', [{ transport: 'in-process-side-a', priority: 300 }]);

    // busB knows that busA handles cursorE2e.compute at priority 100
    busB
      .getContext()
      .remoteRequestHandlers.set('cursorE2e.compute', [{ transport: 'in-process-side-b', priority: 100 }]);

    try {
      const result = await busA.request(CursorSubjects.compute, { value: 7 });

      // Execution must follow descending priority order across transport boundaries
      expect(executionOrder).toEqual(['busA-400', 'busB-300', 'busA-100']);

      // Final result comes from busA's priority-100 handler
      expect(result.handledBy).toBe('busA-100');
      expect(result.result).toBe(100);
    } finally {
      busA.disconnect();
      busB.disconnect();
      cleanupA400();
      cleanupA100();
      cleanupB300();
    }
  });
});

// ---------------------------------------------------------------------------
// Test D: same-priority remote-to-remote cursor bump
// ---------------------------------------------------------------------------

describe('Test D: same-priority remote-to-remote entries get correct cursor', () => {
  it('bumps cursor for second remote:300 so it does not skip its own 300-tier handlers', async () => {
    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    const busC = createBusInstance({ context: createBusContext() });

    registerCursorNamespace(busA, busB, busC);

    // Create two bidirectional pairs: A↔B and A↔C
    // Each pair needs a distinct label so transport names don't collide
    // when both sideA transports are registered on busA.
    const pairAB = createBidirectionalTransportPair({ label: 'ab' });
    const pairAC = createBidirectionalTransportPair({ label: 'ac' });

    busA.registerTransport(pairAB.sideA);
    busB.registerTransport(pairAB.sideB);
    busA.registerTransport(pairAC.sideA);
    busC.registerTransport(pairAC.sideB);

    // busA has two remote entries at priority 300: one on B, one on C
    // They are sorted by insertion order — B first, then C
    busA.getContext().remoteRequestHandlers.set('cursorE2e.compute', [
      { transport: pairAB.sideA.name, priority: 300 },
      { transport: pairAC.sideA.name, priority: 300 },
    ]);

    // busB has a handler at priority 300 that calls next (defers)
    const cleanupB = busB.on(
      CursorSubjects.compute,
      async (ctx) => {
        await ctx.next();
      },
      { priority: 300 },
    );

    // busC has a handler at priority 300 that returns a result
    const cleanupC = busC.on(
      CursorSubjects.compute,
      (ctx) => {
        ctx.setResult({ result: 300, handledBy: 'busC-300' });
      },
      { priority: 300 },
    );

    try {
      const result = await busA.request(CursorSubjects.compute, { value: 42 });

      // busC's handler at priority 300 must run (not be skipped by cursor)
      expect(result.handledBy).toBe('busC-300');
      expect(result.result).toBe(300);
    } finally {
      busA.disconnect();
      busB.disconnect();
      busC.disconnect();
      cleanupB();
      cleanupC();
    }
  });
});

// ---------------------------------------------------------------------------
// Test E: fire-and-forget ctx.next() propagates downstream result
// ---------------------------------------------------------------------------

describe('Test E: fire-and-forget ctx.next() propagates downstream result', () => {
  it('returns downstream result when handler A calls ctx.next() without await', async () => {
    const bus = createBusInstance({ context: createBusContext() });

    registerCursorNamespace(bus);

    // Handler A (priority 200): fire-and-forget next()
    const cleanupA = bus.on(
      CursorSubjects.compute,
      (ctx) => {
        // Intentionally not awaited — the dispatch layer must still settle this.
        void ctx.next();
      },
      { priority: 200 },
    );

    // Handler B (priority 100): terminal handler
    const cleanupB = bus.on(
      CursorSubjects.compute,
      (ctx) => {
        ctx.setResult({ result: 42, handledBy: 'B' });
      },
      { priority: 100 },
    );

    try {
      const result = await bus.request(CursorSubjects.compute, { value: 1 });

      expect(result.result).toBe(42);
      expect(result.handledBy).toBe('B');
    } finally {
      bus.disconnect();
      cleanupA();
      cleanupB();
    }
  });
});

// ---------------------------------------------------------------------------
// Test F: fire-and-forget ctx.next() propagates downstream errors
// ---------------------------------------------------------------------------

describe('Test F: fire-and-forget ctx.next() propagates downstream errors', () => {
  it('rejects with RequestError when handler A fires ctx.next() without await and B throws', async () => {
    const bus = createBusInstance({ context: createBusContext() });

    registerCursorNamespace(bus);

    // Handler A (priority 200): fire-and-forget next()
    const cleanupA = bus.on(
      CursorSubjects.compute,
      (ctx) => {
        // Intentionally not awaited — errors from B must still surface.
        void ctx.next();
      },
      { priority: 200 },
    );

    // Handler B (priority 100): throws a downstream error
    const cleanupB = bus.on(
      CursorSubjects.compute,
      () => {
        throw new Error('downstream');
      },
      { priority: 100 },
    );

    try {
      let caughtError: unknown;
      try {
        await bus.request(CursorSubjects.compute, { value: 1 });
      } catch (err) {
        caughtError = err;
      }
      expect(caughtError).toBeInstanceOf(RequestError);
      expect((caughtError as RequestError).cause).toBeInstanceOf(Error);
      expect(((caughtError as RequestError).cause as Error).message).toBe('downstream');
    } finally {
      bus.disconnect();
      cleanupA();
      cleanupB();
    }
  });
});

// ---------------------------------------------------------------------------
// Test G: remote NoHandlerError falls through to local handler (real registries)
//
// This test addresses the TODO in cross-transport-priority-dispatch.test.ts
// (Scenario 1) which noted that the stub-based test bypasses the receiving
// transport registry. Here BOTH sides run real dispatch: busB processes the
// incoming request through its own handler chain and returns NoHandlerError
// when its chain is exhausted, allowing busA's lower-priority local handler
// to pick up the request.
//
// Execution order expected: busA-400 → busB-300 (NoHandlerError) → busA-100
// ---------------------------------------------------------------------------

describe('Test G: remote NoHandlerError falls through to lower-priority local handler', () => {
  it('falls through to local:100 when real remote registry exhausts its chain and returns NoHandlerError', async () => {
    const executionOrder: string[] = [];

    // busB has a single handler at priority 300 that calls ctx.next() — its chain
    // is then exhausted, so the transport registry replies with NoHandlerError.
    // busA has a local:400 that delegates and a local:100 that terminates.
    // Expected: busA-400 → busB-300 → busA-100.

    const { sideA, sideB } = createBidirectionalTransportPair({ label: 'g-fallthrough' });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });

    registerCursorNamespace(busA, busB);

    // busA:400 — intercepts, delegates downstream, does NOT set a result
    const cleanupA400 = busA.on(
      CursorSubjects.compute,
      async (ctx) => {
        executionOrder.push('busA-400');
        await ctx.next();
      },
      { priority: 400 },
    );

    // busA:100 — terminal handler on the originating bus
    const cleanupA100 = busA.on(
      CursorSubjects.compute,
      (ctx) => {
        executionOrder.push('busA-100');
        ctx.setResult({ result: 100, handledBy: 'busA-100' });
      },
      { priority: 100 },
    );

    // busB:300 — delegates to next() explicitly, exhausting its local chain.
    // When busB's dispatch finds no further entries below priority 300 it sends
    // back a NoHandlerError response, telling busA to continue from local:100.
    const cleanupB300 = busB.on(
      CursorSubjects.compute,
      async (ctx) => {
        executionOrder.push('busB-300');
        // Calling next() here advances to busB's own dispatch chain. Since there
        // are no further handlers on busB below the cursor, the registry replies
        // with NoHandlerError, triggering busA to advance to its local:100.
        await ctx.next();
      },
      { priority: 300 },
    );

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    // busA knows about busB's handler at priority 300.
    // sideA is the transport registered on busA; its name matches the key.
    busA.getContext().remoteRequestHandlers.set('cursorE2e.compute', [{ transport: sideA.name, priority: 300 }]);

    try {
      const result = await busA.request(CursorSubjects.compute, { value: 5 });

      // NoHandlerError from the remote registry must fall through to local:100.
      expect(executionOrder).toEqual(['busA-400', 'busB-300', 'busA-100']);
      expect(result.handledBy).toBe('busA-100');
      expect(result.result).toBe(100);
    } finally {
      busA.disconnect();
      busB.disconnect();
      cleanupA400();
      cleanupA100();
      cleanupB300();
    }
  });

  it('throws NoHandlerError when remote chain exhausts and no local fallback exists', async () => {
    const { sideA, sideB } = createBidirectionalTransportPair({ label: 'g-nofallback' });

    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });

    registerCursorNamespace(busA, busB);

    // busB has a handler that delegates, exhausting its chain
    const cleanupB300 = busB.on(
      CursorSubjects.compute,
      async (ctx) => {
        await ctx.next();
      },
      { priority: 300 },
    );

    busA.registerTransport(sideA);
    busB.registerTransport(sideB);

    busA.getContext().remoteRequestHandlers.set('cursorE2e.compute', [{ transport: sideA.name, priority: 300 }]);

    try {
      // No local fallback on busA — must throw NoHandlerError
      await expect(busA.request(CursorSubjects.compute, { value: 5 })).rejects.toBeInstanceOf(NoHandlerError);
    } finally {
      busA.disconnect();
      busB.disconnect();
      cleanupB300();
    }
  });
});
