/**
 * Tests for broadcast() options.transports three-way behavior:
 *
 * 1. `undefined` (default)  — all registered transports via getSortedTransports
 * 2. `[]` (empty array)     — local-only, no transports (relay loop prevention)
 * 3. `['name']` (explicit)  — only the named transport(s)
 * 4. `$meta.local` subjects — never dispatched to transports regardless of options
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import {
  MakaioBus,
  localSubject,
  type BusTransport,
  type BusMessage,
  type BusRequestMessage,
  type BusEventMessage,
  type BusBroadcastMessage,
} from '../index.js';

// ---------------------------------------------------------------------------
// Test transport
// ---------------------------------------------------------------------------

type BroadcastResult = { nodeId: string; payload: unknown };

/**
 * Transport that records every sent message.
 * Returns an empty results array for broadcast messages so that the
 * broadcast() aggregator does not crash on iteration.
 */
class RecordingTransport implements BusTransport {
  public readonly name = 'recording-transport';
  public readonly messages: BusMessage[] = [];

  /**
   * Send a request message.
   * @param message - Request message payload envelope
   * @param timeout - Optional correlation timeout in milliseconds
   * @returns Promise resolving with an arbitrary request response payload
   */
  public send(message: BusRequestMessage, timeout?: number): Promise<unknown>;
  /**
   * Send an event message.
   * @param message - Event message payload envelope
   * @param timeout - Optional correlation timeout in milliseconds
   * @returns Promise resolving to delivery status
   */
  public send(message: BusEventMessage, timeout?: number): Promise<boolean>;
  /**
   * Send a broadcast message.
   * @param message - Broadcast message with request payload (for example BusRequestMessage, BusEventMessage, or BusBroadcastMessage payload shapes)
   * @param timeout - Optional correlation timeout in milliseconds
   * @returns Promise resolving to aggregated broadcast results
   */
  public send(message: BusBroadcastMessage, timeout?: number): Promise<BroadcastResult[]>;
  public send(message: BusMessage, timeout?: number): Promise<unknown | boolean | BroadcastResult[]> {
    void timeout;
    this.messages.push(message);
    if (message.type === 'broadcast') {
      // Simulate a remote handler responding from this transport
      return Promise.resolve([{ nodeId: 'remote', payload: { output: 'from-transport' } }]);
    }
    if (message.type === 'request') {
      return Promise.resolve({ output: 'mocked' });
    }
    return Promise.resolve(true);
  }

  /**
   * Register the receive callback for incoming transport messages.
   * @param handler - Async callback invoked with each incoming bus message (BusRequestMessage, BusEventMessage, or BusBroadcastMessage)
   * @returns Cleanup function that unregisters the callback
   */
  public onReceive(handler: (message: BusMessage) => Promise<void>): () => void {
    void handler;
    return () => {};
  }

  /**
   * Connect the transport.
   * @returns Promise that resolves when connection setup is complete
   */
  public async connect(): Promise<void> {}

  /**
   * Disconnect the transport.
   * @returns Promise that resolves when connection teardown is complete
   */
  public async disconnect(): Promise<void> {}
  public async subscribe(): Promise<void> {}
  public async unsubscribe(): Promise<void> {}

  /** Clear the recorded messages between assertions. */
  public clear(): void {
    this.messages.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Subject registration
// ---------------------------------------------------------------------------

const { subjects: BroadcastSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('broadcastTransportTest', {
    remoteRequest: {
      request: z.object({ q: z.string() }),
      response: z.object({ output: z.string() }),
    },
    localRequest: localSubject({
      request: z.object({ q: z.string() }),
      response: z.object({ output: z.string() }),
    }),
  }),
);

declare module '../index.js' {
  interface BusTransportRegistry {
    broadcastPrimary: BusTransport;
    broadcastSecondary: BusTransport;
  }

  interface BusSubjectsNamespace {
    broadcastTransportTest: typeof BroadcastSubjects;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const { registerTransport } = MakaioBus.getContext().transportRegistry;

const withCleanup = async (register: () => () => void, run: () => Promise<void>): Promise<void> => {
  const cleanup = register();
  try {
    await run();
  } finally {
    cleanup();
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('broadcast() options.transports behavior', () => {
  let primary: RecordingTransport;
  let unregisterPrimary: () => void;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    primary = new RecordingTransport();
    unregisterPrimary = registerTransport('broadcastPrimary', primary).unregister;
  });

  afterEach(() => {
    unregisterPrimary();
    MakaioBus.__resetHandlers?.();
  });

  // -------------------------------------------------------------------------
  // 1. Default (no options.transports)
  // -------------------------------------------------------------------------
  describe('default (options.transports = undefined)', () => {
    it('delivers to local handlers', async () => {
      await withCleanup(
        () =>
          MakaioBus.on(BroadcastSubjects.remoteRequest, (ctx) => {
            ctx.setResult({ output: `local:${ctx.payload.q}` });
          }),
        async () => {
          const results = await MakaioBus.broadcast(BroadcastSubjects.remoteRequest, { q: 'ping' });
          const localResult = results.find((r) => r.payload.output.startsWith('local:'));
          expect(localResult).toBeDefined();
          expect(localResult?.payload).toEqual({ output: 'local:ping' });
        },
      );
    });

    it('delivers to registered transports', async () => {
      const results = await MakaioBus.broadcast(BroadcastSubjects.remoteRequest, { q: 'ping' });

      expect(primary.messages).toHaveLength(1);
      expect(primary.messages[0]).toMatchObject({
        type: 'broadcast',
        subject: 'remoteRequest',
        namespace: 'broadcastTransportTest',
        payload: { q: 'ping' },
      });

      // The transport result is aggregated into the broadcast results
      const transportResult = results.find((r) => r.nodeId === 'remote');
      expect(transportResult).toBeDefined();
      expect(transportResult?.payload).toEqual({ output: 'from-transport' });
    });

    it('delivers to both local handlers AND transports simultaneously', async () => {
      await withCleanup(
        () =>
          MakaioBus.on(BroadcastSubjects.remoteRequest, (ctx) => {
            ctx.setResult({ output: `local:${ctx.payload.q}` });
          }),
        async () => {
          const results = await MakaioBus.broadcast(BroadcastSubjects.remoteRequest, { q: 'both' });

          expect(primary.messages).toHaveLength(1);
          expect(results).toHaveLength(2);

          const localResult = results.find((r) => r.payload.output === 'local:both');
          const remoteResult = results.find((r) => r.nodeId === 'remote');
          expect(localResult).toBeDefined();
          expect(remoteResult).toBeDefined();
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Empty array (transports: [])
  // -------------------------------------------------------------------------
  describe('empty array (options.transports = [])', () => {
    it('does NOT dispatch to any transport', async () => {
      await MakaioBus.broadcast(BroadcastSubjects.remoteRequest, { q: 'local-only' }, { transports: [] });

      expect(primary.messages).toHaveLength(0);
    });

    it('still delivers to local handlers', async () => {
      await withCleanup(
        () =>
          MakaioBus.on(BroadcastSubjects.remoteRequest, (ctx) => {
            ctx.setResult({ output: `local:${ctx.payload.q}` });
          }),
        async () => {
          const results = await MakaioBus.broadcast(
            BroadcastSubjects.remoteRequest,
            { q: 'local-only' },
            { transports: [] },
          );

          expect(primary.messages).toHaveLength(0);
          expect(results).toHaveLength(1);
          expect(results[0]?.payload).toEqual({ output: 'local:local-only' });
        },
      );
    });

    it('returns empty results when no local handlers are registered', async () => {
      const results = await MakaioBus.broadcast(BroadcastSubjects.remoteRequest, { q: 'nobody' }, { transports: [] });

      expect(results).toHaveLength(0);
      expect(primary.messages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Explicit transport name(s)
  // -------------------------------------------------------------------------
  describe('explicit transport name (options.transports = ["broadcastPrimary"])', () => {
    let secondary: RecordingTransport;
    let unregisterSecondary: () => void;

    beforeEach(() => {
      secondary = new RecordingTransport();
      unregisterSecondary = registerTransport('broadcastSecondary', secondary).unregister;
    });

    afterEach(() => {
      unregisterSecondary();
    });

    it('sends to the named transport only', async () => {
      await MakaioBus.broadcast(
        BroadcastSubjects.remoteRequest,
        { q: 'selective' },
        { transports: ['broadcastPrimary'] },
      );

      expect(primary.messages).toHaveLength(1);
      expect(secondary.messages).toHaveLength(0);
    });

    it('does not send to unspecified transports', async () => {
      await MakaioBus.broadcast(
        BroadcastSubjects.remoteRequest,
        { q: 'selective' },
        { transports: ['broadcastSecondary'] },
      );

      expect(primary.messages).toHaveLength(0);
      expect(secondary.messages).toHaveLength(1);
    });

    it('aggregates results from the named transport', async () => {
      const results = await MakaioBus.broadcast(
        BroadcastSubjects.remoteRequest,
        { q: 'named' },
        { transports: ['broadcastPrimary'] },
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ nodeId: 'remote', payload: { output: 'from-transport' } });
    });
  });

  // -------------------------------------------------------------------------
  // 4. $meta.local subjects — never reach transports
  // -------------------------------------------------------------------------
  describe('$meta.local subjects', () => {
    it('does NOT dispatch to transports even when options.transports is undefined', async () => {
      await withCleanup(
        () =>
          MakaioBus.on(BroadcastSubjects.localRequest, (ctx) => {
            ctx.setResult({ output: 'local-only' });
          }),
        async () => {
          const results = await MakaioBus.broadcast(BroadcastSubjects.localRequest, { q: 'local-test' });

          // Transport must not receive the broadcast
          expect(primary.messages).toHaveLength(0);

          // Local handler still fires
          expect(results).toHaveLength(1);
          expect(results[0]?.payload).toEqual({ output: 'local-only' });
        },
      );
    });

    it('does NOT dispatch to transports when options.transports explicitly lists one', async () => {
      await withCleanup(
        () =>
          MakaioBus.on(BroadcastSubjects.localRequest, (ctx) => {
            ctx.setResult({ output: 'local-only' });
          }),
        async () => {
          const results = await MakaioBus.broadcast(
            BroadcastSubjects.localRequest,
            { q: 'local-test' },
            { transports: ['broadcastPrimary'] },
          );

          // $meta.local takes precedence — transport is bypassed
          expect(primary.messages).toHaveLength(0);
          expect(results).toHaveLength(1);
        },
      );
    });
  });
});
