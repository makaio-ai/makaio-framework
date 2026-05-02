/**
 * Tests for the bus.connect() lifecycle.
 *
 * Covers: transport invocation, ready-wait behaviour, rollback on failure,
 * and partial-connect failure semantics.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BusMessage, BusTransport } from '../index.js';
import { createBusInstance, createBusContext } from '../bus.js';

// ---------------------------------------------------------------------------
// Minimal connect-capable transport stub
// ---------------------------------------------------------------------------

/**
 * Options for {@link createConnectableTransport}.
 */
interface ConnectableTransportOptions {
  /** Transport name. Defaults to `'stub'`. */
  name?: string;
  /**
   * When set, `connect()` will reject with this error.
   * Defaults to a resolving no-op.
   */
  connectError?: Error;
  /**
   * Optional `ready` promise attached to the transport.
   * When omitted the transport has no `ready` property (considered immediately ready).
   */
  ready?: Promise<void>;
}

/**
 * A {@link BusTransport} with spy references for its lifecycle methods.
 *
 * Spy properties are kept alongside the transport so tests can assert on
 * call counts without relying on method-level casting in the interface.
 */
interface ConnectableTransport {
  /** The transport object to pass to `bus.registerTransport()`. */
  transport: BusTransport;
  /** Spy for `transport.connect`. */
  connectSpy: ReturnType<typeof vi.fn>;
  /** Spy for `transport.disconnect`. */
  disconnectSpy: ReturnType<typeof vi.fn>;
}

/**
 * Create a minimal transport stub for bus.connect() lifecycle tests.
 *
 * All lifecycle methods are `vi.fn()` spies exposed via the returned
 * `ConnectableTransport` holder. `send` and `onReceive` are cast to their
 * `BusTransport` types using the same technique as `createStubTransport` in
 * `helpers/transport-fixtures.ts` to satisfy the conditional generic overload.
 * @param options - Configuration overrides
 * @returns Holder with the transport and its lifecycle spies
 */
function createConnectableTransport(options: ConnectableTransportOptions = {}): ConnectableTransport {
  const { name = 'stub', connectError, ready } = options;

  const connectSpy = vi.fn(async () => {
    if (connectError) throw connectError;
  });
  const disconnectSpy = vi.fn(async () => {});

  const transport: BusTransport = {
    name,
    connect: connectSpy,
    disconnect: disconnectSpy,
    // Cast required: vi.fn() cannot satisfy the conditional generic overload.
    // Same technique used by createStubTransport in helpers/transport-fixtures.ts.
    send: vi.fn(async (_message: BusMessage) => true) as BusTransport['send'],
    onReceive: vi.fn((_handler: (message: BusMessage) => Promise<void>) => () => {}) as BusTransport['onReceive'],
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
  };

  if (ready !== undefined) {
    transport.ready = ready;
  }

  return { transport, connectSpy, disconnectSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bus.connect()', () => {
  let bus: ReturnType<typeof createBusInstance>;

  beforeEach(() => {
    // Each test gets an isolated bus so transports registered in one test
    // cannot bleed into another.
    bus = createBusInstance({ context: createBusContext() });
  });

  afterEach(() => {
    bus.disconnect();
  });

  it('resolves immediately when no transports are registered', async () => {
    await expect(bus.connect()).resolves.toBeUndefined();
  });

  it('calls connect() on all registered transports', async () => {
    const a = createConnectableTransport({ name: 'a' });
    const b = createConnectableTransport({ name: 'b' });
    bus.registerTransport(a.transport);
    bus.registerTransport(b.transport);

    await bus.connect();

    expect(a.connectSpy).toHaveBeenCalledOnce();
    expect(b.connectSpy).toHaveBeenCalledOnce();
  });

  it('awaits ready by default', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const { transport } = createConnectableTransport({ name: 'a', ready });
    bus.registerTransport(transport);

    let settled = false;
    const connectPromise = bus.connect().then(() => {
      settled = true;
    });

    // Flush microtasks — connect() is pending because ready has not resolved.
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveReady();
    await connectPromise;
    expect(settled).toBe(true);
  });

  it('bus.ready stays pending while transport.connect() is still in flight', async () => {
    let releaseConnect!: () => void;
    const { transport } = createConnectableTransport({ name: 'a', ready: Promise.resolve() });
    transport.connect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        }),
    );
    bus.registerTransport(transport);

    const connectPromise = bus.connect({ awaitReady: false });

    const SENTINEL = 'sentinel' as const;
    const sentinel = new Promise<typeof SENTINEL>((resolve) => setTimeout(resolve, 10, SENTINEL));
    const raceBeforeConnect = await Promise.race([bus.ready.then(() => 'ready' as const), sentinel]);
    expect(raceBeforeConnect).toBe(SENTINEL);

    releaseConnect();
    await connectPromise;
    await expect(bus.ready).resolves.toBeUndefined();
  });

  it('awaits the current ready promise, not the registration snapshot', async () => {
    // Simulates WebSocketClientTransport behavior: connect() resolves the old
    // ready promise and replaces it with a fresh one for the new session.
    let resolveInitialReady!: () => void;
    const initialReady = new Promise<void>((resolve) => {
      resolveInitialReady = resolve;
    });

    let resolveSessionReady!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      resolveSessionReady = resolve;
    });

    const { transport, connectSpy } = createConnectableTransport({ name: 'a', ready: initialReady });

    // connect() resolves the old ready and swaps in the new session ready.
    connectSpy.mockImplementation(async () => {
      resolveInitialReady();
      transport.ready = sessionReady;
    });

    bus.registerTransport(transport);

    let settled = false;
    const connectPromise = bus.connect().then(() => {
      settled = true;
    });

    // Flush microtasks — if bus.connect() awaited the stale initialReady
    // (already resolved by connect()), it would have settled by now.
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    // Resolve the new session ready and verify bus.connect() completes.
    resolveSessionReady();
    await connectPromise;
    expect(settled).toBe(true);
  });

  it('skips ready wait with awaitReady: false', async () => {
    // ready is a promise that never resolves — if awaitReady were true,
    // this test would hang.
    const ready = new Promise<void>(() => {});

    const { transport, connectSpy } = createConnectableTransport({ name: 'a', ready });
    bus.registerTransport(transport);

    // Must resolve without waiting for ready.
    await expect(bus.connect({ awaitReady: false })).resolves.toBeUndefined();
    expect(connectSpy).toHaveBeenCalledOnce();
  });

  it('rolls back all transports when one fails to connect', async () => {
    const error = new Error('connect failed');
    const a = createConnectableTransport({ name: 'a' });
    const b = createConnectableTransport({ name: 'b', connectError: error });
    bus.registerTransport(a.transport);
    bus.registerTransport(b.transport);

    let thrown: unknown;
    try {
      await bus.connect();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const wrapped = thrown as Error & { cause?: unknown };
    expect(wrapped.message).toBe('Failed to connect transport "b": connect failed');
    expect(wrapped.cause).toBe(error);

    // Both transports must have been disconnected as part of rollback.
    expect(a.disconnectSpy).toHaveBeenCalled();
    expect(b.disconnectSpy).toHaveBeenCalled();

    // After rollback the bus must have unregistered both transports.
    // Verify via the context's transport registry (names() returns remaining transports).
    const remaining = bus.getContext().transportRegistry.names();
    expect(remaining).toHaveLength(0);
  });

  it('partial connect failure: all transports are rolled back including those after the failing one', async () => {
    const error = new Error('B connect failed');

    // A connects successfully. B fails. C's connect() IS called (Promise.all
    // maps synchronously — all connect() calls are dispatched before any
    // awaiting, so short-circuit rejection does not prevent C from being invoked).
    // The rollback path calls disconnect() on ALL entries via Promise.allSettled.
    const a = createConnectableTransport({ name: 'a' });
    const b = createConnectableTransport({ name: 'b', connectError: error });
    const c = createConnectableTransport({ name: 'c' });
    bus.registerTransport(a.transport);
    bus.registerTransport(b.transport);
    bus.registerTransport(c.transport);

    let thrown: unknown;
    try {
      await bus.connect();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const wrapped = thrown as Error & { cause?: unknown };
    expect(wrapped.message).toBe('Failed to connect transport "b": B connect failed');
    expect(wrapped.cause).toBe(error);

    // All three transports had connect() dispatched (map is synchronous).
    expect(a.connectSpy).toHaveBeenCalledOnce();
    expect(b.connectSpy).toHaveBeenCalledOnce();
    expect(c.connectSpy).toHaveBeenCalledOnce();

    // All three are disconnected best-effort during rollback.
    expect(a.disconnectSpy).toHaveBeenCalled();
    expect(b.disconnectSpy).toHaveBeenCalled();
    expect(c.disconnectSpy).toHaveBeenCalled();

    // Registry must be empty after rollback.
    const remaining = bus.getContext().transportRegistry.names();
    expect(remaining).toHaveLength(0);
  });

  it('second connect() is a no-op when already connected', async () => {
    const { transport, connectSpy } = createConnectableTransport({ name: 't1' });
    bus.registerTransport(transport);
    await bus.connect();

    // Second connect should be a no-op — the connected guard returns early.
    await bus.connect();

    // connect() was only called once on the transport.
    expect(connectSpy).toHaveBeenCalledOnce();
  });

  it('concurrent connect() calls share the same in-flight connection attempt', async () => {
    let releaseConnect!: () => void;
    const { transport, connectSpy } = createConnectableTransport({ name: 't1' });
    connectSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        }),
    );
    bus.registerTransport(transport);

    const firstConnect = bus.connect();
    const secondConnect = bus.connect();

    expect(connectSpy).toHaveBeenCalledOnce();

    releaseConnect();
    await Promise.all([firstConnect, secondConnect]);

    expect(connectSpy).toHaveBeenCalledOnce();
  });

  it('bus.ready resolves immediately when no transports are registered', async () => {
    await expect(bus.ready).resolves.toBeUndefined();
  });

  it('bus.ready resolves after connect() with default awaitReady', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const { transport } = createConnectableTransport({ name: 'a', ready });
    bus.registerTransport(transport);

    // Resolve ready before connect() so connect() settles with bus.ready already fulfilled.
    resolveReady();
    await bus.connect();

    // bus.ready must be resolved — awaiting it should settle immediately.
    await expect(bus.ready).resolves.toBeUndefined();
  });

  it('bus.ready resolves after connect({awaitReady: false}) once transports become ready', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const { transport } = createConnectableTransport({ name: 'a', ready });
    bus.registerTransport(transport);

    // connect() returns immediately — sockets open, ready not yet resolved.
    await bus.connect({ awaitReady: false });

    // bus.ready must still be pending — race it against a macrotask sentinel.
    // If bus.ready had already resolved, 'ready' would win; otherwise 'sentinel' wins.
    const SENTINEL = 'sentinel' as const;
    const sentinel = new Promise<typeof SENTINEL>((r) => setTimeout(r, 10, SENTINEL));
    const raceBeforeResolve = await Promise.race([bus.ready.then(() => 'ready' as const), sentinel]);
    expect(raceBeforeResolve).toBe(SENTINEL);

    // Now the transport signals readiness — bus.ready must resolve.
    resolveReady();
    await expect(bus.ready).resolves.toBeUndefined();
  });

  it('later default connect() waits for an in-flight ready handshake started with awaitReady:false', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const { transport } = createConnectableTransport({ name: 'a', ready });
    bus.registerTransport(transport);

    await bus.connect({ awaitReady: false });

    let settled = false;
    const connectPromise = bus.connect().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveReady();
    await connectPromise;
    expect(settled).toBe(true);
  });

  it('disconnect() during connect() does not let the stale attempt mark the bus connected', async () => {
    let releaseConnect!: () => void;
    const { transport, connectSpy, disconnectSpy } = createConnectableTransport({
      name: 'a',
      ready: Promise.resolve(),
    });
    connectSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        }),
    );
    bus.registerTransport(transport);

    const inFlightConnect = bus.connect({ awaitReady: false });
    bus.disconnect();
    releaseConnect();

    await expect(inFlightConnect).resolves.toBeUndefined();
    expect(disconnectSpy).toHaveBeenCalled();

    const lateTransport = createConnectableTransport({ name: 'b' });
    bus.registerTransport(lateTransport.transport);
    await bus.connect();
    expect(lateTransport.connectSpy).toHaveBeenCalledOnce();
  });

  it('disconnect() cancels an in-flight ready handshake so connect() and bus.ready settle', async () => {
    const { transport, disconnectSpy } = createConnectableTransport({
      name: 'a',
      ready: new Promise<void>(() => {}),
    });
    bus.registerTransport(transport);

    const connectPromise = bus.connect();
    const busReadyPromise = bus.ready;

    await Promise.resolve();
    bus.disconnect();

    await expect(connectPromise).resolves.toBeUndefined();
    await expect(busReadyPromise).resolves.toBeUndefined();
    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('disconnect() cancels a background ready handshake after connect({ awaitReady: false }) returns', async () => {
    const { transport, disconnectSpy } = createConnectableTransport({
      name: 'a',
      ready: new Promise<void>(() => {}),
    });
    bus.registerTransport(transport);

    await bus.connect({ awaitReady: false });

    const busReadyPromise = bus.ready;
    bus.disconnect();

    await expect(busReadyPromise).resolves.toBeUndefined();
    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('rejects registerTransport() after connect() has started', async () => {
    const { transport } = createConnectableTransport({ name: 'a' });
    const lateTransport = createConnectableTransport({ name: 'late' });
    bus.registerTransport(transport);

    await bus.connect();

    expect(() => bus.registerTransport(lateTransport.transport)).toThrow(
      "[bus.connect] Cannot register transport 'late' after connect() has started; create a new bus instance or use the shared transport registry directly",
    );
  });

  it('rejects registerTransport() while connect() is in flight (awaitReady:false)', async () => {
    // A transport whose connect() never resolves — connect() will remain
    // in-flight indefinitely, holding the lifecycle guard active.
    let releaseConnect!: () => void;
    const { transport } = createConnectableTransport({ name: 'a' });
    transport.connect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        }),
    );
    bus.registerTransport(transport);

    // Start connect() without awaiting — connectPromise is set but not yet settled,
    // so hasActiveTransportLifecycle() returns true.
    const connectPromise = bus.connect({ awaitReady: false });

    const lateTransport = createConnectableTransport({ name: 'late' });
    expect(() => bus.registerTransport(lateTransport.transport)).toThrow(
      "[bus.connect] Cannot register transport 'late' after connect() has started; create a new bus instance or use the shared transport registry directly",
    );

    // Clean up: release the in-flight connect so the bus can settle.
    releaseConnect();
    await connectPromise;
  });

  it('rejects when transport ready fails', async () => {
    const readyError = new Error('subscribe-sync timeout');
    // Transport connects successfully, but ready rejects (e.g. handshake timeout).
    const { transport, disconnectSpy } = createConnectableTransport({
      name: 'a',
      ready: Promise.reject(readyError),
    });
    bus.registerTransport(transport);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(bus.connect()).rejects.toThrow('subscribe-sync timeout');

      // The per-transport error must be logged before re-throwing.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[bus.connect] Transport 'a' ready failed:"),
        readyError,
      );

      // A failed ready handshake must leave no live registration behind.
      expect(disconnectSpy).toHaveBeenCalled();
      expect(bus.getContext().transportRegistry.names()).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('bus.ready resets to resolved after transport ready fails (R10)', async () => {
    const readyError = new Error('ready-rollback');
    const { transport } = createConnectableTransport({
      name: 'a',
      ready: Promise.reject(readyError),
    });
    bus.registerTransport(transport);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(bus.connect()).rejects.toThrow('ready-rollback');

      // After rollback bus.ready must fall back to Promise.resolve() — the
      // rejected readyPromise must have been cleared, not left in place.
      await expect(bus.ready).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('handles background rejection with awaitReady:false without unhandled rejection (R11)', async () => {
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((_, reject) => {
      rejectReady = reject;
    });

    const { transport, disconnectSpy } = createConnectableTransport({ name: 'a', ready });
    bus.registerTransport(transport);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // connect() returns immediately — ready is still pending.
      await expect(bus.connect({ awaitReady: false })).resolves.toBeUndefined();

      // Trigger background ready failure.
      const bgError = new Error('background-timeout');
      rejectReady(bgError);

      // Flush microtasks so the background .catch() handler runs.
      await new Promise<void>((r) => setTimeout(r, 10));

      // Background error must have been logged.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[bus.connect] Background ready failed:'), bgError);

      // Transport must have been disconnected and unregistered during rollback.
      expect(disconnectSpy).toHaveBeenCalled();
      expect(bus.getContext().transportRegistry.names()).toHaveLength(0);

      // bus.ready must have been reset to the resolved fallback.
      await expect(bus.ready).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
