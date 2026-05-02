/**
 * Unit tests for transport registry readiness tracking.
 *
 * `trackPendingReady` (internal to `createTransportRegistry`) populates a
 * `pendingReady` map when a registered transport carries a `ready` promise.
 * `getPendingReady()` exposes that map's values to dispatch.
 *
 * All tests use an isolated bus instance (via `createBusInstance` +
 * `createBusContext`) to avoid any coupling to the MakaioBus singleton and
 * to ensure clean state per test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BusMessage, BusTransport, BusTransportKeys } from '../index.js';
import { createBusInstance, createBusContext } from '../bus.js';

// ---------------------------------------------------------------------------
// Minimal transport stub factory
// ---------------------------------------------------------------------------

/**
 * Options for {@link createTrackingTransport}.
 */
interface TrackingTransportOptions {
  /** Transport name for the registry key. */
  name: string;
  /**
   * Optional `ready` promise.
   * When omitted, the transport has no `ready` property (considered
   * immediately ready — not tracked in `pendingReady`).
   */
  ready?: Promise<void>;
}

/**
 * Build a minimal BusTransport stub for registry readiness tracking tests.
 *
 * All lifecycle methods are no-ops; only the `name` and optional `ready`
 * property matter for the tracking tests.
 * @param options - Transport configuration
 * @returns A minimal BusTransport
 */
function createTrackingTransport(options: TrackingTransportOptions): BusTransport {
  const transport: BusTransport = {
    name: options.name,
    send: async (message: BusMessage): Promise<unknown> => {
      if (message.type === 'request') return {};
      return true;
    },
    onReceive: (_handler: (msg: BusMessage) => Promise<void>) => () => {},
    connect: async () => {},
    disconnect: async () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
  } as BusTransport;

  if (options.ready !== undefined) {
    transport.ready = options.ready;
  }

  return transport;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Transport registry readiness tracking', () => {
  let bus: ReturnType<typeof createBusInstance>;

  beforeEach(() => {
    bus = createBusInstance({ context: createBusContext() });
  });

  afterEach(() => {
    bus.disconnect();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: no transports → getPendingReady returns []
  // -------------------------------------------------------------------------

  it('returns an empty array when no transports are registered', () => {
    const pending = bus.getContext().transportRegistry.getPendingReady();
    expect(pending).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: transport without ready → not tracked
  // -------------------------------------------------------------------------

  it('does not track a transport that has no ready property', () => {
    const transport = createTrackingTransport({ name: 'no-ready' });
    bus.getContext().transportRegistry.registerTransport('no-ready' as BusTransportKeys, transport);

    const pending = bus.getContext().transportRegistry.getPendingReady();
    expect(pending).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: transport with pending ready → tracked in getPendingReady
  // -------------------------------------------------------------------------

  it('tracks a transport whose ready promise has not yet resolved', () => {
    let resolve!: () => void;
    const ready = new Promise<void>((r) => {
      resolve = r;
    });

    const transport = createTrackingTransport({ name: 'pending', ready });
    bus.getContext().transportRegistry.registerTransport('pending' as BusTransportKeys, transport);

    const pending = bus.getContext().transportRegistry.getPendingReady();
    expect(pending).toHaveLength(1);

    // Prevent the unresolved promise from leaking across tests.
    resolve();
  });

  // -------------------------------------------------------------------------
  // Scenario 4: self-cleaning — after ready resolves, getPendingReady returns []
  // -------------------------------------------------------------------------

  it('removes the entry from getPendingReady after the ready promise resolves', async () => {
    let resolve!: () => void;
    const ready = new Promise<void>((r) => {
      resolve = r;
    });

    const transport = createTrackingTransport({ name: 'self-clean', ready });
    bus.getContext().transportRegistry.registerTransport('self-clean' as BusTransportKeys, transport);

    // Confirm tracked before resolution.
    expect(bus.getContext().transportRegistry.getPendingReady()).toHaveLength(1);

    resolve();
    // Allow the `.then(cleanup)` microtask inside trackPendingReady to run.
    await ready;
    await Promise.resolve();

    expect(bus.getContext().transportRegistry.getPendingReady()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 5: cleanup on unregister → getPendingReady returns []
  // -------------------------------------------------------------------------

  it('removes the entry from getPendingReady when the transport is unregistered', () => {
    // A never-resolving promise: if self-clean were the only mechanism this
    // test would leak, proving the unregister path is required.
    const ready = new Promise<void>(() => {});

    const transport = createTrackingTransport({ name: 'unregister-clean', ready });
    const reg = bus.getContext().transportRegistry.registerTransport('unregister-clean' as BusTransportKeys, transport);

    expect(bus.getContext().transportRegistry.getPendingReady()).toHaveLength(1);

    reg.unregister();

    expect(bus.getContext().transportRegistry.getPendingReady()).toHaveLength(0);
  });
});
