/**
 * Relay E2E client transport tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  createBusInstance,
  type BusEventMessage,
  type BusMessage,
  type BusRequestMessage,
  type BusResponseMessage,
  type BusSubscribeMessage,
  type BusTransportRegistry,
  type BusUnsubscribeMessage,
} from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { createE2ERelayClientTransport, createE2ERelayCodec } from '../e2e-relay-client-transport.js';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { E2ERelayAuth } from '../auth/e2e-relay-auth.js';
import { generateSigningKeyPair } from '../crypto/ecdsa.js';
import {
  decryptRelayEnvelope,
  encryptRelayEnvelope,
  isRelayEnvelopeMessage,
  type RelayEnvelopeMessage,
} from '../e2e-relay-envelope.js';
import { type RelayControlEnvelopeMessage } from '../relay-control-envelope.js';
import { createRelayControlRegistry } from '../relay-control-registry.js';
import {
  MockWebSocket,
  connectRelayTransportWithSession,
  createPreSessionRelayAuth,
  createPreSessionRelayTransport,
  createRelayAuthPair,
  createRelayAuthPairRaw,
} from './test-helpers.js';
import { buildRelayControlTestRegistry, createRelayControlTestHelpers } from './relay-control-test-registry.js';
import { waitForCondition } from './test-utils.js';

const testRegistry = buildRelayControlTestRegistry();
const { createRelayControlEnvelope } = createRelayControlTestHelpers(testRegistry);

const EXPIRED_RELAY_CONTROL_RESPONSE_TTL_MS = 5 * 60 * 1000 + 1;

/**
 * Assert that a promise does not settle within a short observation window.
 * @param promise - Promise expected to remain pending
 * @param timeoutMs - Observation window in milliseconds
 */
async function expectStillPending(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  const result = await Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), timeoutMs)),
  ]);
  expect(result).toBe('pending');
}

/**
 * Create an unauthenticated relay codec for tests that exercise pre-session
 * relay-control routing.
 * @param identityId - Test identity for the auth instance
 * @returns Relay codec without a derived E2E session key
 */
async function createUnauthenticatedRelayCodec(
  identityId: string,
): Promise<ReturnType<typeof createE2ERelayCodec>['codec']> {
  const e2eAuth = await createPreSessionRelayAuth(identityId);
  return createE2ERelayCodec(e2eAuth, testRegistry).codec;
}

describe('createE2ERelayCodec — subscribe-sync-complete is unreachable', () => {
  // A relay-backed leg cannot resolve `ready` from the bus peer-sync handshake: the
  // codec refuses that frame in both session states, so `onSyncComplete` is never
  // reached. This is the evidence behind `readiness: 'session-established'` on every
  // relay-backed client transport; pinning it stops a revert to 'peer-sync' that would
  // leave `ready` pending for the connection's lifetime.
  const syncComplete = { type: 'subscribe-sync-complete' } as const;

  it('rejects the frame before an E2E session exists (not in the plaintext-allowed set)', async () => {
    const codec = await createUnauthenticatedRelayCodec('device-no-session');

    await expect(codec.decode(syncComplete)).rejects.toThrow('E2E relay session not established');
  });

  it('rejects the frame once an E2E session exists (plaintext on an encrypted channel)', async () => {
    const { initiator } = await createRelayAuthPair({ deviceId: 'device-sync', machineId: 'machine-sync' });
    const { codec } = createE2ERelayCodec(initiator, testRegistry);

    await expect(codec.decode(syncComplete)).rejects.toThrow(/plaintext message on relay E2E channel/);
  });

  it('refuses to encode the frame without a session, so no peer can ever receive it', async () => {
    const codec = await createUnauthenticatedRelayCodec('device-encode');

    // `subscribe` / `unsubscribe` / `subscription-ack` are the only frames allowed
    // through in the clear; the sync handshake is not among them.
    await expect(codec.encode(syncComplete as never)).rejects.toThrow('E2E relay session not established');
  });
});

describe('createE2ERelayClientTransport', () => {
  it('fails immediately when constructed with a mutable relay control registry', async () => {
    const signingKeys = await generateSigningKeyPair();
    const e2eAuth = new E2ERelayAuth({
      signingKeyPair: signingKeys,
      identityId: 'machine-mutable-registry',
      getPeerSigningKey: async () => null,
      mode: 'responder',
      blocking: false,
    });
    const registry = createRelayControlRegistry();
    registry.registerRequestNamespace('relay', ['oauth.refresh']);

    expect(() =>
      createE2ERelayClientTransport({
        websocket: new MockWebSocket(),
        e2eAuth,
        registry,
      }),
    ).toThrow(/frozen relay control registry/i);
  });

  it('encrypts subscribe and unsubscribe frames with relay envelope', async () => {
    const { transport, ws, initiator } = await connectRelayTransportWithSession(testRegistry);
    const sessionKey = initiator.getSessionKey();
    expect(sessionKey).not.toBeNull();

    ws.clearSentMessages();
    const subscribe = transport.subscribe('agent.started', { agentId: 'agent-1' });
    await waitForCondition(() => ws.sentMessages.length > 0, 1000, 'subscribe envelope was not sent');
    const subscribeEnvelope = JSON.parse(ws.sentMessages[0]) as RelayEnvelopeMessage;
    const subscribeMessage = await decryptRelayEnvelope(subscribeEnvelope, sessionKey!);
    expect(subscribeMessage.type).toBe('subscribe');
    if (subscribeMessage.type !== 'subscribe') {
      throw new Error('Expected encrypted subscribe message');
    }
    const subscribeAckId = subscribeMessage.ackId;
    expect(subscribeAckId).toEqual(expect.any(String));
    // Once the relay E2E session exists, plaintext subscription acks are
    // rejected as injection attempts and must not resolve the pending update.
    ws.receiveMessage(JSON.stringify({ type: 'subscription-ack', ackId: subscribeAckId }));
    await expectStillPending(subscribe, 20);
    ws.receiveMessage(
      JSON.stringify(await encryptRelayEnvelope({ type: 'subscription-ack', ackId: subscribeAckId! }, sessionKey!)),
    );
    await subscribe;

    const unsubscribe = transport.unsubscribe('agent.started');
    await waitForCondition(() => ws.sentMessages.length > 1, 1000, 'unsubscribe envelope was not sent');
    const unsubscribeEnvelope = JSON.parse(ws.sentMessages[1]) as RelayEnvelopeMessage;
    const unsubscribeMessage = await decryptRelayEnvelope(unsubscribeEnvelope, sessionKey!);
    expect(unsubscribeMessage.type).toBe('unsubscribe');
    if (unsubscribeMessage.type !== 'unsubscribe') {
      throw new Error('Expected encrypted unsubscribe message');
    }
    const unsubscribeAckId = unsubscribeMessage.ackId;
    expect(unsubscribeAckId).toEqual(expect.any(String));
    ws.receiveMessage(
      JSON.stringify(await encryptRelayEnvelope({ type: 'subscription-ack', ackId: unsubscribeAckId! }, sessionKey!)),
    );
    await unsubscribe;

    expect(ws.sentMessages).toHaveLength(2);

    expect(subscribeEnvelope.type).toBe('e2e-relay-envelope');

    expect(subscribeMessage).toEqual({
      type: 'subscribe',
      ackId: expect.any(String),
      subjects: { 'agent.started': [] },
      deliveryClasses: { 'agent.started': 'relayable' },
      filters: { 'agent.started': { agentId: 'agent-1' } },
    });

    expect(unsubscribeEnvelope.type).toBe('e2e-relay-envelope');

    expect(unsubscribeMessage).toEqual({
      type: 'unsubscribe',
      ackId: expect.any(String),
      subjects: { 'agent.started': [] },
    });
  });

  it('accepts relay control envelopes before session key is established', async () => {
    const signingKeys = await generateSigningKeyPair();
    const e2eAuth = new E2ERelayAuth({
      signingKeyPair: signingKeys,
      identityId: 'machine-control',
      getPeerSigningKey: async () => null,
      mode: 'responder',
      blocking: false,
    });

    const ws = new MockWebSocket();
    const transport = createE2ERelayClientTransport({ websocket: ws, e2eAuth, registry: testRegistry });

    const received = vi.fn();
    transport.onReceive(async (message) => {
      received(message);
    });

    await transport.connect();

    const envelope = createRelayControlEnvelope({
      type: 'event',
      subject: 'error',
      namespace: 'relay',
      payload: { code: 'connection_error', message: 'oops', timestamp: Date.now() },
      messageId: 'relay-ctrl-1',
    });

    ws.receiveMessage(JSON.stringify(envelope));

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'event',
        subject: 'error',
        namespace: 'relay',
      }),
    );
  });

  it('sends subscribe/unsubscribe in plaintext before session key is established', async () => {
    const signingKeys = await generateSigningKeyPair();
    const e2eAuth = new E2ERelayAuth({
      signingKeyPair: signingKeys,
      identityId: 'machine-subscriptions',
      getPeerSigningKey: async () => null,
      mode: 'responder',
      blocking: false,
    });

    const ws = new MockWebSocket();
    const transport = createE2ERelayClientTransport({ websocket: ws, e2eAuth, registry: testRegistry });

    await transport.connect();
    const subscribe = transport.subscribe('relay.error');
    await waitForCondition(() => ws.sentMessages.length > 0, 1000, 'subscribe message was not sent');
    const subscribeMessage = JSON.parse(ws.sentMessages[0]) as { ackId?: string };
    ws.receiveMessage(JSON.stringify({ type: 'subscription-ack', ackId: subscribeMessage.ackId }));
    await subscribe;
    const unsubscribe = transport.unsubscribe('relay.error');
    await waitForCondition(() => ws.sentMessages.length > 1, 1000, 'unsubscribe message was not sent');
    const unsubscribeMessage = JSON.parse(ws.sentMessages[1]) as { ackId?: string };
    ws.receiveMessage(JSON.stringify({ type: 'subscription-ack', ackId: unsubscribeMessage.ackId }));
    await unsubscribe;

    expect(ws.sentMessages).toHaveLength(2);
    expect(JSON.parse(ws.sentMessages[0])).toEqual({
      type: 'subscribe',
      ackId: expect.any(String),
      subjects: { 'relay.error': [] },
      deliveryClasses: { 'relay.error': 'relayable' },
    });
    expect(JSON.parse(ws.sentMessages[1])).toEqual({
      type: 'unsubscribe',
      ackId: expect.any(String),
      subjects: { 'relay.error': [] },
    });
  });

  it('encodes subscription acknowledgements as plaintext only before the E2E session exists', async () => {
    const codec = await createUnauthenticatedRelayCodec('machine-pre-session-ack');

    await expect(codec.encode({ type: 'subscription-ack', ackId: 'ack-before-session' })).resolves.toBe(
      JSON.stringify({ type: 'subscription-ack', ackId: 'ack-before-session' }),
    );
  });

  it('ignores plaintext relay events before session key is established', async () => {
    const signingKeys = await generateSigningKeyPair();
    const e2eAuth = new E2ERelayAuth({
      signingKeyPair: signingKeys,
      identityId: 'machine-plaintext',
      getPeerSigningKey: async () => null,
      mode: 'responder',
      blocking: false,
    });

    const ws = new MockWebSocket();
    const transport = createE2ERelayClientTransport({ websocket: ws, e2eAuth, registry: testRegistry });

    const received = vi.fn();
    transport.onReceive(async (message) => {
      received(message);
    });

    await transport.connect();

    ws.receiveMessage(
      JSON.stringify({
        type: 'event',
        subject: 'error',
        namespace: 'relay',
        payload: { code: 'connection_error', message: 'oops', timestamp: Date.now() },
        messageId: 'relay-plain-1',
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).not.toHaveBeenCalled();
  });

  it('sends tunnel control requests as relay-control and accepts plaintext responses', async () => {
    const signingKeys = await generateSigningKeyPair();
    const e2eAuth = new E2ERelayAuth({
      signingKeyPair: signingKeys,
      identityId: 'machine-tunnel',
      getPeerSigningKey: async () => null,
      mode: 'responder',
      blocking: false,
    });
    const ws = new MockWebSocket();
    const transport = createE2ERelayClientTransport({ websocket: ws, e2eAuth, registry: testRegistry });

    await transport.connect();

    const request = {
      type: 'request',
      subject: 'register',
      namespace: 'tunnel',
      payload: { targetPort: 3000, targetHost: '127.0.0.1' },
      correlationId: 'corr-tunnel-1',
      messageId: 'msg-tunnel-1',
    } as const;

    const responsePromise = transport.send(request);
    await new Promise((resolve) => setImmediate(resolve));

    expect(ws.sentMessages).toHaveLength(1);
    const sent = JSON.parse(ws.sentMessages[0]) as { type?: string; payload?: unknown };
    expect(sent.type).toBe('relay-control');
    expect(sent.payload).toMatchObject({
      type: 'request',
      subject: 'register',
      namespace: 'tunnel',
      correlationId: 'corr-tunnel-1',
    });

    ws.receiveMessage(
      JSON.stringify({
        type: 'response',
        correlationId: 'corr-tunnel-1',
        result: { success: true, subdomain: 'dev-123' },
      }),
    );

    await expect(responsePromise).resolves.toEqual({ success: true, subdomain: 'dev-123' });
  });

  it('rejects expired plaintext relay-control responses during decode', async () => {
    vi.useFakeTimers();
    try {
      const codec = await createUnauthenticatedRelayCodec('machine-expired-decode');

      await codec.decode(
        createRelayControlEnvelope({
          type: 'request',
          subject: 'register',
          namespace: 'tunnel',
          payload: { targetPort: 3000, targetHost: '127.0.0.1' },
          correlationId: 'corr-expired-decode',
          messageId: 'msg-expired-decode',
        }),
      );
      vi.advanceTimersByTime(EXPIRED_RELAY_CONTROL_RESPONSE_TTL_MS);

      await expect(
        codec.decode({
          type: 'response',
          correlationId: 'corr-expired-decode',
          result: { success: true },
        }),
      ).rejects.toThrow('E2E relay session not established');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects expired plaintext relay-control responses during encode', async () => {
    vi.useFakeTimers();
    try {
      const codec = await createUnauthenticatedRelayCodec('machine-expired-encode');

      await codec.encode({
        type: 'request',
        subject: 'register',
        namespace: 'tunnel',
        payload: { targetPort: 3000, targetHost: '127.0.0.1' },
        correlationId: 'corr-expired-encode',
        messageId: 'msg-expired-encode',
      });
      vi.advanceTimersByTime(EXPIRED_RELAY_CONTROL_RESPONSE_TTL_MS);

      await expect(
        codec.encode({
          type: 'response',
          correlationId: 'corr-expired-encode',
          result: { success: true },
        }),
      ).rejects.toThrow('E2E relay session not established');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends tunnel share requests as relay-control envelopes', async () => {
    const signingKeys = await generateSigningKeyPair();
    const e2eAuth = new E2ERelayAuth({
      signingKeyPair: signingKeys,
      identityId: 'machine-share',
      getPeerSigningKey: async () => null,
      mode: 'responder',
      blocking: false,
    });
    const ws = new MockWebSocket();
    const transport = createE2ERelayClientTransport({ websocket: ws, e2eAuth, registry: testRegistry });

    await transport.connect();

    const request = {
      type: 'request',
      subject: 'share.create',
      namespace: 'tunnel',
      payload: { tunnelId: 'tunnel-123' },
      correlationId: 'corr-share-1',
      messageId: 'msg-share-1',
    } as const;

    const responsePromise = transport.send(request);
    await new Promise((resolve) => setImmediate(resolve));

    expect(ws.sentMessages).toHaveLength(1);
    const sent = JSON.parse(ws.sentMessages[0]) as { type?: string; payload?: unknown };
    expect(sent.type).toBe('relay-control');
    expect(sent.payload).toMatchObject({
      type: 'request',
      subject: 'share.create',
      namespace: 'tunnel',
      correlationId: 'corr-share-1',
    });

    ws.receiveMessage(
      JSON.stringify({
        type: 'response',
        correlationId: 'corr-share-1',
        result: { shareId: 'share-123', url: 'https://relay.example/share-123' },
      }),
    );

    await expect(responsePromise).resolves.toEqual({
      shareId: 'share-123',
      url: 'https://relay.example/share-123',
    });
  });

  it('sends device relay.verify requests as relay-control envelopes', async () => {
    const signingKeys = await generateSigningKeyPair();
    const e2eAuth = new E2ERelayAuth({
      signingKeyPair: signingKeys,
      identityId: 'machine-device',
      getPeerSigningKey: async () => null,
      mode: 'responder',
      blocking: false,
    });
    const ws = new MockWebSocket();
    const transport = createE2ERelayClientTransport({ websocket: ws, e2eAuth, registry: testRegistry });

    await transport.connect();

    const request = {
      type: 'request',
      subject: 'relay.verify',
      namespace: 'device',
      payload: {
        deviceId: 'device-123',
        signature: 'sig',
        timestamp: Date.now(),
        machineId: 'machine-device',
      },
      correlationId: 'corr-device-1',
      messageId: 'msg-device-1',
    } as const;

    const responsePromise = transport.send(request);
    await new Promise((resolve) => setImmediate(resolve));

    expect(ws.sentMessages).toHaveLength(1);
    const sent = JSON.parse(ws.sentMessages[0]) as { type?: string; payload?: unknown };
    expect(sent.type).toBe('relay-control');
    expect(sent.payload).toMatchObject({
      type: 'request',
      subject: 'relay.verify',
      namespace: 'device',
      correlationId: 'corr-device-1',
    });

    ws.receiveMessage(
      JSON.stringify({
        type: 'response',
        correlationId: 'corr-device-1',
        result: { authorized: true },
      }),
    );

    await expect(responsePromise).resolves.toEqual({ authorized: true });
  });

  it('sends relay oauth.refresh requests as relay-control envelopes', async () => {
    const signingKeys = await generateSigningKeyPair();
    const e2eAuth = new E2ERelayAuth({
      signingKeyPair: signingKeys,
      identityId: 'machine-oauth-refresh',
      getPeerSigningKey: async () => null,
      mode: 'responder',
      blocking: false,
    });
    const ws = new MockWebSocket();
    const transport = createE2ERelayClientTransport({ websocket: ws, e2eAuth, registry: testRegistry });

    await transport.connect();

    const request = {
      type: 'request',
      subject: 'oauth.refresh',
      namespace: 'relay',
      payload: {
        provider: 'github',
        refreshToken: 'refresh-token',
        account: 'default',
      },
      correlationId: 'corr-oauth-refresh-1',
      messageId: 'msg-oauth-refresh-1',
    } as const;

    const responsePromise = transport.send(request);
    await new Promise((resolve) => setImmediate(resolve));

    expect(ws.sentMessages).toHaveLength(1);
    const sent = JSON.parse(ws.sentMessages[0]) as { type?: string; payload?: unknown };
    expect(sent.type).toBe('relay-control');
    expect(sent.payload).toMatchObject({
      type: 'request',
      subject: 'oauth.refresh',
      namespace: 'relay',
      correlationId: 'corr-oauth-refresh-1',
    });

    ws.receiveMessage(
      JSON.stringify({
        type: 'response',
        correlationId: 'corr-oauth-refresh-1',
        result: {
          success: true,
          token: {
            accessToken: 'new-token',
          },
        },
      }),
    );

    await expect(responsePromise).resolves.toEqual({
      success: true,
      token: {
        accessToken: 'new-token',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// createE2ERelayCodec — canEncode (message-selective gate)
// ---------------------------------------------------------------------------

describe('createE2ERelayCodec — canEncode', () => {
  it('returns true for a relay-control event before session key is established', async () => {
    const codec = await createUnauthenticatedRelayCodec('device-canEncode-ctrl');
    // relay.error is registered as a control event in testRegistry.
    const relayControlEvent: BusEventMessage = {
      type: 'event',
      subject: 'error',
      namespace: 'relay',
      payload: { code: 'conn_err', message: 'oops', timestamp: 0 },
      messageId: 'msg-ctrl-1',
    };
    expect(codec.canEncode?.(relayControlEvent)).toBe(true);
  });

  it('returns false for a normal event before session, true after session', async () => {
    const normalEvent: BusEventMessage = {
      type: 'event',
      subject: 'some.event',
      namespace: 'app',
      payload: {},
      messageId: 'msg-normal-1',
    };
    const preSess = await createUnauthenticatedRelayCodec('device-canEncode-normal-pre');
    expect(preSess.canEncode?.(normalEvent)).toBe(false);

    const { initiator } = await createRelayAuthPair({
      deviceId: 'device-canEncode-normal-post',
      machineId: 'machine-canEncode-normal',
    });
    const { codec: postSessCodec } = createE2ERelayCodec(initiator, testRegistry);
    expect(initiator.getSessionKey()).not.toBeNull();
    expect(postSessCodec.canEncode?.(normalEvent)).toBe(true);
  });

  it('returns true for subscription-control frames before session key is established', async () => {
    const codec = await createUnauthenticatedRelayCodec('device-canEncode-sub-ctrl');
    const subscribeMsg: BusSubscribeMessage = {
      type: 'subscribe',
      subjects: { 'test.subject': [] },
      deliveryClasses: { 'test.subject': 'relayable' },
    };
    const unsubscribeMsg: BusUnsubscribeMessage = {
      type: 'unsubscribe',
      subjects: { 'test.subject': [] },
    };
    expect(codec.canEncode?.(subscribeMsg)).toBe(true);
    expect(codec.canEncode?.(unsubscribeMsg)).toBe(true);
  });

  it('returns true for tracked relay-control response IDs without consuming the ID', async () => {
    // canEncode must not call .delete() on the tracked-ID map — only encode() may.
    const e2eAuth = await createPreSessionRelayAuth('device-canEncode-resp-track');
    const { codec } = createE2ERelayCodec(e2eAuth, testRegistry);

    const relayRequest: BusRequestMessage = {
      type: 'request',
      subject: 'oauth.refresh',
      namespace: 'relay',
      payload: {},
      correlationId: 'corr-track-123',
      messageId: 'msg-req-track',
    };
    // Encode the request so its correlation ID is tracked.
    await codec.encode(relayRequest);

    const responseMsg: BusResponseMessage = {
      type: 'response',
      correlationId: 'corr-track-123',
      result: { ok: true },
    };

    // canEncode returns true — and does NOT consume the ID (checked twice).
    expect(codec.canEncode?.(responseMsg)).toBe(true);
    expect(codec.canEncode?.(responseMsg)).toBe(true);

    // encode() consumes the ID; a subsequent canEncode() returns false.
    await codec.encode(responseMsg);
    expect(codec.canEncode?.(responseMsg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createE2ERelayClientTransport — isReady and canSend
// ---------------------------------------------------------------------------

describe('createE2ERelayClientTransport — isReady and canSend', () => {
  it('isReady returns true when wire session is live (wire-session only, not codec)', async () => {
    // Non-blocking responder mode: authenticateClient() returns immediately
    // without waiting for a peer key exchange, so connect() resolves with
    // authComplete=true but getSessionKey()=null.
    const { transport, e2eAuth } = await createPreSessionRelayTransport(testRegistry, {
      identityId: 'machine-pre-session-isReady',
    });

    // Wire session is live (socket open + auth complete) — isReady reflects that.
    expect(e2eAuth.getSessionKey()).toBeNull();
    expect(transport.isReady?.()).toBe(true);

    await transport.disconnect();
  });

  it('canSend returns false for a normal event before E2E session, true after', async () => {
    const normalEvent: BusEventMessage = {
      type: 'event',
      subject: 'some.event',
      namespace: 'app',
      payload: {},
      messageId: 'msg-cansend-normal',
    };

    const { transport: preTransport, e2eAuth } = await createPreSessionRelayTransport(testRegistry, {
      identityId: 'machine-canSend-normal-pre',
    });

    expect(e2eAuth.getSessionKey()).toBeNull();
    expect(preTransport.canSend?.(normalEvent)).toBe(false);

    await preTransport.disconnect();

    const { transport: postTransport, initiator } = await connectRelayTransportWithSession(testRegistry);
    expect(initiator.getSessionKey()).not.toBeNull();
    expect(postTransport.canSend?.(normalEvent)).toBe(true);

    await postTransport.disconnect();
  });

  it('canSend returns true for a relay-control event before E2E session', async () => {
    const { transport, e2eAuth } = await createPreSessionRelayTransport(testRegistry, {
      identityId: 'machine-canSend-ctrl-pre',
    });

    // relay.error is a control event in testRegistry — canSend is true even pre-session.
    const relayControlEvent: BusEventMessage = {
      type: 'event',
      subject: 'error',
      namespace: 'relay',
      payload: { code: 'conn_err', message: 'oops', timestamp: 0 },
      messageId: 'msg-ctrl-cansend',
    };

    expect(e2eAuth.getSessionKey()).toBeNull();
    expect(transport.canSend?.(relayControlEvent)).toBe(true);

    await transport.disconnect();
  });

  it('isReady returns true once the E2E session is established', async () => {
    const { transport, initiator } = await connectRelayTransportWithSession(testRegistry);

    expect(initiator.getSessionKey()).not.toBeNull();
    expect(transport.isReady?.()).toBe(true);

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Integration: emit skips pre-session relay transport (regression: issue #1372)
// ---------------------------------------------------------------------------

const relayReadinessNamespace = createBusNamespace('e2eRelayReadiness', {
  testEvent: z.object({ value: z.string() }),
});

// Bus namespace whose subject maps to a relay-control event in testRegistry:
// namespace='relay', subject='error'. The codec routes this as a plaintext
// relay-control envelope regardless of E2E session state.
const relayControlTestNamespace = createBusNamespace('relay', {
  error: z.object({ code: z.string(), message: z.string(), timestamp: z.number() }),
});

describe('E2E relay transport — emit integration (issue #1372)', () => {
  it(
    'bus.emit skips normal events pre-session, delivers relay-control events as plaintext,' +
      ' and sends normal events encrypted post-session',
    async () => {
      // Fresh bus instance so registration is isolated and the singleton stays clean.
      const bus = createBusInstance();
      bus.registerNamespace(relayReadinessNamespace);
      bus.registerNamespace(relayControlTestNamespace);
      const { registerTransport } = bus.getContext().transportRegistry;

      // -----------------------------------------------------------------------
      // Phase 1: pre-session — plain WebSocketClientTransport composition (the
      // product composition path that regressed in issue #1372). The transport
      // is connected and auth has completed but the E2E codec has no session key.
      // Normal events must be skipped; relay-control events must flow as plaintext.
      // -----------------------------------------------------------------------
      const e2eAuth = await createPreSessionRelayAuth('machine-emit-pre-session');
      const ws = new MockWebSocket();
      const { codec } = createE2ERelayCodec(e2eAuth, testRegistry);
      const preSessionTransport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        createWebSocket: () => ws,
        auth: e2eAuth,
        codec,
        autoReconnect: false,
      });
      await preSessionTransport.connect();

      // e2eAuth is in non-blocking responder mode: session key is still null.
      expect(e2eAuth.getSessionKey()).toBeNull();
      // isReady is wire-session only — true once socket is open + auth complete.
      expect(preSessionTransport.isReady()).toBe(true);
      // canSend is message-selective — false for normal events without a session key.
      const normalTestEvent: BusEventMessage = {
        type: 'event',
        subject: relayReadinessNamespace.subjects.testEvent.subject,
        namespace: 'e2eRelayReadiness',
        payload: { value: 'x' },
        messageId: 'pre-check',
      };
      expect(preSessionTransport.canSend(normalTestEvent)).toBe(false);

      const { unregister: unregisterPre } = registerTransport(
        'relay' as keyof BusTransportRegistry,
        preSessionTransport,
      );

      // Spy before emit: if codec.encode were reached for a normal event it
      // would throw and the bus catch block would call console.error.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      ws.clearSentMessages();

      await bus.emit(relayReadinessNamespace.subjects.testEvent, { value: 'pre-session' });

      // Normal event was excluded by canSend — console.error must be silent and no wire frame.
      expect(errorSpy).not.toHaveBeenCalled();
      expect(ws.sentMessages).toHaveLength(0);
      errorSpy.mockRestore();

      // -----------------------------------------------------------------------
      // Phase 1.5: relay-control event pre-session — must reach the wire as a
      // plaintext relay-control envelope (the core regression fix for #1372).
      // relay.error is registered in testRegistry as a control event subject.
      // -----------------------------------------------------------------------
      ws.clearSentMessages();
      await bus.emit(relayControlTestNamespace.subjects.error, {
        code: 'connection_error',
        message: 'relay down',
        timestamp: Date.now(),
      });

      // The relay-control event must appear on the wire as a plaintext envelope.
      expect(ws.sentMessages).toHaveLength(1);
      const relayControlWireMsg = JSON.parse(ws.sentMessages[0]) as RelayControlEnvelopeMessage;
      expect(relayControlWireMsg.type).toBe('relay-control');
      expect(relayControlWireMsg.payload.type).toBe('event');
      if (relayControlWireMsg.payload.type === 'event') {
        expect(relayControlWireMsg.payload.subject).toBe('error');
        expect(relayControlWireMsg.payload.namespace).toBe('relay');
      }

      unregisterPre();
      await preSessionTransport.disconnect();

      // -----------------------------------------------------------------------
      // Phase 2: session established — same WebSocketClientTransport + codec
      // composition as Phase 1 (the product path that regressed in #1372).
      // Transport must now be included and the encrypted event envelope must
      // appear on the wire.
      // -----------------------------------------------------------------------
      const {
        initiator: sessionInitiator,
        responder: sessionResponder,
        sendToResponder: sendToSessionResponder,
      } = await createRelayAuthPairRaw({ machineId: 'machine-emit-session' });

      const sessionWs = new MockWebSocket();
      const { codec: sessionCodec } = createE2ERelayCodec(sessionInitiator, testRegistry);

      // Forward key-exchange frames from the transport to the responder.
      const originalSessionSend = sessionWs.send.bind(sessionWs);
      sessionWs.send = (data: string | BufferSource | Blob): void => {
        originalSessionSend(data);
        if (typeof data !== 'string') return;
        const msg = JSON.parse(data) as { type?: string };
        if (msg.type === 'e2e-relay-key-exchange') sendToSessionResponder(msg);
      };

      const sessionResponderPromise = sessionResponder.authenticateClient((msg: unknown): void => {
        sessionWs.receiveMessage(JSON.stringify(msg));
      });

      const sessionTransport = new WebSocketClientTransport({
        url: 'ws://localhost:9999',
        createWebSocket: () => sessionWs,
        auth: sessionInitiator,
        codec: sessionCodec,
        autoReconnect: false,
      });

      await Promise.all([sessionTransport.connect(), sessionResponderPromise]);

      const { unregister: unregisterSession } = registerTransport(
        'relay' as keyof BusTransportRegistry,
        sessionTransport,
      );

      sessionWs.clearSentMessages();
      await bus.emit(relayReadinessNamespace.subjects.testEvent, { value: 'post-session' });

      // Locate the encrypted event frame by decrypting each wire message and
      // filtering for the event — avoids assuming positional indexing.
      expect(sessionWs.sentMessages.length).toBeGreaterThan(0);
      const sessionKey = sessionInitiator.getSessionKey();
      expect(sessionKey).not.toBeNull();
      if (sessionKey === null) throw new Error('Expected established session key after handshake');

      let decryptedEvent: BusMessage | undefined;
      for (const raw of sessionWs.sentMessages) {
        const parsed: unknown = JSON.parse(raw);
        if (!isRelayEnvelopeMessage(parsed)) continue;
        const frame = await decryptRelayEnvelope(parsed, sessionKey);
        if (frame.type === 'event') {
          decryptedEvent = frame;
          break;
        }
      }
      expect(decryptedEvent).toBeDefined();
      if (decryptedEvent === undefined) throw new Error('Expected encrypted event frame on wire');
      expect(decryptedEvent.type).toBe('event');
      if (decryptedEvent.type !== 'event') throw new Error('Expected event message from relay wire');
      expect(decryptedEvent.subject).toBe(relayReadinessNamespace.subjects.testEvent.subject);

      unregisterSession();
      await sessionTransport.disconnect();
    },
  );
});
