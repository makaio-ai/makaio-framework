/**
 * Relay E2E client transport tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { createE2ERelayClientTransport, createE2ERelayCodec } from '../e2e-relay-client-transport.js';
import { E2ERelayAuth } from '../auth/e2e-relay-auth.js';
import { generateSigningKeyPair } from '../crypto/ecdsa.js';
import { decryptRelayEnvelope, encryptRelayEnvelope, type RelayEnvelopeMessage } from '../e2e-relay-envelope.js';
import { createRelayControlRegistry } from '../relay-control-registry.js';
import { MockWebSocket, createRelayAuthPairRaw } from './test-helpers.js';
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
  const signingKeys = await generateSigningKeyPair();
  const e2eAuth = new E2ERelayAuth({
    signingKeyPair: signingKeys,
    identityId,
    getPeerSigningKey: async () => null,
    mode: 'responder',
    blocking: false,
  });
  return createE2ERelayCodec(e2eAuth, testRegistry).codec;
}

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
    // Use createRelayAuthPairRaw so we can manually drive the handshake: the
    // transport calls connect() which triggers authenticateClient(), and we
    // forward the key exchange messages between the two sides to allow both
    // sides to derive the same session key before subscribe/unsubscribe are sent.
    const { initiator, responder, sendToResponder } = await createRelayAuthPairRaw();

    // Wire up a MockWebSocket that relays auth messages between initiator and
    // responder in-process, simulating a relay server forwarding them.
    const ws = new MockWebSocket();
    const originalSend = ws.send.bind(ws);
    ws.send = (data: string | BufferSource | Blob): void => {
      originalSend(data);
      if (typeof data !== 'string') return;
      const msg = JSON.parse(data) as { type?: string };
      if (msg.type === 'e2e-relay-key-exchange') {
        // Forward initiator's key exchange to the responder so it can derive
        // the session key and send its own exchange back.
        sendToResponder(msg);
      }
    };

    // When responder sends its key exchange back, inject it into the transport's
    // inbound message pipeline so the initiator can derive the session key.
    const sendToInitiatorViaWs = (message: unknown): void => {
      ws.receiveMessage(JSON.stringify(message));
    };

    // Start both sides of the handshake concurrently.
    const responderAuth = responder.authenticateClient(sendToInitiatorViaWs);

    const transport = createE2ERelayClientTransport({ websocket: ws, e2eAuth: initiator, registry: testRegistry });
    await Promise.all([transport.connect(), responderAuth]);

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
