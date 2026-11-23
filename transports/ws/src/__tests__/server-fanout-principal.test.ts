import { describe, expect, it, vi } from 'vitest';
import { ServerTransport } from '../server-transport.js';
import type { TransportAuth } from '../types.js';
import { MockWebSocket, MockWebSocketServer } from './test-helpers.js';

const caller = { kind: 'test.client', id: 'sender' };
const applicationPrincipal = { kind: 'test.person', id: 'person' };
const forgedExtension = { kind: 'makaio.extension', id: 'forged' };
const forgedHost = { kind: 'makaio.host', id: 'forged' };

describe('ServerTransport fan-out principal', () => {
  it.each([
    { type: 'event', attests: false, claimed: applicationPrincipal, principal: caller },
    { type: 'broadcast', attests: false, claimed: applicationPrincipal, principal: caller },
    { type: 'event', attests: true, claimed: applicationPrincipal, principal: applicationPrincipal },
    { type: 'broadcast', attests: true, claimed: applicationPrincipal, principal: applicationPrincipal },
    { type: 'event', attests: false, claimed: forgedExtension, principal: caller },
    { type: 'broadcast', attests: false, claimed: forgedExtension, principal: caller },
    { type: 'event', attests: true, claimed: forgedHost, principal: caller },
    { type: 'broadcast', attests: true, claimed: forgedHost, principal: caller },
  ])('stamps a $type claiming $claimed.kind from a connection with inbound attestation $attests', async ({
    type,
    attests,
    claimed,
    principal,
  }) => {
    const sender = new MockWebSocket();
    const recipient = new MockWebSocket();
    const websocket = new MockWebSocketServer();
    const auth: TransportAuth = {
      authenticateClient: vi.fn().mockResolvedValue(undefined),
      authenticateServer: vi.fn().mockResolvedValue(undefined),
      handleAuthMessage: () => false,
      cleanupSocket: vi.fn(),
      cleanup: vi.fn(),
      getReceiveContext: (socket) => ({
        transportName: 'websocket',
        connectionId: socket === sender ? `sender-${type}-${attests}-${claimed.kind}` : 'recipient',
        authenticated: true,
        caller: socket === sender ? caller : { kind: 'test.client', id: 'recipient' },
        ...(socket === sender && attests ? { attests: 'inbound' } : {}),
      }),
    };
    const transport = new ServerTransport({ websocket, auth });

    await transport.connect();
    try {
      websocket.simulateConnection(sender);
      websocket.simulateConnection(recipient);
      await Promise.resolve();

      recipient.receiveMessage(
        JSON.stringify({ type: 'subscribe', subjects: { 'test.fanout': [100] }, ackId: 'subscribed' }),
      );
      await vi.waitFor(() => {
        expect(recipient.sentMessages.map((frame) => JSON.parse(frame))).toContainEqual({
          type: 'subscription-ack',
          ackId: 'subscribed',
        });
      });
      recipient.clearSentMessages();

      const message = {
        type,
        namespace: 'test',
        subject: 'fanout',
        messageId: 'fanout-message',
        correlationId: 'fanout-correlation',
        payload: { value: 1 },
        metadata: { principal: claimed },
      };
      sender.receiveMessage(JSON.stringify(message));

      expect(recipient.sentMessages.map((frame) => JSON.parse(frame))).toEqual([
        { ...message, metadata: { principal } },
      ]);
    } finally {
      await transport.disconnect();
    }
  });
});
