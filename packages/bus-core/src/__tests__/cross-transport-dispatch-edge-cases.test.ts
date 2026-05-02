/**
 * Edge-case tests for cross-transport priority-based request dispatch.
 *
 * Covers scenarios 6–10 from the design:
 * 6. Timeout/deadline propagation on the wire
 * 7. Error propagation mid-chain (transport error skipped vs rethrown)
 * 8. $meta.local subjects never reach a remote transport
 * 9. Wildcard remote patterns match concrete subjects
 * 10. __onAny deduplication fires exactly once per logical correlationId
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import {
  MakaioBus,
  NoHandlerError,
  localSubject,
  type BusTransport,
  type BusMessage,
  type BusRequestMessage,
  type BusTransportRegistry,
} from '../index.js';
import { invokeAnyHandlers } from '../utils/invoke-any-handlers.js';
import { createStubTransport } from './helpers/transport-fixtures.js';

// ---------------------------------------------------------------------------
// Shared namespace registrations — done once at module level so that the
// augmented BusSubjectsNamespace is available for all tests.
// ---------------------------------------------------------------------------

const EdgeNamespace = MakaioBus.registerNamespace('edgeCase', {
  ping: {
    request: z.object({ id: z.string() }),
    response: z.object({ pong: z.boolean() }),
  },
  localOnly: localSubject({
    request: z.object({ id: z.string() }),
    response: z.object({ result: z.string() }),
  }),
}).subjects;

const AdapterNamespace = MakaioBus.registerNamespace('adapter', {
  start: {
    request: z.object({ name: z.string() }),
    response: z.object({ started: z.boolean() }),
  },
  stop: {
    request: z.object({ name: z.string() }),
    response: z.object({ stopped: z.boolean() }),
  },
}).subjects;

declare module '../index.js' {
  interface BusSubjectsNamespace {
    edgeCase: typeof EdgeNamespace;
    adapter: typeof AdapterNamespace;
  }
}

// ---------------------------------------------------------------------------
// Test 6: Timeout / deadline propagation
// ---------------------------------------------------------------------------

describe('Test 6: Timeout and deadline propagation', () => {
  let unregisterRemote: { unregister: () => void; ready: Promise<void> };
  let capturedMessage: BusRequestMessage | undefined;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    capturedMessage = undefined;

    const transport: BusTransport = {
      name: 'deadline-transport',
      send: vi.fn(async (message: BusMessage) => {
        if (message.type === 'request') {
          capturedMessage = message;
          return { pong: true };
        }
        return true;
      }) as BusTransport['send'],
      onReceive: () => () => {},
      connect: async () => {},
      disconnect: async () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
    };

    unregisterRemote = MakaioBus.getContext().transportRegistry.registerTransport(
      'deadline-transport' as keyof BusTransportRegistry,
      transport,
    );
  });

  afterEach(() => {
    unregisterRemote.unregister();
    MakaioBus.__resetHandlers?.();
  });

  it('sets deadline close to Date.now() + timeout on first hop', async () => {
    // Advertise the remote transport so dispatch routes to it.
    MakaioBus.getContext().remoteRequestHandlers.set('edgeCase.ping', [
      { transport: 'deadline-transport', priority: 0 },
    ]);

    const before = Date.now();
    await MakaioBus.request(EdgeNamespace.ping, { id: 'deadline-test' }, { timeout: 5000 });
    const after = Date.now();

    expect(capturedMessage).toBeDefined();
    // deadline should be set
    expect(capturedMessage?.deadline).toBeDefined();
    // deadline should be approximately before + 5000 (±500ms for test latency)
    expect(capturedMessage!.deadline).toBeGreaterThanOrEqual(before + 4500);
    expect(capturedMessage!.deadline).toBeLessThanOrEqual(after + 5000);
  });

  it('timeout field on wire is approximately equal to the caller-specified timeout', async () => {
    MakaioBus.getContext().remoteRequestHandlers.set('edgeCase.ping', [
      { transport: 'deadline-transport', priority: 0 },
    ]);

    await MakaioBus.request(EdgeNamespace.ping, { id: 'timeout-field-test' }, { timeout: 5000 });

    expect(capturedMessage?.timeout).toBeDefined();
    // On the first hop there is negligible elapsed time so remaining ≈ 5000
    expect(capturedMessage!.timeout).toBeGreaterThan(4000);
    expect(capturedMessage!.timeout).toBeLessThanOrEqual(5000);
  });

  it('remaining timeout on the wire reflects elapsed time when deadline is pre-set', async () => {
    // The deadline is set lazily in executeRemoteEntry on the first hop, then
    // propagated to subsequent hops. To test the "remaining time shrinks" invariant
    // we simulate a second hop: inject a pre-set deadline that is already 200 ms old
    // by passing it through remoteRequestHandlers and a relay transport.
    //
    // We use a source transport to inject a request that already carries a deadline
    // 200 ms in the past relative to now. The relay transport (deadline-transport)
    // will receive the wire message with a timeout ≤ 4800 ms.
    const ELAPSED_MS = 200;
    const pastDeadline = Date.now() + 5000 - ELAPSED_MS; // deadline set 200 ms ago

    let sourceHandler: ((message: BusMessage) => Promise<void>) | undefined;
    const sourceTransport: BusTransport = {
      name: 'relay-source',
      send: vi.fn(async () => true) as BusTransport['send'],
      onReceive: (handler) => {
        sourceHandler = handler;
        return () => {
          sourceHandler = undefined;
        };
      },
      connect: async () => {},
      disconnect: async () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
    };

    const unregisterSource = MakaioBus.getContext().transportRegistry.registerTransport(
      'relay-source' as keyof BusTransportRegistry,
      sourceTransport,
    );

    MakaioBus.getContext().remoteRequestHandlers.set('edgeCase.ping', [
      { transport: 'deadline-transport', priority: 0 },
    ]);

    try {
      // Simulate an inbound request that already carries a past deadline.
      await sourceHandler?.({
        type: 'request',
        namespace: 'edgeCase',
        subject: 'ping',
        payload: { id: 'relay-remaining' },
        correlationId: 'corr-relay-remaining',
        messageId: 'msg-relay-remaining',
        timeout: 5000 - ELAPSED_MS, // already-reduced timeout
        deadline: pastDeadline,
      });

      expect(capturedMessage?.timeout).toBeDefined();
      // The relay hop must use the pre-set deadline; remaining time < 5000.
      expect(capturedMessage!.timeout).toBeLessThan(5000);
    } finally {
      unregisterSource.unregister();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: Error propagation mid-chain
// ---------------------------------------------------------------------------

describe('Test 7: Error propagation mid-chain', () => {
  let unregisterRemote: { unregister: () => void; ready: Promise<void> };

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    unregisterRemote?.unregister();
    MakaioBus.__resetHandlers?.();
  });

  it('rethrows non-NoHandlerError when remote is the only entry and it fails', async () => {
    const failingTransport = createStubTransport({
      send: async () => {
        throw new Error('remote-failure');
      },
    });

    unregisterRemote = MakaioBus.getContext().transportRegistry.registerTransport(
      'failing' as keyof BusTransportRegistry,
      failingTransport,
    );

    MakaioBus.getContext().remoteRequestHandlers.set('edgeCase.ping', [{ transport: 'failing', priority: 0 }]);

    await expect(MakaioBus.request(EdgeNamespace.ping, { id: 'err-propagate' })).rejects.toThrow('remote-failure');
  });

  it('swallows non-NoHandlerError from remote when a lower-priority local handler succeeds', async () => {
    // Remote at priority 100 throws. Local at priority 0 provides result.
    // The remote error should be swallowed and the local result returned.
    const failingTransport = createStubTransport({
      send: async () => {
        throw new Error('transient-remote-failure');
      },
    });

    unregisterRemote = MakaioBus.getContext().transportRegistry.registerTransport(
      'transient' as keyof BusTransportRegistry,
      failingTransport,
    );

    MakaioBus.getContext().remoteRequestHandlers.set('edgeCase.ping', [{ transport: 'transient', priority: 100 }]);

    const cleanup = MakaioBus.on(
      EdgeNamespace.ping,
      (ctx) => {
        ctx.setResult({ pong: true });
      },
      { priority: 0 },
    );

    try {
      const result = await MakaioBus.request(EdgeNamespace.ping, { id: 'swallow-err' });
      expect(result).toEqual({ pong: true });
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: $meta.local subjects never go remote
// ---------------------------------------------------------------------------

describe('Test 8: $meta.local subjects never reach a remote transport', () => {
  let remoteTransport: ReturnType<typeof createStubTransport>;
  let unregisterRemote: { unregister: () => void; ready: Promise<void> };

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();

    remoteTransport = createStubTransport({
      send: async (message: BusMessage) => {
        if (message.type === 'request') return { result: 'from-remote' };
        return true;
      },
    });

    unregisterRemote = MakaioBus.getContext().transportRegistry.registerTransport(
      'local-subject-remote' as keyof BusTransportRegistry,
      remoteTransport,
    );
  });

  afterEach(() => {
    unregisterRemote.unregister();
    MakaioBus.__resetHandlers?.();
  });

  it('does not consult the remote transport even when it is advertised for a local-only subject', async () => {
    // Advertise the transport for the local-only subject.
    MakaioBus.getContext().remoteRequestHandlers.set('edgeCase.localOnly', [
      { transport: 'local-subject-remote', priority: 0 },
    ]);

    // Register a local handler so the request resolves.
    const cleanup = MakaioBus.on(EdgeNamespace.localOnly, (ctx) => {
      ctx.setResult({ result: 'local' });
    });

    try {
      const result = await MakaioBus.request(EdgeNamespace.localOnly, { id: 'local-only-test' });

      expect(result).toEqual({ result: 'local' });
      // Remote transport must never be called.
      expect(remoteTransport.send).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('throws NoHandlerError (not forwarding remotely) when no local handler is present', async () => {
    MakaioBus.getContext().remoteRequestHandlers.set('edgeCase.localOnly', [
      { transport: 'local-subject-remote', priority: 0 },
    ]);

    await expect(MakaioBus.request(EdgeNamespace.localOnly, { id: 'no-local-handler' })).rejects.toThrow(
      NoHandlerError,
    );

    expect(remoteTransport.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 9: Wildcard remote patterns match concrete subjects
// ---------------------------------------------------------------------------

describe('Test 9: Wildcard remote patterns across transports', () => {
  let capturedRequests: BusRequestMessage[];
  let unregisterRemote: { unregister: () => void; ready: Promise<void> };

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    capturedRequests = [];

    const wildcardTransport: BusTransport = {
      name: 'wildcard-transport',
      send: vi.fn(async (message: BusMessage) => {
        if (message.type === 'request') {
          capturedRequests.push(message);
          return { started: true };
        }
        return true;
      }) as BusTransport['send'],
      onReceive: () => () => {},
      connect: async () => {},
      disconnect: async () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
    };

    unregisterRemote = MakaioBus.getContext().transportRegistry.registerTransport(
      'wildcard-transport' as keyof BusTransportRegistry,
      wildcardTransport,
    );
  });

  afterEach(() => {
    unregisterRemote.unregister();
    MakaioBus.__resetHandlers?.();
  });

  it('routes adapter.start to a remote registered under the wildcard pattern adapter.*', async () => {
    // Register the remote transport under the wildcard pattern.
    MakaioBus.getContext().remoteRequestHandlers.set('adapter.*', [{ transport: 'wildcard-transport', priority: 0 }]);

    const result = await MakaioBus.request(AdapterNamespace.start, { name: 'my-adapter' });

    expect(result).toEqual({ started: true });
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({
      type: 'request',
      subject: 'start',
      namespace: 'adapter',
    });
  });

  it('routes adapter.stop to the same wildcard remote entry', async () => {
    // The wildcard-transport's send returns { started: true } which fails the stop
    // response schema ({ stopped: boolean }). Override it to return the correct shape.
    const stopCaptured: BusRequestMessage[] = [];
    const stopTransport: BusTransport = {
      name: 'wildcard-stop-transport',
      send: vi.fn(async (message: BusMessage) => {
        if (message.type === 'request') {
          stopCaptured.push(message);
          return { stopped: true };
        }
        return true;
      }) as BusTransport['send'],
      onReceive: () => () => {},
      connect: async () => {},
      disconnect: async () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
    };

    const unregisterStop = MakaioBus.getContext().transportRegistry.registerTransport(
      'wildcard-stop-transport' as keyof BusTransportRegistry,
      stopTransport,
    );

    MakaioBus.getContext().remoteRequestHandlers.set('adapter.*', [
      { transport: 'wildcard-stop-transport', priority: 0 },
    ]);

    try {
      const result = await MakaioBus.request(AdapterNamespace.stop, { name: 'my-adapter' });
      expect(result).toEqual({ stopped: true });
      expect(stopCaptured).toHaveLength(1);
      expect(stopCaptured[0]).toMatchObject({
        type: 'request',
        subject: 'stop',
        namespace: 'adapter',
      });
    } finally {
      unregisterStop.unregister();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 10: __onAny fires exactly once per logical correlationId
// ---------------------------------------------------------------------------

describe('Test 10: __onAny deduplication', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('fires __onAny exactly once for a single-node request (no transport)', async () => {
    const invocations: string[] = [];

    const unsubscribeAny = MakaioBus.__onAny((ctx) => {
      invocations.push(ctx.correlationId ?? '(no-corr)');
    });

    const cleanup = MakaioBus.on(EdgeNamespace.ping, (ctx) => {
      ctx.setResult({ pong: true });
    });

    try {
      await MakaioBus.request(EdgeNamespace.ping, { id: 'once-test' }, { correlationId: 'corr-once' });

      // Give the fire-and-forget __onAny microtasks a chance to settle.
      await Promise.resolve();

      expect(invocations.filter((id) => id === 'corr-once')).toHaveLength(1);
    } finally {
      unsubscribeAny();
      cleanup();
    }
  });

  it('fires __onAny for each distinct correlationId', async () => {
    const invocations: string[] = [];

    const unsubscribeAny = MakaioBus.__onAny((ctx) => {
      if (ctx.correlationId) invocations.push(ctx.correlationId);
    });

    const cleanup = MakaioBus.on(EdgeNamespace.ping, (ctx) => {
      ctx.setResult({ pong: true });
    });

    try {
      await MakaioBus.request(EdgeNamespace.ping, { id: 'a' }, { correlationId: 'corr-a' });
      await MakaioBus.request(EdgeNamespace.ping, { id: 'b' }, { correlationId: 'corr-b' });

      await Promise.resolve();

      expect(invocations.filter((id) => id === 'corr-a')).toHaveLength(1);
      expect(invocations.filter((id) => id === 'corr-b')).toHaveLength(1);
    } finally {
      unsubscribeAny();
      cleanup();
    }
  });

  it('deduplicates: invokeAnyHandlers called twice with the same correlationId fires handler once', async () => {
    const context = MakaioBus.getContext();
    const invocations: string[] = [];

    const unsubscribeAny = MakaioBus.__onAny((ctx) => {
      if (ctx.correlationId) invocations.push(ctx.correlationId);
    });

    try {
      const corrId = 'corr-dedup-direct';

      // Call invokeAnyHandlers directly to test the dedup cache in isolation.
      invokeAnyHandlers(context, 'request', 'ping', 'edgeCase', {}, 'msg-1', corrId);
      invokeAnyHandlers(context, 'request', 'ping', 'edgeCase', {}, 'msg-2', corrId);

      // Let both microtask chains settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(invocations.filter((id) => id === corrId)).toHaveLength(1);
    } finally {
      unsubscribeAny();
    }
  });

  it('does NOT deduplicate when correlationId is absent (events / broadcasts)', async () => {
    const context = MakaioBus.getContext();
    const invocations: number[] = [];

    const unsubscribeAny = MakaioBus.__onAny(() => {
      invocations.push(1);
    });

    try {
      // No correlationId → dedup must be bypassed.
      invokeAnyHandlers(context, 'event', 'ping', 'edgeCase', {}, 'msg-evt-1', undefined);
      invokeAnyHandlers(context, 'event', 'ping', 'edgeCase', {}, 'msg-evt-2', undefined);

      await Promise.resolve();
      await Promise.resolve();

      expect(invocations).toHaveLength(2);
    } finally {
      unsubscribeAny();
    }
  });
});
