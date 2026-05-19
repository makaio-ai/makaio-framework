/**
 * Tests for cross-transport priority-based request dispatch.
 *
 * Verifies the interleaved local/remote dispatch chain described in the design:
 * - Scenario 1: Correct execution order across local + remote entries by priority
 * - Scenario 2: Local handlers win ties over remote entries at equal priority
 * - Scenario 3: Hot plugin enable/disable (remoteRequestHandlers updated mid-run)
 * - Scenario 4: Ref-counting — transport entry removed only when last registration is gone
 * - Scenario 5: replacePayload crosses transport boundary
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { MakaioBus, type BusTransport, type BusMessage, type BusTransportRegistry, NoHandlerError } from '../index.js';
import { createStubTransport } from './helpers/transport-fixtures.js';

// ---------------------------------------------------------------------------
// Namespace registration
// ---------------------------------------------------------------------------

const { subjects: CrossDispatchSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('crossDispatch', {
    compute: {
      request: z.object({ value: z.number() }),
      response: z.object({ result: z.number() }),
    },
    relay: {
      request: z.object({ data: z.string() }),
      response: z.object({ processed: z.string() }),
    },
  }),
);

declare module '../index.js' {
  interface BusSubjectsNamespace {
    crossDispatch: typeof CrossDispatchSubjects;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal transport that records each send and returns the provided value
 * (or throws it when it is an Error instance).
 * @param transportName - Registry name for the transport instance
 * @param onSend - Callback invoked on each send; return an Error to simulate a throw
 */
function createRecordingTransport(
  transportName: string,
  onSend: (message: BusMessage) => unknown,
): BusTransport & { simulateReceive(message: BusMessage): Promise<void> } {
  let capturedHandler: ((message: BusMessage) => Promise<void>) | undefined;

  return {
    name: transportName,
    send: mock(async (message: BusMessage) => {
      const result = onSend(message);
      if (result instanceof Error) throw result;
      return result;
    }) as BusTransport['send'],
    onReceive: (handler) => {
      capturedHandler = handler;
      return () => {
        capturedHandler = undefined;
      };
    },
    connect: async () => {},
    disconnect: async () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
    simulateReceive: async (message: BusMessage) => {
      if (capturedHandler) await capturedHandler(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const { registerTransport } = MakaioBus.getContext().transportRegistry;

describe('Cross-transport priority dispatch', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  // -------------------------------------------------------------------------
  // Scenario 1 — Execution order: local:400 → remote:300 → remote:200 → local:100
  // -------------------------------------------------------------------------

  describe('Scenario 1: correct cross-transport execution order', () => {
    it('routes entries in descending priority order across local and remote boundaries', async () => {
      const order: string[] = [];
      const context = MakaioBus.getContext();

      // Local handler at priority 400 — calls next() so the chain continues.
      const cleanup400 = MakaioBus.on(
        CrossDispatchSubjects.compute,
        async (ctx) => {
          order.push('local-400');
          await ctx.next();
        },
        { priority: 400 },
      );

      // Local handler at priority 100 — terminates the chain.
      const cleanup100 = MakaioBus.on(
        CrossDispatchSubjects.compute,
        (ctx) => {
          order.push('local-100');
          ctx.setResult({ result: 100 });
        },
        { priority: 100 },
      );

      // Note: This test stubs transport.send() to throw NoHandlerError directly
      // rather than feeding through a real registry; see cross-transport-cursor-e2e.test.ts (Test G)
      // for the end-to-end coverage with real registries on both sides.

      // Remote transport advertised at priorities 300 and 200.
      // Returns NoHandlerError to signal "chain exhausted at the remote node" so
      // dispatch continues to the next entry in the merged list.
      const remoteTransport = createRecordingTransport('remote-ab', (message) => {
        if (message.type === 'request') {
          order.push('remote-send');
          return new NoHandlerError('crossDispatch.compute');
        }
        return true;
      });

      const unregister = registerTransport('remote-ab' as keyof BusTransportRegistry, remoteTransport).unregister;

      try {
        // Advertise two remote entries on the same transport at priorities 300 and 200.
        context.remoteRequestHandlers.set('crossDispatch.compute', [
          { transport: 'remote-ab', priority: 300 },
          { transport: 'remote-ab', priority: 200 },
        ]);

        const result = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });

        // The transport should be called twice: once for the 300 entry, once for 200.
        // Both return NoHandlerError so dispatch falls through to local-100.
        expect(order).toEqual(['local-400', 'remote-send', 'remote-send', 'local-100']);
        expect(result.result).toBe(100);
      } finally {
        unregister();
        cleanup400();
        cleanup100();
      }
    });

    it('stops at the first remote entry that returns a result', async () => {
      const order: string[] = [];
      const context = MakaioBus.getContext();

      const cleanup400 = MakaioBus.on(
        CrossDispatchSubjects.compute,
        async (ctx) => {
          order.push('local-400');
          await ctx.next();
        },
        { priority: 400 },
      );

      const cleanup100 = MakaioBus.on(
        CrossDispatchSubjects.compute,
        (ctx) => {
          order.push('local-100');
          ctx.setResult({ result: 100 });
        },
        { priority: 100 },
      );

      // This transport handles (returns a result) on the first call.
      const remoteTransport = createRecordingTransport('remote-handled', (message) => {
        if (message.type === 'request') {
          order.push('remote-handled');
          return { result: 300 };
        }
        return true;
      });

      const unregister = registerTransport('remote-handled' as keyof BusTransportRegistry, remoteTransport).unregister;

      try {
        context.remoteRequestHandlers.set('crossDispatch.compute', [
          { transport: 'remote-handled', priority: 300 },
          { transport: 'remote-handled', priority: 200 },
        ]);

        const result = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });

        // Transport returns a result at priority 300 → chain stops there.
        // local-100 never runs, remote is called only once.
        expect(order).toEqual(['local-400', 'remote-handled']);
        expect(result.result).toBe(300);
      } finally {
        unregister();
        cleanup400();
        cleanup100();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — Local wins ties at equal priority
  // -------------------------------------------------------------------------

  describe('Scenario 2: local handler wins priority tie over remote', () => {
    it('runs local handler before remote when both are at the same priority', async () => {
      const context = MakaioBus.getContext();

      // Local handler at priority 100 that sets the result — transport should not be called.
      const cleanup = MakaioBus.on(
        CrossDispatchSubjects.compute,
        (ctx) => {
          ctx.setResult({ result: 42 });
        },
        { priority: 100 },
      );

      const remoteTransport = createStubTransport({
        send: async () => ({ result: 999 }),
      });

      const unregister = registerTransport('remote-tied' as keyof BusTransportRegistry, remoteTransport).unregister;

      try {
        context.remoteRequestHandlers.set('crossDispatch.compute', [{ transport: 'remote-tied', priority: 100 }]);

        const result = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });

        // Local handler wins the tie — remote transport should not have been called.
        expect(result.result).toBe(42);
        expect(remoteTransport.send).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'request' }),
          expect.anything(),
        );
      } finally {
        unregister();
        cleanup();
      }
    });

    it('calls remote after local when local explicitly calls next() at tied priority', async () => {
      const context = MakaioBus.getContext();

      // Local handler at priority 100 that delegates to next().
      const cleanup = MakaioBus.on(
        CrossDispatchSubjects.compute,
        async (ctx) => {
          await ctx.next();
        },
        { priority: 100 },
      );

      const remoteTransport = createStubTransport({
        send: async (message) => (message.type === 'request' ? { result: 99 } : true),
      });

      const unregister = registerTransport(
        'remote-after-local' as keyof BusTransportRegistry,
        remoteTransport,
      ).unregister;

      try {
        context.remoteRequestHandlers.set('crossDispatch.compute', [
          { transport: 'remote-after-local', priority: 100 },
        ]);

        const result = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });

        // Local called next() → remote at same priority (next in merged list) handles it.
        expect(result.result).toBe(99);
        expect(remoteTransport.send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'request' }),
          expect.anything(),
        );
      } finally {
        unregister();
        cleanup();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — Hot plugin enable/disable
  // -------------------------------------------------------------------------

  describe('Scenario 3: hot plugin enable/disable', () => {
    it('dispatches through the updated remote entry list after a plugin is enabled', async () => {
      const context = MakaioBus.getContext();
      const order: string[] = [];

      const cleanup300 = MakaioBus.on(
        CrossDispatchSubjects.compute,
        async (ctx) => {
          order.push('local-300');
          await ctx.next();
        },
        { priority: 300 },
      );

      const cleanup100 = MakaioBus.on(
        CrossDispatchSubjects.compute,
        (ctx) => {
          order.push('local-100');
          ctx.setResult({ result: 1 });
        },
        { priority: 100 },
      );

      // Before enabling the plugin: no remote entries.
      const firstResult = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });
      expect(order).toEqual(['local-300', 'local-100']);
      expect(firstResult.result).toBe(1);

      order.length = 0;

      // Enable plugin: add a remote entry at priority 200 (between local-300 and local-100).
      const remoteTransport = createRecordingTransport('plugin-transport', (message) => {
        if (message.type === 'request') {
          order.push('remote-200');
          return new NoHandlerError('crossDispatch.compute');
        }
        return true;
      });

      const unregister = registerTransport(
        'plugin-transport' as keyof BusTransportRegistry,
        remoteTransport,
      ).unregister;

      try {
        context.remoteRequestHandlers.set('crossDispatch.compute', [{ transport: 'plugin-transport', priority: 200 }]);

        const secondResult = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });

        // Remote at 200 is now interleaved between local-300 and local-100.
        expect(order).toEqual(['local-300', 'remote-200', 'local-100']);
        expect(secondResult.result).toBe(1);
      } finally {
        unregister();
        cleanup300();
        cleanup100();
      }
    });

    it('omits the remote entry after the plugin is disabled', async () => {
      const context = MakaioBus.getContext();
      const order: string[] = [];

      const cleanup300 = MakaioBus.on(
        CrossDispatchSubjects.compute,
        async (ctx) => {
          order.push('local-300');
          await ctx.next();
        },
        { priority: 300 },
      );

      const cleanup100 = MakaioBus.on(
        CrossDispatchSubjects.compute,
        (ctx) => {
          order.push('local-100');
          ctx.setResult({ result: 1 });
        },
        { priority: 100 },
      );

      const remoteTransport = createRecordingTransport('removable-plugin', (message) => {
        if (message.type === 'request') {
          order.push('remote-200');
          return new NoHandlerError('crossDispatch.compute');
        }
        return true;
      });

      const unregister = registerTransport(
        'removable-plugin' as keyof BusTransportRegistry,
        remoteTransport,
      ).unregister;

      context.remoteRequestHandlers.set('crossDispatch.compute', [{ transport: 'removable-plugin', priority: 200 }]);

      // With plugin: remote entry participates in the chain.
      const withPluginResult = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });
      expect(order).toEqual(['local-300', 'remote-200', 'local-100']);
      expect(withPluginResult.result).toBe(1);

      order.length = 0;

      // Disable plugin: remove remote entries and unregister transport.
      context.remoteRequestHandlers.delete('crossDispatch.compute');
      unregister();

      try {
        const withoutPluginResult = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });

        // Remote no longer in the chain.
        expect(order).toEqual(['local-300', 'local-100']);
        expect(withoutPluginResult.result).toBe(1);
      } finally {
        cleanup300();
        cleanup100();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — Ref-counting: entry removed only when last registration is gone
  // -------------------------------------------------------------------------

  describe('Scenario 4: ref-counting remote entries', () => {
    it('routes to transport while at least one remote entry for it remains', async () => {
      const context = MakaioBus.getContext();

      // Register a fallback local handler so requests never throw NoHandlerError.
      const fallback = MakaioBus.on(
        CrossDispatchSubjects.compute,
        (ctx) => {
          ctx.setResult({ result: 0 });
        },
        { priority: -1 },
      );

      const remoteTransport = createStubTransport({
        send: async (message) => (message.type === 'request' ? { result: 77 } : true),
      });

      const unregister = registerTransport(
        'ref-counted-transport' as keyof BusTransportRegistry,
        remoteTransport,
      ).unregister;

      try {
        // Simulate two "registrations" at different priorities for the same transport.
        context.remoteRequestHandlers.set('crossDispatch.compute', [
          { transport: 'ref-counted-transport', priority: 200 },
          { transport: 'ref-counted-transport', priority: 100 },
        ]);

        // Both entries present — transport handles the request at priority 200.
        const resultBoth = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });
        expect(resultBoth.result).toBe(77);

        // Remove the higher-priority entry — transport still has one entry left.
        context.remoteRequestHandlers.set('crossDispatch.compute', [
          { transport: 'ref-counted-transport', priority: 100 },
        ]);

        const resultOneLeft = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });
        expect(resultOneLeft.result).toBe(77);

        // Remove last entry — transport no longer participates.
        context.remoteRequestHandlers.delete('crossDispatch.compute');

        const resultNone = await MakaioBus.request(CrossDispatchSubjects.compute, { value: 1 });
        expect(resultNone.result).toBe(0); // Fallback local handler ran.
        expect(remoteTransport.send).toHaveBeenCalledTimes(2); // Only during the two steps above.
      } finally {
        unregister();
        fallback();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — replacePayload crosses transport boundary
  // -------------------------------------------------------------------------

  describe('Scenario 5: replacePayload propagates across transport boundary', () => {
    it('forwards the replaced payload to the remote transport entry', async () => {
      const context = MakaioBus.getContext();

      // Local handler at priority 200: replaces payload then delegates.
      const cleanup = MakaioBus.on(
        CrossDispatchSubjects.relay,
        async (ctx) => {
          ctx.replacePayload({ data: `modified:${ctx.payload.data}` });
          await ctx.next();
        },
        { priority: 200 },
      );

      // Capture the payload that the remote transport receives.
      let capturedPayload: unknown;
      const remoteTransport = createRecordingTransport('relay-transport', (message) => {
        if (message.type === 'request') {
          capturedPayload = message.payload;
          return { processed: 'done' };
        }
        return true;
      });

      const unregister = registerTransport('relay-transport' as keyof BusTransportRegistry, remoteTransport).unregister;

      try {
        // Remote handler at priority 100 — lower than local so it runs after.
        context.remoteRequestHandlers.set('crossDispatch.relay', [{ transport: 'relay-transport', priority: 100 }]);

        const result = await MakaioBus.request(CrossDispatchSubjects.relay, { data: 'original' });

        // Transport must receive the modified payload, not the original.
        expect(capturedPayload).toEqual({ data: 'modified:original' });
        expect(result.processed).toBe('done');
      } finally {
        unregister();
        cleanup();
      }
    });
  });
});
