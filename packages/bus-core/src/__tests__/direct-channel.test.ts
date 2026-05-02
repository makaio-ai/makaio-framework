/**
 * Integration tests for the DirectChannel system.
 *
 * Covers the full end-to-end flow: ECDH handshake, encrypted request/response,
 * encrypted events, close propagation, once semantics, concurrent channels,
 * and encryption opacity.
 *
 * No mocking — all tests use real Web Crypto and real bus handlers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { createBusContext, createBusInstance, channelSubject } from '../index.js';
import { createChannelEndpoint, openChannel } from '../channel/channel-endpoint.js';
import type { MakaioBusContext } from '../types/bus.js';
import type { IDirectChannel } from '../channel/types.js';
import { ChannelClosedError } from '../errors/channel-closed-error.js';
import { ChannelAuthError } from '../errors/channel-auth-error.js';
import { NoHandlerError } from '../errors/no-handler-error.js';
import { RequestError } from '../errors/request-error.js';
import { createBidirectionalTransportPair } from './helpers/transport-fixtures.js';
import type { BusTransportKeys } from '../registries/transport-registry.js';
import type { AnyMessageContext } from '@makaio/core';

// ---------------------------------------------------------------------------
// Test namespace — channel-only subjects
// ---------------------------------------------------------------------------

/**
 * Register a private test namespace on a specific context.
 *
 * Each test uses an isolated context, so namespace registration is idempotent
 * per context and avoids cross-test pollution from the global MakaioBus.
 * @param context - Bus context to register the namespace on
 * @returns Typed subject definitions for the test suite
 */
function registerTestNamespace(context: MakaioBusContext) {
  return context.namespaceRegistry.registerNamespace('directChannelTest', {
    store: channelSubject({
      request: z.object({ key: z.string(), value: z.string() }),
      response: z.object({ stored: z.boolean() }),
    }),
    get: channelSubject({
      request: z.object({ key: z.string() }),
      response: z.object({ value: z.string().nullable() }),
    }),
    notify: channelSubject(z.object({ message: z.string() })),
  });
}

async function flushTransportSubscriptions(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('DirectChannel', () => {
  let context: MakaioBusContext;

  beforeEach(() => {
    context = createBusContext();
  });

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  // Test setup is intentionally inline rather than extracted into a shared helper —
  // each test varies the endpoint/channel configuration (token, transports, handlers)
  // and explicit setup makes the test's preconditions immediately visible.
  describe('handshake', () => {
    it('establishes a channel with a valid token', async () => {
      const token = 'test-token-123';

      const endpoint = createChannelEndpoint(context, 'testService', (_channel) => {}, { token });
      const channel = await openChannel(context, 'testService', { token });

      expect(channel.channelId).toBeDefined();
      expect(typeof channel.channelId).toBe('string');

      channel.close();
      endpoint.close();
    });

    it('rejects a wrong token — the bus wraps it in RequestError', async () => {
      const endpoint = createChannelEndpoint(context, 'testService', () => {}, { token: 'correct' });

      const rejection = await openChannel(context, 'testService', { token: 'wrong' }).catch((e) => e);
      expect(rejection).toBeInstanceOf(RequestError);
      expect((rejection as RequestError).cause).toBeInstanceOf(ChannelAuthError);

      endpoint.close();
    });

    it('throws for a non-existent endpoint (NoHandlerError via RequestError)', async () => {
      await expect(openChannel(context, 'nonExistent', { token: 'x' })).rejects.toThrow(NoHandlerError);
    });

    it('rolls back the channel when the endpoint callback throws', async () => {
      const endpoint = createChannelEndpoint(
        context,
        'callback-throw',
        () => {
          throw new Error('callback exploded');
        },
        { token: 'test-token' },
      );

      // The handshake fails because the callback threw — the error is wrapped in RequestError
      const rejection = await openChannel(context, 'callback-throw', { token: 'test-token' }).catch((e) => e);
      expect(rejection).toBeInstanceOf(RequestError);
      expect((rejection as RequestError).cause).toBeInstanceOf(Error);
      expect(((rejection as RequestError).cause as Error).message).toBe('callback exploded');

      endpoint.close();
    });
  });

  // -------------------------------------------------------------------------
  // Encrypted request-response
  // -------------------------------------------------------------------------

  describe('encrypted request-response', () => {
    it('sends encrypted requests and receives encrypted responses', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'test-token';
      const store = new Map<string, string>();

      const endpoint = createChannelEndpoint(
        context,
        'kv',
        (channel) => {
          channel.on(TestSubjects.store, (ctx) => {
            store.set(ctx.payload.key, ctx.payload.value);
            ctx.setResult({ stored: true });
          });
          channel.on(TestSubjects.get, (ctx) => {
            ctx.setResult({ value: store.get(ctx.payload.key) ?? null });
          });
        },
        { token },
      );

      const ch = await openChannel(context, 'kv', { token });

      const storeResult = await ch.request(TestSubjects.store, { key: 'foo', value: 'bar' });
      expect(storeResult.stored).toBe(true);

      const getResult = await ch.request(TestSubjects.get, { key: 'foo' });
      expect(getResult.value).toBe('bar');

      const missingResult = await ch.request(TestSubjects.get, { key: 'missing' });
      expect(missingResult.value).toBeNull();

      ch.close();
      endpoint.close();
    });

    it('routes the handshake and encrypted requests across transports', async () => {
      const clientContext = createBusContext();
      const serverContext = createBusContext();
      const clientBus = createBusInstance({ context: clientContext });
      const serverBus = createBusInstance({ context: serverContext });
      const { sideA, sideB } = createBidirectionalTransportPair({ label: 'direct-channel-transport' });
      clientBus.registerTransport(sideA);
      serverBus.registerTransport(sideB);

      const { subjects: TestSubjects } = registerTestNamespace(clientContext);
      const token = 'transport-token';
      const store = new Map<string, string>();

      const endpoint = createChannelEndpoint(
        serverContext,
        'transported-kv',
        (channel) => {
          channel.on(TestSubjects.store, (ctx) => {
            store.set(ctx.payload.key, ctx.payload.value);
            ctx.setResult({ stored: true });
          });
          channel.on(TestSubjects.get, (ctx) => {
            ctx.setResult({ value: store.get(ctx.payload.key) ?? null });
          });
        },
        { token },
      );

      await flushTransportSubscriptions();

      // Explicitly name the transport so the handshake and channel messages are
      // constrained to the pair transport. Callers that want cross-transport
      // channel opens must specify transports — the new openChannel default (no
      // transports option) uses advertised-handler routing only.
      const channel = await openChannel(clientContext, 'transported-kv', {
        token,
        transports: [sideA.name as BusTransportKeys],
      });

      const storeResult = await channel.request(TestSubjects.store, { key: 'alpha', value: 'beta' });
      expect(storeResult.stored).toBe(true);

      const getResult = await channel.request(TestSubjects.get, { key: 'alpha' });
      expect(getResult.value).toBe('beta');

      channel.close();
      endpoint.close();
      clientBus.disconnect();
      serverBus.disconnect();
    });
  });

  // -------------------------------------------------------------------------
  // Encrypted events
  // -------------------------------------------------------------------------

  describe('encrypted events', () => {
    it('delivers encrypted events to peer handler', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'test-token';
      const received: string[] = [];

      const endpoint = createChannelEndpoint(
        context,
        'events',
        (channel) => {
          channel.on(TestSubjects.notify, (ctx) => {
            received.push(ctx.payload.message);
          });
        },
        { token },
      );

      const ch = await openChannel(context, 'events', { token });
      await ch.emit(TestSubjects.notify, { message: 'hello' });
      await ch.emit(TestSubjects.notify, { message: 'world' });

      expect(received).toEqual(['hello', 'world']);

      ch.close();
      endpoint.close();
    });
  });

  // -------------------------------------------------------------------------
  // requestOptional
  // -------------------------------------------------------------------------

  describe('requestOptional', () => {
    it('returns handled: false when no handler is registered', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'test-token';

      const endpoint = createChannelEndpoint(context, 'optional', () => {}, { token });
      const ch = await openChannel(context, 'optional', { token });

      const result = await ch.requestOptional(TestSubjects.get, { key: 'missing' });
      expect(result.handled).toBe(false);

      ch.close();
      endpoint.close();
    });

    it('returns handled: true with data when handler is registered', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'test-token';

      const endpoint = createChannelEndpoint(
        context,
        'optional-present',
        (channel) => {
          channel.on(TestSubjects.get, (ctx) => {
            ctx.setResult({ value: 'found' });
          });
        },
        { token },
      );

      const ch = await openChannel(context, 'optional-present', { token });
      const result = await ch.requestOptional(TestSubjects.get, { key: 'any' });

      expect(result.handled).toBe(true);
      if (result.handled) {
        expect(result.data.value).toBe('found');
      }

      ch.close();
      endpoint.close();
    });
  });

  // -------------------------------------------------------------------------
  // Close and teardown
  // -------------------------------------------------------------------------

  describe('close and teardown', () => {
    it('throws ChannelClosedError after close()', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'test-token';

      const endpoint = createChannelEndpoint(context, 'close-test', () => {}, { token });
      const ch = await openChannel(context, 'close-test', { token });

      ch.close();

      // emit() is async — assertOpen() throws synchronously but the async wrapper
      // converts it to a rejected promise, so we must use rejects.toThrow.
      await expect(ch.emit(TestSubjects.notify, { message: 'test' })).rejects.toThrow(ChannelClosedError);

      // on() and once() are synchronous — they throw directly.
      expect(() => ch.on(TestSubjects.notify, () => {})).toThrow(ChannelClosedError);

      endpoint.close();
    });

    it('close() is idempotent — second call is a no-op', async () => {
      const token = 'test-token';

      const endpoint = createChannelEndpoint(context, 'idempotent-close', () => {}, { token });
      const ch = await openChannel(context, 'idempotent-close', { token });

      ch.close();
      expect(() => ch.close()).not.toThrow();

      endpoint.close();
    });

    it('peer close propagates to the other side', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'test-token';
      let serverChannel: IDirectChannel | null = null;

      const endpoint = createChannelEndpoint(
        context,
        'peer-close',
        (channel) => {
          serverChannel = channel;
        },
        { token },
      );

      const clientChannel = await openChannel(context, 'peer-close', { token });

      // Server closes — the $close event propagates to the client side
      serverChannel!.close();

      // Poll until the client channel reflects the closed state. The $close event
      // travels through the async crypto pipeline (encrypt → emit → decrypt) so
      // the propagation is not synchronous. vi.waitFor retries until the channel
      // throws ChannelClosedError, giving a deterministic signal without a fixed sleep.
      await vi.waitFor(
        async () => {
          await expect(clientChannel.emit(TestSubjects.notify, { message: 'test' })).rejects.toThrow(
            ChannelClosedError,
          );
        },
        { timeout: 1000 },
      );

      endpoint.close();
    });

    it('endpoint close() prevents new connections but existing channels survive', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'test-token';

      const endpoint = createChannelEndpoint(
        context,
        'endpoint-close',
        (channel) => {
          channel.on(TestSubjects.get, (ctx) => {
            ctx.setResult({ value: 'still-alive' });
          });
        },
        { token },
      );

      // Open a channel before closing the endpoint
      const existingChannel = await openChannel(context, 'endpoint-close', { token });

      // Close the endpoint — no more new connections
      endpoint.close();

      // Existing channel still works
      const result = await existingChannel.request(TestSubjects.get, { key: 'test' });
      expect(result.value).toBe('still-alive');

      // New connections fail (NoHandlerError because the handshake handler was removed)
      await expect(openChannel(context, 'endpoint-close', { token })).rejects.toThrow(NoHandlerError);

      existingChannel.close();
    });

    it('rejects pending requests with ChannelClosedError when the peer closes', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'pending-close-token';
      let serverChannel: IDirectChannel | null = null;
      let releaseHandler: (() => void) | null = null;
      const handlerStarted = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });

      const endpoint = createChannelEndpoint(
        context,
        'pending-close',
        (channel) => {
          serverChannel = channel;
          channel.on(TestSubjects.get, async (_ctx) => {
            releaseHandler?.();
            await new Promise<void>(() => {});
          });
        },
        { token },
      );

      const clientChannel = await openChannel(context, 'pending-close', { token });
      const pendingRequest = clientChannel.request(TestSubjects.get, { key: 'blocked' }, { timeout: 0 });

      await handlerStarted;
      serverChannel!.close();

      await expect(pendingRequest).rejects.toThrow(ChannelClosedError);

      clientChannel.close();
      endpoint.close();
    });
  });

  // -------------------------------------------------------------------------
  // once
  // -------------------------------------------------------------------------

  describe('once', () => {
    it('handler fires exactly once', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'test-token';
      let count = 0;

      const endpoint = createChannelEndpoint(
        context,
        'once-test',
        (channel) => {
          channel.once(TestSubjects.notify, () => {
            count++;
          });
        },
        { token },
      );

      const ch = await openChannel(context, 'once-test', { token });
      await ch.emit(TestSubjects.notify, { message: 'first' });
      await ch.emit(TestSubjects.notify, { message: 'second' });

      expect(count).toBe(1);

      ch.close();
      endpoint.close();
    });

    it('manual unsubscribe before first fire prevents handler from running', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'test-token';
      let count = 0;

      const endpoint = createChannelEndpoint(
        context,
        'once-unsub',
        (channel) => {
          const unsub = channel.once(TestSubjects.notify, () => {
            count++;
          });
          // Immediately unsubscribe before any event arrives
          unsub();
        },
        { token },
      );

      const ch = await openChannel(context, 'once-unsub', { token });
      await ch.emit(TestSubjects.notify, { message: 'hello' });

      expect(count).toBe(0);

      ch.close();
      endpoint.close();
    });
  });

  // -------------------------------------------------------------------------
  // Multiple concurrent channels
  // -------------------------------------------------------------------------

  describe('multiple concurrent channels', () => {
    it('two channels on the same endpoint have isolated state', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const token = 'test-token';

      const endpoint = createChannelEndpoint(
        context,
        'multi',
        (channel) => {
          const store = new Map<string, string>();
          channel.on(TestSubjects.store, (ctx) => {
            store.set(ctx.payload.key, ctx.payload.value);
            ctx.setResult({ stored: true });
          });
          channel.on(TestSubjects.get, (ctx) => {
            ctx.setResult({ value: store.get(ctx.payload.key) ?? null });
          });
        },
        { token },
      );

      const ch1 = await openChannel(context, 'multi', { token });
      const ch2 = await openChannel(context, 'multi', { token });

      await ch1.request(TestSubjects.store, { key: 'a', value: '1' });
      await ch2.request(TestSubjects.store, { key: 'a', value: '2' });

      const r1 = await ch1.request(TestSubjects.get, { key: 'a' });
      const r2 = await ch2.request(TestSubjects.get, { key: 'a' });

      // Each channel has its own store instance
      expect(r1.value).toBe('1');
      expect(r2.value).toBe('2');

      ch1.close();
      ch2.close();
      endpoint.close();
    });
  });

  // -------------------------------------------------------------------------
  // Encryption opacity
  // -------------------------------------------------------------------------

  describe('encryption opacity', () => {
    it('bus observers only see encrypted (iv+data) payloads for channel messages', async () => {
      const { subjects: TestSubjects } = registerTestNamespace(context);
      const observed: AnyMessageContext[] = [];

      // Wire up an __onAny observer on the shared context via a temporary bus instance
      // We access anyHandlers directly since __onAny lives on the bus instance, not context.
      // Use the context's anyHandlers set directly — same mechanism as bus.__onAny.
      const handler = (ctx: AnyMessageContext): void => {
        if (ctx.namespace.startsWith('channel:')) {
          observed.push(ctx);
        }
      };
      context.anyHandlers.add(handler);

      const token = 'test-token';
      const endpoint = createChannelEndpoint(
        context,
        'opacity',
        (channel) => {
          channel.on(TestSubjects.store, (ctx) => {
            ctx.setResult({ stored: true });
          });
        },
        { token },
      );

      const ch = await openChannel(context, 'opacity', { token });
      await ch.request(TestSubjects.store, { key: 'secret', value: 'password123' });

      // Cleanup observer before assertions
      context.anyHandlers.delete(handler);

      expect(observed.length).toBeGreaterThan(0);

      for (const ctx of observed) {
        const p = ctx.payload as Record<string, unknown>;
        // Every channel-scoped message must be an opaque encrypted envelope
        expect(p).toHaveProperty('iv');
        expect(p).toHaveProperty('data');
        expect(typeof p['iv']).toBe('string');
        expect(typeof p['data']).toBe('string');
        // The plaintext fields must NOT be visible
        expect(p).not.toHaveProperty('key');
        expect(p).not.toHaveProperty('value');
        expect(p).not.toHaveProperty('stored');
      }

      ch.close();
      endpoint.close();
    });
  });

  // -------------------------------------------------------------------------
  // Channel ID uniqueness
  // -------------------------------------------------------------------------

  describe('channel ID uniqueness', () => {
    it('two channels opened to the same endpoint receive distinct IDs', async () => {
      const token = 'test-token';

      const endpoint = createChannelEndpoint(context, 'id-test', () => {}, { token });
      const ch1 = await openChannel(context, 'id-test', { token });
      const ch2 = await openChannel(context, 'id-test', { token });

      expect(ch1.channelId).not.toBe(ch2.channelId);

      ch1.close();
      ch2.close();
      endpoint.close();
    });
  });
});
