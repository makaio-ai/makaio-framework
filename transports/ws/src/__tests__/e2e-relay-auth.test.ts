/**
 * E2ERelayAuth handshake tests.
 *
 * Validates relay-mode peer exchange sequencing and session key derivation.
 */

import { describe, it, expect } from 'vitest';
import { encryptMessage, decryptMessage } from '../e2e-message-crypto.js';
import { E2ERelayAuth } from '../auth/e2e-relay-auth.js';
import { generateSigningKeyPair } from '../crypto/ecdsa.js';
import { createRelayAuthPair, createRelayAuthPairRaw } from './test-helpers.js';

/**
 * Wait until a private auth field reaches a non-undefined value.
 * @param auth - Auth instance under observation
 * @param field - Private field name to poll
 * @returns Field value once available
 */
async function waitForPrivateField<T>(auth: E2ERelayAuth, field: string): Promise<T> {
  const timeoutAt = Date.now() + 5_000;
  while (Date.now() < timeoutAt) {
    const value = Reflect.get(auth, field) as T | undefined;
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for E2ERelayAuth.${field}`);
}

describe('E2ERelayAuth', () => {
  it('derives matching session keys for initiator/responder', async () => {
    const { initiator, responder } = await createRelayAuthPair({
      deviceId: 'device-1',
      machineId: 'machine-1',
    });

    const initiatorKey = initiator.getSessionKey();
    const responderKey = responder.getSessionKey();

    expect(initiatorKey).not.toBeNull();
    expect(responderKey).not.toBeNull();
    expect(initiator.getPeerId()).toBe('machine-1');
    expect(responder.getPeerId()).toBe('device-1');

    const message = {
      type: 'event',
      subject: 'test.event',
      namespace: 'test',
      payload: { hello: 'relay' },
      correlationId: 'corr-1',
      messageId: 'msg-1',
    } as const;

    const encrypted = await encryptMessage(message, initiatorKey!);
    const decrypted = await decryptMessage(encrypted, responderKey!);

    expect(decrypted).toEqual(message);
  });

  it('handles peer exchange before responder authenticateClient', async () => {
    const { initiator, responder, sendToResponder, sendToInitiator } = await createRelayAuthPairRaw({
      deviceId: 'device-2',
      machineId: 'machine-2',
    });

    const initiatorPromise = initiator.authenticateClient(sendToResponder);

    await new Promise((resolve) => setTimeout(resolve, 0));

    await responder.authenticateClient(sendToInitiator);

    await initiatorPromise;

    expect(initiator.getSessionKey()).not.toBeNull();
    expect(responder.getSessionKey()).not.toBeNull();
  });

  it('queues responder peer exchanges until authenticateClient installs sendAuthMessage', async () => {
    const { initiator, responder, sendToResponder, sendToInitiator } = await createRelayAuthPairRaw({
      deviceId: 'device-queued-before-start',
      machineId: 'machine-queued-before-start',
    });

    const initiatorPromise = initiator.authenticateClient(sendToResponder);

    const queuedPeer = await waitForPrivateField<{ identityId: string }>(responder, 'earlyPeer');

    expect(Reflect.get(responder, 'sendAuthMessage')).toBeUndefined();
    expect(Reflect.get(responder, 'processingExchange')).toBe(false);
    expect(queuedPeer).toMatchObject({
      identityId: 'device-queued-before-start',
    });

    await responder.authenticateClient(sendToInitiator);
    await initiatorPromise;

    expect(initiator.getSessionKey()).not.toBeNull();
    expect(responder.getSessionKey()).not.toBeNull();
  });

  it('rejects an in-flight waiter when cleanup aborts the auth session', async () => {
    const { initiator, sendToResponder } = await createRelayAuthPairRaw({
      deviceId: 'device-3',
      machineId: 'machine-3',
    });

    const authPromise = initiator.authenticateClient(sendToResponder);

    // Wait long enough for the async ensureLocalExchangeMessage() crypto to
    // complete so the initiator reaches waitForPeerExchange() and sets
    // pendingPeer before cleanup is called.
    await new Promise((resolve) => setTimeout(resolve, 50));

    initiator.cleanup();

    await expect(authPromise).rejects.toThrow('auth session aborted by reconnect');
  });

  it('generation guard: stale processPeerExchange does not overwrite new session keys', async () => {
    // Use two distinct peer identities (deviceA for session N, deviceB for N+1)
    // so getPeerId() is a reliable discriminator — if the stale task overwrites,
    // peerId will flip from deviceBId back to deviceAId.
    const machineId = 'machine-gen-guard';
    const deviceAId = 'device-A-stale';
    const deviceBId = 'device-B-current';

    const machineSigningKeys = await generateSigningKeyPair();
    const deviceASigningKeys = await generateSigningKeyPair();
    const deviceBSigningKeys = await generateSigningKeyPair();

    // Gate controlled by the test: stale task parks here until released.
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => {
      gateResolve = r;
    });

    let gateTriggered = false;
    const responder = new E2ERelayAuth({
      signingKeyPair: machineSigningKeys,
      identityId: machineId,
      getPeerSigningKey: async (peerId) => {
        if (peerId === deviceAId && !gateTriggered) {
          // First call for deviceA (session N): pause at gate.
          gateTriggered = true;
          await gate;
        }
        if (peerId === deviceAId) return deviceASigningKeys.publicKey;
        if (peerId === deviceBId) return deviceBSigningKeys.publicKey;
        return null;
      },
      mode: 'responder',
      blocking: false,
    });

    // Session N: authenticate responder, then deliver deviceA's exchange.
    await responder.authenticateClient(() => {
      /* no-op send — session N has no live initiator */
    });

    const initiatorA = new E2ERelayAuth({
      signingKeyPair: deviceASigningKeys,
      identityId: deviceAId,
      getPeerSigningKey: async (peerId) => (peerId === machineId ? machineSigningKeys.publicKey : null),
      mode: 'initiator',
      blocking: false,
    });
    await initiatorA.authenticateClient((msg) => responder.handleAuthMessage(msg));
    // Stale processPeerExchange (generation=1, deviceA) is suspended at the gate.

    // Session N+1: full blocking handshake with deviceB.
    const initiatorB = new E2ERelayAuth({
      signingKeyPair: deviceBSigningKeys,
      identityId: deviceBId,
      getPeerSigningKey: async (peerId) => (peerId === machineId ? machineSigningKeys.publicKey : null),
      mode: 'initiator',
      blocking: true,
    });

    const n1AuthPromise = initiatorB.authenticateClient((msg) => responder.handleAuthMessage(msg));
    await responder.authenticateClient((msg) => initiatorB.handleAuthMessage(msg));
    await n1AuthPromise;

    // Session N+1 is established with deviceB.
    expect(responder.getSessionKey()).not.toBeNull();
    expect(responder.getPeerId()).toBe(deviceBId);

    // Release the stale task — the generation guard must prevent it from
    // overwriting sessionKey/peerId with deviceA's values.
    gateResolve();
    // Drain enough microtasks for the stale task to complete its crypto work
    // and hit the generation guard.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(responder.getSessionKey()).not.toBeNull();
    expect(responder.getPeerId()).toBe(deviceBId);
  });

  it('retries the latest queued peer exchange after an in-flight non-blocking failure', async () => {
    const machineId = 'machine-retry-queue';
    const stalePeerId = 'device-stale-peer';
    const freshPeerId = 'device-fresh-peer';

    const machineSigningKeys = await generateSigningKeyPair();
    const stalePeerSigningKeys = await generateSigningKeyPair();
    const freshPeerSigningKeys = await generateSigningKeyPair();

    let releaseStaleLookup!: () => void;
    const staleLookupGate = new Promise<void>((resolve) => {
      releaseStaleLookup = resolve;
    });

    const responder = new E2ERelayAuth({
      signingKeyPair: machineSigningKeys,
      identityId: machineId,
      getPeerSigningKey: async (peerId) => {
        if (peerId === stalePeerId) {
          await staleLookupGate;
          return null;
        }
        if (peerId === freshPeerId) {
          return freshPeerSigningKeys.publicKey;
        }
        return null;
      },
      mode: 'responder',
      blocking: false,
    });
    await responder.authenticateClient(() => {
      /* no-op send */
    });

    const staleInitiator = new E2ERelayAuth({
      signingKeyPair: stalePeerSigningKeys,
      identityId: stalePeerId,
      getPeerSigningKey: async (peerId) => (peerId === machineId ? machineSigningKeys.publicKey : null),
      mode: 'initiator',
      blocking: false,
    });
    await staleInitiator.authenticateClient((message) => responder.handleAuthMessage(message));

    const freshInitiator = new E2ERelayAuth({
      signingKeyPair: freshPeerSigningKeys,
      identityId: freshPeerId,
      getPeerSigningKey: async (peerId) => (peerId === machineId ? machineSigningKeys.publicKey : null),
      mode: 'initiator',
      blocking: false,
    });
    await freshInitiator.authenticateClient((message) => responder.handleAuthMessage(message));

    releaseStaleLookup();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(responder.getSessionKey()).not.toBeNull();
    expect(responder.getPeerId()).toBe(freshPeerId);
  });
});
