/**
 * Unit tests for the dispatch readiness gate.
 *
 * The gate makes dispatch internally aware of transport readiness: when
 * pending `ready` promises exist on registered transports, dispatch awaits
 * them and rebuilds the remote entry list before deciding whether a handler
 * is available. This eliminates the need for manual `await registration.ready`
 * at every bootstrap call site.
 *
 * All tests use the MakaioBus singleton to exercise the full `request()` →
 * `dispatch()` call path. Transports are registered via the context's
 * transport registry and cleaned up in afterEach to prevent bleed between
 * tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import {
  MakaioBus,
  NoHandlerError,
  TimeoutError,
  localSubject,
  type BusMessage,
  type BusTransport,
  type BusTransportRegistry,
} from '../index.js';

// ---------------------------------------------------------------------------
// Namespace registrations — done once at module level so the augmented
// BusSubjectsNamespace is available for all tests in this file.
// ---------------------------------------------------------------------------

const GateNamespace = MakaioBus.registerNamespace(
  createBusNamespace('readinessGate', {
    ping: {
      request: z.object({ id: z.string() }),
      response: z.object({ pong: z.boolean() }),
    },
    localOnlyPing: localSubject({
      request: z.object({ id: z.string() }),
      response: z.object({ pong: z.boolean() }),
    }),
  }),
).subjects;

declare module '../index.js' {
  interface BusSubjectsNamespace {
    readinessGate: typeof GateNamespace;
  }
}

// ---------------------------------------------------------------------------
// Deferred promise helper
// ---------------------------------------------------------------------------

/**
 * A promise whose resolution is externally controlled.
 */
interface Deferred<T = void> {
  /** Settle this deferred. */
  resolve: (value: T) => void;
  /** Reject this deferred. */
  reject: (reason?: unknown) => void;
  /** The underlying promise. */
  promise: Promise<T>;
}

/**
 * Create a deferred promise whose resolution is externally controlled.
 * @returns A deferred object with `promise`, `resolve`, and `reject`
 */
function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Stub transport builder
// ---------------------------------------------------------------------------

/**
 * Options for {@link createReadinessTransport}.
 */
interface ReadinessTransportOptions {
  /** Transport name for registry key. */
  name: string;
  /**
   * Optional `ready` promise — controls whether the transport is tracked in
   * the pending-ready map.
   */
  ready?: Promise<void>;
  /**
   * Response to return for `request` type messages.
   * Defaults to `{ pong: true }`.
   */
  requestResponse?: unknown;
  /**
   * When set, `request` messages reject with this error instead of responding,
   * modelling a peer whose own chain is exhausted.
   */
  requestError?: Error;
  /**
   * When set, only the FIRST `request` message rejects with this error. Models a
   * transport whose learned route survived a disconnect: the first send fails at the
   * connection, a later send on the recovered session succeeds.
   */
  firstRequestError?: Error;
}

/**
 * Build a minimal BusTransport stub for readiness gate tests.
 *
 * The `send` spy captures request messages and returns `requestResponse`.
 * @param options - Transport configuration
 * @returns The transport and its `send` spy
 */
function createReadinessTransport(options: ReadinessTransportOptions): {
  transport: BusTransport;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  const { name, ready, requestResponse = { pong: true }, requestError, firstRequestError } = options;

  let requestCount = 0;
  const sendSpy = vi.fn(async (message: BusMessage): Promise<unknown> => {
    if (message.type === 'request') {
      requestCount += 1;
      if (firstRequestError && requestCount === 1) throw firstRequestError;
      if (requestError) throw requestError;
      return requestResponse;
    }
    return true;
  });

  const transport: BusTransport = {
    name,
    send: sendSpy as BusTransport['send'],
    onReceive: vi.fn((_handler: (msg: BusMessage) => Promise<void>) => () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
  };

  if (ready !== undefined) {
    transport.ready = ready;
  }

  return { transport, sendSpy };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Register a transport with the bus and push the registration handle to
 * the shared `registrations` array for cleanup in `afterEach`.
 * @param ns - Transport registry key (cast from string)
 * @param transport - The transport stub to register
 * @param registrations - The shared cleanup array
 */
function addTransport(ns: string, transport: BusTransport, registrations: Array<{ unregister: () => void }>): void {
  registrations.push(
    MakaioBus.getContext().transportRegistry.registerTransport(ns as keyof BusTransportRegistry, transport),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Filter a send spy's calls to only request-type messages, excluding
 * subscribe messages from `syncAllSubjectsToTransport`.
 * @param sendSpy - The transport send spy to filter
 * @returns Only the calls where the message type is `'request'`
 */
function getRequestCalls(sendSpy: ReturnType<typeof vi.fn>): unknown[][] {
  return sendSpy.mock.calls.filter(([msg]) => (msg as BusMessage).type === 'request');
}

describe('Dispatch readiness gate', () => {
  // Track registrations and timers for cleanup.
  const registrations: Array<{ unregister: () => void }> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.length = 0;
    for (const reg of registrations) {
      reg.unregister();
    }
    registrations.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: local handler exists, no pending transports — fast path taken
  // -------------------------------------------------------------------------

  it('resolves immediately via local handler when no pending transports exist', async () => {
    // No transport is registered: getPendingReady() returns [], so the gate
    // block is never entered and the local handler result is returned directly.
    const cleanup = MakaioBus.on(GateNamespace.ping, (ctx) => {
      ctx.setResult({ pong: true });
    });

    try {
      const result = await MakaioBus.request(GateNamespace.ping, { id: 'local-handler' }, { timeout: 2000 });
      expect(result).toEqual({ pong: true });
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 2: remote handler pre-seeded, pending ready already resolved
  // -------------------------------------------------------------------------

  it('routes to a pre-seeded remote handler after gate await resolves', async () => {
    const deferred = createDeferred();
    const { transport, sendSpy } = createReadinessTransport({
      name: 'gate-s2',
      ready: deferred.promise,
    });
    addTransport('gate-s2', transport, registrations);

    // Seed remoteRequestHandlers before dispatch runs — simulates a transport
    // that completed subscribe-sync before the first request is made.
    MakaioBus.getContext().remoteRequestHandlers.set('readinessGate.ping', [{ transport: 'gate-s2', priority: 0 }]);

    // With no local handler the pre-seeded remote entry is the whole chain. Resolve
    // ready so the gate's retry finds it instead of reporting NoHandlerError.
    deferred.resolve();

    const result = await MakaioBus.request(GateNamespace.ping, { id: 'remote-pre-seeded' }, { timeout: 2000 });

    expect(result).toEqual({ pong: true });
    expect(getRequestCalls(sendSpy)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: no handlers + no pending transports → NoHandlerError immediately
  // -------------------------------------------------------------------------

  it('throws NoHandlerError immediately when no handlers and no pending transports exist', async () => {
    // No transport registered, no handlers — gate has nothing to await.
    await expect(
      MakaioBus.request(GateNamespace.ping, { id: 'no-handler-no-pending' }, { timeout: 2000 }),
    ).rejects.toThrow(NoHandlerError);
  });

  // -------------------------------------------------------------------------
  // Scenario 4: no handlers + pending → ready resolves, handler becomes available
  // -------------------------------------------------------------------------

  it('succeeds after gate await when ready resolves and remote handler becomes available', async () => {
    const deferred = createDeferred();
    const { transport, sendSpy } = createReadinessTransport({
      name: 'gate-s4',
      ready: deferred.promise,
    });
    addTransport('gate-s4', transport, registrations);

    // Simulate subscribe-sync completing while dispatch is waiting:
    // resolve ready AND seed remoteRequestHandlers before the await settles.
    // The setTimeout callbacks across scenarios are intentionally kept inline
    // rather than extracted into a helper — each callback's side-effects differ
    // (seed handlers, resolve 1-or-2 deferreds, unregister transport) and a
    // shared helper would obscure the per-scenario intent.
    // setTimeout is intentional: dispatch must already be suspended inside
    // Promise.allSettled before the deferred resolves, so the gate observes
    // the pending state. A microtask (queueMicrotask / Promise.resolve) would
    // run before request() reaches the await and would miss the gate entirely.
    timers.push(
      setTimeout(() => {
        MakaioBus.getContext().remoteRequestHandlers.set('readinessGate.ping', [{ transport: 'gate-s4', priority: 0 }]);
        deferred.resolve();
      }, 5),
    );

    const result = await MakaioBus.request(GateNamespace.ping, { id: 'pending-then-handler' }, { timeout: 2000 });

    expect(result).toEqual({ pong: true });
    expect(getRequestCalls(sendSpy)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 5: no handlers + pending → ready resolves, still no handler
  // -------------------------------------------------------------------------

  it('throws NoHandlerError after gate await when retry still finds no handler', async () => {
    const deferred = createDeferred();
    const { transport } = createReadinessTransport({
      name: 'gate-s5',
      ready: deferred.promise,
    });
    addTransport('gate-s5', transport, registrations);

    // Resolve ready but do NOT seed remoteRequestHandlers.
    // setTimeout is intentional: see Scenario 4 comment — dispatch must
    // already be suspended in Promise.allSettled before the deferred resolves.
    timers.push(
      setTimeout(() => {
        deferred.resolve();
      }, 5),
    );

    await expect(
      MakaioBus.request(GateNamespace.ping, { id: 'pending-no-handler' }, { timeout: 2000 }),
    ).rejects.toThrow(NoHandlerError);
  });

  // -------------------------------------------------------------------------
  // Scenario 6: transports: [] → localOnly flag → gate is skipped
  // -------------------------------------------------------------------------

  it('skips the gate and throws NoHandlerError immediately when transports: [] is passed', async () => {
    const deferred = createDeferred();
    const { transport } = createReadinessTransport({
      name: 'gate-s6',
      ready: deferred.promise,
    });
    addTransport('gate-s6', transport, registrations);

    // transports: [] sets localOnly = true in request.ts, bypassing the gate.
    // This must not hang even though deferred.promise never resolves here.
    await expect(
      MakaioBus.request(GateNamespace.ping, { id: 'local-only-transports' }, { timeout: 2000, transports: [] }),
    ).rejects.toThrow(NoHandlerError);

    // Clean up the dangling deferred to avoid unhandled-promise-rejection noise.
    deferred.resolve();
  });

  // -------------------------------------------------------------------------
  // Scenario 6b: $meta.local subject → gate is skipped
  // -------------------------------------------------------------------------

  it('skips the gate for $meta.local subjects even with pending transports', async () => {
    const deferred = createDeferred();
    const { transport } = createReadinessTransport({
      name: 'gate-s6b',
      ready: deferred.promise,
    });
    addTransport('gate-s6b', transport, registrations);

    // $meta.local subjects are never dispatched remotely; the gate must not
    // be entered at all.
    await expect(
      MakaioBus.request(GateNamespace.localOnlyPing, { id: 'local-subject-gate' }, { timeout: 2000 }),
    ).rejects.toThrow(NoHandlerError);

    deferred.resolve();
  });

  // -------------------------------------------------------------------------
  // Scenario 7: multiple pending transports → allSettled, single retry
  // -------------------------------------------------------------------------

  it('awaits all pending transports via allSettled then succeeds on single retry', async () => {
    const deferredA = createDeferred();
    const deferredB = createDeferred();

    const { transport: transportA } = createReadinessTransport({
      name: 'gate-s7a',
      ready: deferredA.promise,
    });
    const { transport: transportB, sendSpy: sendSpyB } = createReadinessTransport({
      name: 'gate-s7b',
      ready: deferredB.promise,
    });

    addTransport('gate-s7a', transportA, registrations);
    addTransport('gate-s7b', transportB, registrations);

    // Stagger the resolutions to prove allSettled waits for both transports.
    // Resolving deferredA first (without seeding handlers) ensures dispatch
    // does not retry prematurely after only one transport is ready.
    // setTimeout is intentional: see Scenario 4 comment — dispatch must
    // already be suspended in Promise.allSettled before the deferreds resolve.
    timers.push(
      setTimeout(() => {
        // First transport becomes ready — no handler seeded yet.
        deferredA.resolve();
      }, 5),
    );
    timers.push(
      setTimeout(() => {
        // Second transport becomes ready AND handler is seeded — only now
        // should dispatch retry and find the remote handler.
        MakaioBus.getContext().remoteRequestHandlers.set('readinessGate.ping', [
          { transport: 'gate-s7b', priority: 0 },
        ]);
        deferredB.resolve();
      }, 10),
    );

    const result = await MakaioBus.request(GateNamespace.ping, { id: 'multi-pending' }, { timeout: 2000 });

    expect(result).toEqual({ pong: true });
    expect(getRequestCalls(sendSpyB)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 8: transport unregistered during wait → NoHandlerError, registry clean
  // -------------------------------------------------------------------------

  it('throws NoHandlerError when transport unregisters while dispatch awaits ready', async () => {
    const deferred = createDeferred();
    const { transport } = createReadinessTransport({
      name: 'gate-s8',
      ready: deferred.promise,
    });
    addTransport('gate-s8', transport, registrations);
    // Keep a direct reference to the last-pushed handle so we can unregister
    // it inside the setTimeout and remove it from the cleanup array.
    const reg = registrations[registrations.length - 1];

    // Unregister the transport and resolve ready while dispatch is waiting.
    // setTimeout is intentional: see Scenario 4 comment — dispatch must
    // already be suspended in Promise.allSettled before the deferred resolves.
    timers.push(
      setTimeout(() => {
        reg.unregister();
        // Remove from the cleanup array immediately so afterEach won't
        // double-unregister if an assertion fails after the timer fires.
        const idx = registrations.indexOf(reg);
        if (idx !== -1) registrations.splice(idx, 1);
        deferred.resolve();
      }, 5),
    );

    await expect(
      MakaioBus.request(GateNamespace.ping, { id: 'unregister-during-wait' }, { timeout: 2000 }),
    ).rejects.toThrow(NoHandlerError);

    // Registry must be empty after unregister.
    expect(MakaioBus.getContext().transportRegistry.names()).not.toContain('gate-s8');
  });

  // -------------------------------------------------------------------------
  // Scenario 9: never-settling ready → the wait expires on its own budget and
  // dispatch proceeds with the routes advertised so far, rather than on the
  // caller's request timeout
  // -------------------------------------------------------------------------

  it('proceeds on the readiness budget when ready never settles', async () => {
    // The ready promise never resolves — exercises the readiness-budget expiry
    // path in dispatch that Scenarios 2–8 never reach.
    const { transport, sendSpy } = createReadinessTransport({
      name: 'gate-s9',
      ready: new Promise<void>(() => {}), // never settles
    });
    addTransport('gate-s9', transport, registrations);

    const started = Date.now();
    // NoHandlerError, not TimeoutError: the budget expires, dispatch rebuilds the
    // merged list, finds nothing, and reports honestly. A readiness hint must
    // never fail a request, and must never consume the caller's request budget.
    await expect(
      MakaioBus.request(GateNamespace.ping, { id: 'never-settling' }, { timeout: 5000, readinessTimeout: 50 }),
    ).rejects.toThrow(NoHandlerError);
    const elapsed = Date.now() - started;

    // Bounded by readinessTimeout, nowhere near the 5 s request timeout.
    expect(elapsed).toBeLessThan(1000);

    // No request should have been sent since no route was ever advertised.
    expect(getRequestCalls(sendSpy)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 9b: the readiness budget defaults independently of the caller's
  // request timeout — `timeout: 0` no longer means an unbounded gate
  // -------------------------------------------------------------------------

  it('bounds the gate by its own budget even when the caller disables the request timeout', async () => {
    const { transport } = createReadinessTransport({
      name: 'gate-s9b',
      ready: new Promise<void>(() => {}), // never settles
    });
    addTransport('gate-s9b', transport, registrations);

    // timeout: 0 disables the request deadline entirely. Before the readiness
    // budget existed this hung forever; now the gate expires and dispatch reports.
    await expect(
      MakaioBus.request(GateNamespace.ping, { id: 'no-request-timeout' }, { timeout: 0, readinessTimeout: 50 }),
    ).rejects.toThrow(NoHandlerError);
  });

  // -------------------------------------------------------------------------
  // Scenario 9g: an invalid readiness budget is refused at the request seam
  // -------------------------------------------------------------------------

  it('rejects a non-finite or negative readinessTimeout with a RangeError', async () => {
    await expect(
      MakaioBus.request(GateNamespace.ping, { id: 'negative-budget' }, { timeout: 2000, readinessTimeout: -1 }),
    ).rejects.toThrow(RangeError);

    await expect(
      MakaioBus.request(GateNamespace.ping, { id: 'nan-budget' }, { timeout: 2000, readinessTimeout: Number.NaN }),
    ).rejects.toThrow(RangeError);

    await expect(
      MakaioBus.request(
        GateNamespace.ping,
        { id: 'infinite-budget' },
        { timeout: 2000, readinessTimeout: Number.POSITIVE_INFINITY },
      ),
    ).rejects.toThrow(RangeError);
  });

  // -------------------------------------------------------------------------
  // Scenario 9j: the readiness wait is bounded by the request deadline, and no
  // retry runs after it — dispatch is not cancellable by the caller's p-timeout
  // -------------------------------------------------------------------------

  it('abandons the readiness wait and the retry once the request deadline has passed', async () => {
    const { transport, sendSpy } = createReadinessTransport({
      name: 'gate-s9j',
      ready: new Promise<void>(() => {}), // never settles
    });
    addTransport('gate-s9j', transport, registrations);

    let lateHandlerCalls = 0;
    let cleanup: (() => void) | undefined;
    try {
      // Registered well after the 200 ms deadline. If the gate kept waiting on its
      // configured 5 s budget it would rebuild the list here and invoke this handler
      // after the caller was already rejected.
      timers.push(
        setTimeout(() => {
          cleanup = MakaioBus.on(GateNamespace.ping, (ctx) => {
            lateHandlerCalls += 1;
            ctx.setResult({ pong: true });
          });
        }, 300),
      );

      const started = Date.now();
      await expect(
        MakaioBus.request(GateNamespace.ping, { id: 'deadline-bound' }, { timeout: 200, readinessTimeout: 5000 }),
      ).rejects.toThrow(TimeoutError);
      expect(Date.now() - started).toBeLessThan(1000);

      // Outlive the late registration and confirm nothing ran after the deadline.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(lateHandlerCalls).toBe(0);
      expect(getRequestCalls(sendSpy)).toHaveLength(0);
    } finally {
      cleanup?.();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 9q: a wrapper must see a downstream transport failure, and must not
  // be able to suppress it by setting its own result afterwards
  // -------------------------------------------------------------------------

  it('rejects ctx.next() on a downstream transport failure so a wrapper can compensate', async () => {
    const transportFailure = new Error('gate-s9q exploded');
    const { transport } = createReadinessTransport({ name: 'gate-s9q', requestError: transportFailure });
    addTransport('gate-s9q', transport, registrations);

    MakaioBus.getContext().remoteRequestHandlers.set('readinessGate.ping', [{ transport: 'gate-s9q', priority: 0 }]);

    let compensated = false;
    const cleanup = MakaioBus.on(
      GateNamespace.ping,
      async (ctx) => {
        try {
          await ctx.next();
        } catch {
          compensated = true;
          // Suppression attempt: the wrapper swallows the failure and answers anyway.
          ctx.setResult({ pong: true });
        }
      },
      { priority: 100 },
    );

    try {
      // The rollback ran, and the failure still reaches the caller.
      await expect(
        MakaioBus.request(GateNamespace.ping, { id: 'wrapper-compensates' }, { timeout: 2000 }),
      ).rejects.toThrow('gate-s9q exploded');
      expect(compensated).toBe(true);
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 9s: the deadline is enforced at every chain advancement, not once
  // per pass — a slow handler must not be able to start the next one's work
  // -------------------------------------------------------------------------

  it('does not advance the chain to a later handler once the deadline has passed', async () => {
    let laterHandlerRuns = 0;
    const slow = MakaioBus.on(
      GateNamespace.ping,
      async (ctx) => {
        // Overruns the caller's deadline, then tries to advance anyway.
        await new Promise((resolve) => setTimeout(resolve, 120));
        await ctx.next();
      },
      { priority: 100 },
    );
    const later = MakaioBus.on(GateNamespace.ping, (ctx) => {
      laterHandlerRuns += 1;
      ctx.setResult({ pong: true });
    });

    try {
      await expect(
        MakaioBus.request(GateNamespace.ping, { id: 'deadline-mid-chain' }, { timeout: 40 }),
      ).rejects.toThrow(TimeoutError);

      // Give the overrunning handler time to finish and attempt its next().
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(laterHandlerRuns).toBe(0);
    } finally {
      slow();
      later();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 9d: an explicit transport allowlist keeps the gate armed even when
  // a local handler is reachable — the caller pinned routing to that peer
  // -------------------------------------------------------------------------

  it('keeps the gate armed for an explicit transport allowlist despite a local handler', async () => {
    const deferred = createDeferred();
    const { transport, sendSpy } = createReadinessTransport({
      name: 'gate-s9d',
      ready: deferred.promise,
    });
    addTransport('gate-s9d', transport, registrations);

    // A local handler exists but must not short-circuit the pinned transport.
    let localHandlerCalls = 0;
    const cleanup = MakaioBus.on(GateNamespace.ping, (ctx) => {
      localHandlerCalls += 1;
      ctx.setResult({ pong: false });
    });

    try {
      // setTimeout is intentional: see Scenario 4 comment — dispatch must already
      // be suspended in the gate before the deferred resolves.
      timers.push(
        setTimeout(() => {
          MakaioBus.getContext().remoteRequestHandlers.set('readinessGate.ping', [
            { transport: 'gate-s9d', priority: 10 },
          ]);
          deferred.resolve();
        }, 5),
      );

      const result = await MakaioBus.request(
        GateNamespace.ping,
        { id: 'allowlist-pinned' },
        { timeout: 2000, transports: ['gate-s9d' as keyof BusTransportRegistry] },
      );

      // The pinned transport's higher-priority route ran first, so the gate did
      // wait for it rather than letting the local handler answer.
      expect(result).toEqual({ pong: true });
      expect(getRequestCalls(sendSpy)).toHaveLength(1);
      expect(localHandlerCalls).toBe(0);
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 10: one transport rejects ready, another resolves → allSettled retries
  // -------------------------------------------------------------------------

  it('retries dispatch after allSettled even when one transport rejects its ready promise', async () => {
    const deferredGood = createDeferred();
    const deferredBad = createDeferred();

    const { transport: transportBad } = createReadinessTransport({
      name: 'gate-s10-bad',
      ready: deferredBad.promise,
    });
    const { transport: transportGood, sendSpy: sendSpyGood } = createReadinessTransport({
      name: 'gate-s10-good',
      ready: deferredGood.promise,
    });

    addTransport('gate-s10-bad', transportBad, registrations);
    addTransport('gate-s10-good', transportGood, registrations);

    // Stagger: reject the first transport, then resolve the second with a handler.
    // Promise.all would short-circuit on the rejection; Promise.allSettled waits.
    timers.push(
      setTimeout(() => {
        deferredBad.reject(new Error('Transport failed'));
      }, 5),
    );
    timers.push(
      setTimeout(() => {
        MakaioBus.getContext().remoteRequestHandlers.set('readinessGate.ping', [
          { transport: 'gate-s10-good', priority: 0 },
        ]);
        deferredGood.resolve();
      }, 10),
    );

    const result = await MakaioBus.request(GateNamespace.ping, { id: 'one-rejects' }, { timeout: 2000 });

    expect(result).toEqual({ pong: true });
    expect(getRequestCalls(sendSpyGood)).toHaveLength(1);
  });
});
