/**
 * End-to-end encrypted WebSocket transport tests using real ws library.
 *
 * These tests verify E2E authenticated encryption between client and server
 * over real WebSocket connections:
 * - ECDH + ECDSA key exchange during handshake
 * - Client-side payload encryption via E2EClientTransport.send()
 * - Client-side response decryption via messageTransform (before correlation)
 * - Server receives encrypted messages on wire (verified)
 * - Encrypted event delivery through onReceive decryption path
 */

import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { ServerTransport } from '../server-transport.js';
import { createE2EClientTransport } from '../e2e-client-transport.js';
import { E2EAuth } from '../auth/e2e-auth.js';
import { generateSigningKeyPair, exportSigningPublicKey, importSigningPublicKey } from '../crypto/ecdsa.js';
import { encryptMessage, decryptMessage, type MaybeEncryptedMessage } from '../e2e-message-crypto.js';
import type { BusMessage, BusRequestMessage } from '@makaio/bus-core';
import { createTestServer, waitForMessageCount, waitForOpen } from './test-utils.js';

/**
 * Reinterpret a received BusMessage as a MaybeEncryptedMessage for wire-level assertions.
 *
 * The wire layer attaches `e2e` metadata at runtime after the TypeScript type boundary.
 * This helper contains the single necessary type boundary in one place.
 * @param msg - The bus message received from the transport layer
 * @returns The same object typed as MaybeEncryptedMessage
 */
function asEncrypted(msg: BusMessage): MaybeEncryptedMessage {
  // The transport attaches `e2e` at the wire level — the structural contract is
  // satisfied at runtime. MaybeEncryptedMessage is BusMessage & { e2e?: E2EMetadata },
  // so BusMessage widens to it with a single-hop cast.
  return msg as MaybeEncryptedMessage;
}

/**
 * Generate ECDSA signing keypairs for server and client,
 * plus E2EAuth instances configured with cross-peer key lookup.
 * @returns E2EAuth instances for both sides
 */
async function createE2EAuthPair(): Promise<{
  serverAuth: E2EAuth;
  clientAuth: E2EAuth;
}> {
  const serverSigningKeyPair = await generateSigningKeyPair(true);
  const clientSigningKeyPair = await generateSigningKeyPair(true);

  const serverSigningPub = await exportSigningPublicKey(serverSigningKeyPair.publicKey);
  const clientSigningPub = await exportSigningPublicKey(clientSigningKeyPair.publicKey);

  const serverAuth = new E2EAuth({
    signingKeyPair: serverSigningKeyPair,
    identityId: 'machine-1',
    getPeerSigningKey: async (peerId: string) => {
      if (peerId === 'device-1') return importSigningPublicKey(clientSigningPub);
      return null;
    },
    timeout: 5000,
  });

  const clientAuth = new E2EAuth({
    signingKeyPair: clientSigningKeyPair,
    identityId: 'device-1',
    peerId: 'machine-1',
    getPeerSigningKey: async (peerId: string) => {
      if (peerId === 'machine-1') return importSigningPublicKey(serverSigningPub);
      return null;
    },
    timeout: 5000,
  });

  return { serverAuth, clientAuth };
}

/**
 * Shared E2E transport fixture with guaranteed cleanup.
 * @param run - Test callback receiving connected server/client transports
 */
async function withE2EFixture(
  run: (fixture: {
    ws: WebSocket;
    port: number;
    serverTransport: ServerTransport;
    clientTransport: ReturnType<typeof createE2EClientTransport>;
    serverAuth: E2EAuth;
    clientAuth: E2EAuth;
  }) => Promise<void>,
): Promise<void> {
  const { serverAuth, clientAuth } = await createE2EAuthPair();
  const { wss, port } = await createTestServer();
  const serverTransport = new ServerTransport({ websocket: wss, auth: serverAuth });
  await serverTransport.connect();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let clientTransport: ReturnType<typeof createE2EClientTransport> | undefined;
  let ws: WebSocket | undefined;
  try {
    ws = new WebSocket(`ws://localhost:${port}`);
    await waitForOpen(ws);
    clientTransport = createE2EClientTransport({
      websocket: ws,
      e2eAuth: clientAuth,
    });
    await clientTransport.connect();

    await run({ ws, port, serverTransport, clientTransport, serverAuth, clientAuth });
  } finally {
    await clientTransport?.disconnect();
    await serverTransport.disconnect();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

describe('E2E encrypted transport', () => {
  it('full encrypted request/response over real WebSocket', async () => {
    const { serverAuth, clientAuth } = await createE2EAuthPair();

    const { wss, port } = await createTestServer();
    const serverTransport = new ServerTransport({ websocket: wss, auth: serverAuth });
    await serverTransport.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      await waitForOpen(ws);
      const clientTransport = createE2EClientTransport({
        websocket: ws,
        e2eAuth: clientAuth,
      });

      // E2E handshake (ECDH + ECDSA)
      await clientTransport.connect();

      // Both sides derive the same AES-256-GCM session key via ECDH
      const sessionKey = clientAuth.getSessionKey();
      expect(sessionKey).not.toBeNull();

      // Server handler: verify wire payload is encrypted, then decrypt,
      // process, and send an encrypted response.
      serverTransport.onReceive(async (msg) => {
        if (msg.type !== 'request') return;

        // ── wire-level assertion: payload is ciphertext, not cleartext ──
        const wire = asEncrypted(msg);
        expect(wire.e2e).toBeDefined();
        expect(wire.e2e!.v).toBe(1);
        expect(typeof (msg as BusRequestMessage).payload).toBe('string');

        // ── decrypt with same session key (proves ECDH key agreement) ──
        const clear = await decryptMessage(wire, sessionKey!);
        const payload = (clear as BusRequestMessage).payload as { question: string };
        expect(payload).toEqual({ question: 'meaning of life' });

        // ── respond with an *encrypted* response ──
        // Client-side messageTransform decrypts before correlation tracker
        const response: BusMessage = {
          type: 'response',
          correlationId: msg.correlationId,
          result: { answer: 42 },
        };
        const encrypted = await encryptMessage(response, sessionKey!);
        await serverTransport.send(encrypted);
      });

      // Client sends encrypted request; response is decrypted transparently
      const result = await clientTransport.send({
        type: 'request' as const,
        namespace: 'test',
        subject: 'e2e-query',
        payload: { question: 'meaning of life' },
        correlationId: 'corr-e2e-1',
        messageId: 'req-e2e-1',
      });

      // Full round-trip: encrypted request → decrypted on server → encrypted response → decrypted on client
      expect(result).toEqual({ answer: 42 });

      await clientTransport.disconnect();
      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }, 15000);

  it('decrypts server-initiated encrypted events through onReceive', async () => {
    const { serverAuth, clientAuth } = await createE2EAuthPair();

    const { wss, port } = await createTestServer();
    const serverTransport = new ServerTransport({ websocket: wss, auth: serverAuth });
    await serverTransport.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      await waitForOpen(ws);
      const clientTransport = createE2EClientTransport({
        websocket: ws,
        e2eAuth: clientAuth,
      });

      await clientTransport.connect();

      const sessionKey = clientAuth.getSessionKey()!;
      expect(sessionKey).not.toBeNull();

      // Collect decrypted events on client side
      const received: BusMessage[] = [];
      clientTransport.onReceive(async (msg) => {
        if (msg.type === 'event') received.push(msg);
      });

      // Server encrypts an event using the shared session key and sends
      const plainEvent: BusMessage = {
        type: 'event',
        namespace: 'test',
        subject: 'e2e-notification',
        payload: { secret: 'classified data' },
        messageId: 'evt-e2e-1',
      };
      const encryptedEvent = await encryptMessage(plainEvent, sessionKey);
      await serverTransport.send(encryptedEvent);

      // Client auto-decrypts via messageTransform
      await waitForMessageCount(() => received.length, 1);

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        type: 'event',
        namespace: 'test',
        subject: 'e2e-notification',
        payload: { secret: 'classified data' },
      });

      await clientTransport.disconnect();
      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }, 15000);

  it('rejects handshake when peer signing key is unknown', async () => {
    const serverSigningKeyPair = await generateSigningKeyPair(true);
    const clientSigningKeyPair = await generateSigningKeyPair(true);

    // Server does NOT know the client's signing key
    const serverAuth = new E2EAuth({
      signingKeyPair: serverSigningKeyPair,
      identityId: 'machine-1',
      getPeerSigningKey: async () => null,
      timeout: 3000,
    });

    const serverSigningPub = await exportSigningPublicKey(serverSigningKeyPair.publicKey);
    const clientAuth = new E2EAuth({
      signingKeyPair: clientSigningKeyPair,
      identityId: 'device-unknown',
      peerId: 'machine-1',
      getPeerSigningKey: async (peerId: string) => {
        if (peerId === 'machine-1') return importSigningPublicKey(serverSigningPub);
        return null;
      },
      timeout: 3000,
    });

    const { wss, port } = await createTestServer();
    const serverTransport = new ServerTransport({ websocket: wss, auth: serverAuth });
    await serverTransport.connect();

    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      await waitForOpen(ws);
      const clientTransport = createE2EClientTransport({
        websocket: ws,
        e2eAuth: clientAuth,
      });

      await expect(clientTransport.connect()).rejects.toThrow();

      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }, 15000);

  it('handles concurrent encrypted requests with encrypted responses', async () => {
    const { serverAuth, clientAuth } = await createE2EAuthPair();

    const { wss, port } = await createTestServer();
    const serverTransport = new ServerTransport({ websocket: wss, auth: serverAuth });
    await serverTransport.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      await waitForOpen(ws);
      const clientTransport = createE2EClientTransport({
        websocket: ws,
        e2eAuth: clientAuth,
      });

      await clientTransport.connect();

      const sessionKey = clientAuth.getSessionKey()!;

      // Server handler: decrypt request, encrypt response
      serverTransport.onReceive(async (msg) => {
        if (msg.type !== 'request') return;

        // Decrypt incoming
        const wire = asEncrypted(msg);
        const clear = await decryptMessage(wire, sessionKey);
        const payload = (clear as BusRequestMessage).payload as { id: number };

        // Encrypt outgoing response
        const response: BusMessage = {
          type: 'response',
          correlationId: msg.correlationId,
          result: { id: payload.id, doubled: payload.id * 2 },
        };
        const encrypted = await encryptMessage(response, sessionKey);
        await serverTransport.send(encrypted);
      });

      // 3 concurrent encrypted request/response round-trips
      const results = await Promise.all([
        clientTransport.send({
          type: 'request' as const,
          namespace: 'test',
          subject: 'concurrent',
          payload: { id: 7 },
          correlationId: 'corr-c1',
          messageId: 'req-c1',
        }),
        clientTransport.send({
          type: 'request' as const,
          namespace: 'test',
          subject: 'concurrent',
          payload: { id: 13 },
          correlationId: 'corr-c2',
          messageId: 'req-c2',
        }),
        clientTransport.send({
          type: 'request' as const,
          namespace: 'test',
          subject: 'concurrent',
          payload: { id: 21 },
          correlationId: 'corr-c3',
          messageId: 'req-c3',
        }),
      ]);

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ id: 7, doubled: 14 });
      expect(results[1]).toEqual({ id: 13, doubled: 26 });
      expect(results[2]).toEqual({ id: 21, doubled: 42 });

      await clientTransport.disconnect();
      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }, 15000);

  it('honors explicit request timeout through E2E transport wrapper', async () => {
    await withE2EFixture(async ({ clientTransport }) => {
      // No server handler is registered for requests, so this must time out.
      await expect(
        clientTransport.send(
          {
            type: 'request' as const,
            namespace: 'test',
            subject: 'no-response',
            payload: { value: 1 },
            correlationId: 'corr-timeout-forwarding',
            messageId: 'req-timeout-forwarding',
          },
          50,
        ),
      ).rejects.toThrow('timed out');
    });
  }, 15000);

  it('resolves dynamic subscription acknowledgements from a direct E2E server', async () => {
    await withE2EFixture(async ({ clientTransport }) => {
      await expect(clientTransport.subscribe('test.dynamic-e2e')).resolves.toBeUndefined();
    });
  }, 15000);

  it('clears the client session key when the E2E transport disconnects', async () => {
    await withE2EFixture(async ({ clientTransport, clientAuth }) => {
      expect(clientAuth.getSessionKey()).not.toBeNull();

      await clientTransport.disconnect();

      expect(clientAuth.getSessionKey()).toBeNull();
    });
  }, 15000);
});
