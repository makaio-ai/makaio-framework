/**
 * E2EAuth handshake tests.
 *
 * Validates peer identity verification and shared session key derivation.
 */

import { describe, it, expect } from 'vitest';
import { E2EAuth } from '../auth/e2e-auth.js';
import { generateSigningKeyPair } from '../crypto/ecdsa.js';
import type { WebSocketLike } from '../types.js';
import { encryptMessage, decryptMessage } from '../e2e-message-crypto.js';

describe('E2EAuth', () => {
  it('derives the same session key on client and server', async () => {
    const deviceId = 'device-1';
    const machineId = 'machine-1';

    const clientSigningKeys = await generateSigningKeyPair();
    const serverSigningKeys = await generateSigningKeyPair();

    const clientAuth = new E2EAuth({
      signingKeyPair: clientSigningKeys,
      identityId: deviceId,
      peerId: machineId,
      getPeerSigningKey: async (peerId) => (peerId === machineId ? serverSigningKeys.publicKey : null),
    });

    const serverAuth = new E2EAuth({
      signingKeyPair: serverSigningKeys,
      identityId: machineId,
      getPeerSigningKey: async (peerId) => (peerId === deviceId ? clientSigningKeys.publicKey : null),
    });

    const socket = {} as WebSocketLike;

    const sendToServer = (message: unknown): void => {
      serverAuth.handleAuthMessage(message, socket);
    };

    const sendToClient = (message: unknown): void => {
      clientAuth.handleAuthMessage(message);
    };

    const serverPromise = serverAuth.authenticateServer(socket, sendToClient);
    const clientPromise = clientAuth.authenticateClient(sendToServer);

    await Promise.all([serverPromise, clientPromise]);

    const clientKey = clientAuth.getSessionKey();
    const serverKey = serverAuth.getSessionKey(socket);

    expect(clientKey).not.toBeNull();
    expect(serverKey).not.toBeNull();
    expect(clientAuth.getPeerId()).toBe(machineId);
    expect(serverAuth.getPeerId(socket)).toBe(deviceId);

    const message = {
      type: 'request',
      subject: 'test.request',
      namespace: 'test',
      payload: { hello: 'world' },
      correlationId: 'corr-1',
      messageId: 'msg-1',
    } as const;

    const encrypted = await encryptMessage(message, clientKey!);
    const decrypted = await decryptMessage(encrypted, serverKey!);

    expect(decrypted).toEqual(message);
  });
});
