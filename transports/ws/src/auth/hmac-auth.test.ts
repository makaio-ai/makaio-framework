import { afterEach, describe, expect, it } from 'vitest';
import { HmacAuth } from './hmac-auth.js';
import {
  clearHmacIdentitySecretsForTesting,
  registerHmacIdentitySecret,
  resolveHmacIdentityPeer,
  resolveHmacIdentitySecret,
  rotateHmacIdentitySecret,
} from './identity-secret-registry.js';
import type { WebSocketLike } from '../types.js';

/** Minimal socket stub used to key per-socket state maps. */
const makeSocket = (): WebSocketLike => ({}) as WebSocketLike;

/**
 * Drive a full auth handshake in-memory.
 * @param serverAuth - Server-side HMAC auth instance.
 * @param clientAuth - Client-side HMAC auth instance.
 * @param socket - Socket key for the server auth state map.
 */
async function runAuthHandshake(serverAuth: HmacAuth, clientAuth: HmacAuth, socket: WebSocketLike): Promise<void> {
  await Promise.all([
    serverAuth.authenticateServer(socket, (message) => {
      clientAuth.handleAuthMessage(message);
    }),
    clientAuth.authenticateClient((message) => {
      serverAuth.handleAuthMessage(message, socket);
    }),
  ]);
}

describe('HmacAuth client-side message ordering', () => {
  it('uses auth frames that arrive before authenticateClient installs its waits', async () => {
    const auth = new HmacAuth({ secret: 'test-secret', challengeTimeout: 50 });
    const sentMessages: unknown[] = [];

    expect(auth.handleAuthMessage({ type: 'auth-challenge', nonce: 'early-nonce' })).toBe(true);

    await auth.authenticateClient((message: unknown) => {
      sentMessages.push(message);
      expect(auth.handleAuthMessage({ type: 'auth-result', success: true })).toBe(true);
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ type: 'auth-response' });
  });

  it('drops late duplicate auth frames after client authentication completes', async () => {
    const auth = new HmacAuth({ secret: 'test-secret', challengeTimeout: 10 });
    const sentMessages: unknown[] = [];

    expect(auth.handleAuthMessage({ type: 'auth-challenge', nonce: 'first-nonce' })).toBe(true);
    await auth.authenticateClient((message: unknown) => {
      sentMessages.push(message);
      expect(auth.handleAuthMessage({ type: 'auth-result', success: true })).toBe(true);
    });

    expect(auth.handleAuthMessage({ type: 'auth-challenge', nonce: 'late-nonce' })).toBe(true);
    expect(auth.handleAuthMessage({ type: 'auth-result', success: true })).toBe(true);

    await expect(auth.authenticateClient((message: unknown) => sentMessages.push(message))).rejects.toThrow(
      'Authentication challenge timeout',
    );
    expect(sentMessages).toHaveLength(1);
  });

  it('clears queued client auth frames on cleanup', async () => {
    const auth = new HmacAuth({ secret: 'test-secret', challengeTimeout: 10 });
    const sentMessages: unknown[] = [];

    expect(auth.handleAuthMessage({ type: 'auth-challenge', nonce: 'stale-nonce' })).toBe(true);
    auth.cleanup();

    await expect(auth.authenticateClient((message: unknown) => sentMessages.push(message))).rejects.toThrow(
      'Authentication challenge timeout',
    );
    expect(sentMessages).toHaveLength(0);
  });
});

describe('HmacAuth claims propagation', () => {
  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  it('propagates peer claims through getReceiveContext after auth', async () => {
    const attemptId = 'attempt-claims-test';
    const executionId = 'exec-claims-test';
    const secret = 'claims-test-secret';
    registerHmacIdentitySecret(attemptId, secret, {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    const serverAuth = new HmacAuth({
      secret: 'global-secret',
      challengeTimeout: 200,
      resolveSecret: resolveHmacIdentitySecret,
      resolvePeer: resolveHmacIdentityPeer,
    });
    const clientAuth = new HmacAuth({
      secret,
      identityId: attemptId,
      challengeTimeout: 200,
    });
    const socket = makeSocket();

    await runAuthHandshake(serverAuth, clientAuth, socket);

    const ctx = serverAuth.getReceiveContext(socket);
    expect(ctx).toBeDefined();
    expect(ctx?.peer).toEqual({
      kind: 'workflow-execution-attempt',
      id: attemptId,
      authenticated: true,
      claims: { executionId },
    });
  });
});

// ---------------------------------------------------------------------------
// Secret rotation fencing via isSocketAuthenticated
// ---------------------------------------------------------------------------

describe('HmacAuth secret rotation fencing', () => {
  afterEach(() => {
    clearHmacIdentitySecretsForTesting();
  });

  it('fences old socket after secret rotation', async () => {
    const attemptId = 'attempt-rotate-fence';
    const executionId = 'exec-rotate-fence';
    const oldSecret = 'old-secret-fence';
    registerHmacIdentitySecret(attemptId, oldSecret, {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    const serverAuth = new HmacAuth({
      secret: 'global-secret',
      challengeTimeout: 200,
      resolveSecret: resolveHmacIdentitySecret,
      resolvePeer: resolveHmacIdentityPeer,
    });
    const clientAuth = new HmacAuth({
      secret: oldSecret,
      identityId: attemptId,
      challengeTimeout: 200,
    });
    const socket = makeSocket();

    await runAuthHandshake(serverAuth, clientAuth, socket);
    expect(serverAuth.isSocketAuthenticated(socket)).toBe(true);

    // Rotate the secret in the registry.
    rotateHmacIdentitySecret(attemptId, 'new-secret-fence');

    // The old socket must now be fenced — per-message revalidation detects
    // the secret mismatch.
    expect(serverAuth.isSocketAuthenticated(socket)).toBe(false);
  });

  it('reconnected client with rotated secret is authorized', async () => {
    const attemptId = 'attempt-reconnect';
    const executionId = 'exec-reconnect';
    const oldSecret = 'old-secret-reconnect';
    const newSecret = 'new-secret-reconnect';
    registerHmacIdentitySecret(attemptId, oldSecret, {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    const serverAuth = new HmacAuth({
      secret: 'global-secret',
      challengeTimeout: 200,
      resolveSecret: resolveHmacIdentitySecret,
      resolvePeer: resolveHmacIdentityPeer,
    });

    // First connection with old secret.
    const clientAuth1 = new HmacAuth({
      secret: oldSecret,
      identityId: attemptId,
      challengeTimeout: 200,
    });
    const socket1 = makeSocket();
    await runAuthHandshake(serverAuth, clientAuth1, socket1);

    // Rotate.
    rotateHmacIdentitySecret(attemptId, newSecret);
    expect(serverAuth.isSocketAuthenticated(socket1)).toBe(false);

    // Second connection with new secret.
    const clientAuth2 = new HmacAuth({
      secret: newSecret,
      identityId: attemptId,
      challengeTimeout: 200,
    });
    const socket2 = makeSocket();
    await runAuthHandshake(serverAuth, clientAuth2, socket2);

    expect(serverAuth.isSocketAuthenticated(socket2)).toBe(true);
    expect(serverAuth.getReceiveContext(socket2)?.peer).toEqual({
      kind: 'workflow-execution-attempt',
      id: attemptId,
      authenticated: true,
      claims: { executionId },
    });
  });

  it('revoking attempt A does not affect attempt B of the same execution', async () => {
    const executionId = 'shared-exec';
    const attemptA = 'attempt-A';
    const attemptB = 'attempt-B';
    const secretA = 'secret-A';
    const secretB = 'secret-B';

    registerHmacIdentitySecret(attemptA, secretA, {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });
    registerHmacIdentitySecret(attemptB, secretB, {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    const serverAuth = new HmacAuth({
      secret: 'global-secret',
      challengeTimeout: 200,
      resolveSecret: resolveHmacIdentitySecret,
      resolvePeer: resolveHmacIdentityPeer,
    });

    const clientA = new HmacAuth({
      secret: secretA,
      identityId: attemptA,
      challengeTimeout: 200,
    });
    const clientB = new HmacAuth({
      secret: secretB,
      identityId: attemptB,
      challengeTimeout: 200,
    });
    const socketA = makeSocket();
    const socketB = makeSocket();

    await runAuthHandshake(serverAuth, clientA, socketA);
    await runAuthHandshake(serverAuth, clientB, socketB);

    expect(serverAuth.isSocketAuthenticated(socketA)).toBe(true);
    expect(serverAuth.isSocketAuthenticated(socketB)).toBe(true);

    // Revoke attempt A by clearing its registry entry.
    clearHmacIdentitySecretsForTesting();
    registerHmacIdentitySecret(attemptB, secretB, {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    // Attempt A is fenced; attempt B is unaffected.
    expect(serverAuth.isSocketAuthenticated(socketA)).toBe(false);
    expect(serverAuth.isSocketAuthenticated(socketB)).toBe(true);
  });

  it('getReceiveContext returns undefined for a fenced socket', async () => {
    const attemptId = 'attempt-fenced-ctx';
    const executionId = 'exec-fenced-ctx';
    const oldSecret = 'old-fenced-secret';
    registerHmacIdentitySecret(attemptId, oldSecret, {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
    });

    const serverAuth = new HmacAuth({
      secret: 'global-secret',
      challengeTimeout: 200,
      resolveSecret: resolveHmacIdentitySecret,
      resolvePeer: resolveHmacIdentityPeer,
    });
    const clientAuth = new HmacAuth({
      secret: oldSecret,
      identityId: attemptId,
      challengeTimeout: 200,
    });
    const socket = makeSocket();

    await runAuthHandshake(serverAuth, clientAuth, socket);
    expect(serverAuth.getReceiveContext(socket)).toBeDefined();

    // Rotate — the old socket should lose its receive context.
    rotateHmacIdentitySecret(attemptId, 'new-fenced-secret');
    expect(serverAuth.isSocketAuthenticated(socket)).toBe(false);
    expect(serverAuth.getReceiveContext(socket)).toBeUndefined();
  });
});
