/**
 * Tests for HMAC identity-bound authentication mode.
 *
 * The test simulates the full server↔client challenge/response flow by
 * directly calling `handleAuthMessage()` on each side in lieu of real
 * WebSocket I/O — the same pattern used by the transport layer.
 */

import { MAKAIO_CLI_LOCAL_PARTY_KIND } from '@makaio/core';
import { describe, expect, it } from 'vitest';
import { HmacAuth } from '../hmac-auth.js';
import { MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID, registerMakaioLocalCliHmacIdentity } from '../local-cli-identity.js';
import {
  clearHmacIdentitySecretsForTesting,
  registerHmacIdentitySecret,
  resolveHmacIdentityParty,
  resolveHmacIdentitySecret,
  rotateHmacIdentitySecret,
} from '../identity-secret-registry.js';
import type { WebSocketLike } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket-like stub used to key per-socket state maps.
 * The server-side auth implementation keys everything on object identity,
 * so a plain object is sufficient — cast to `WebSocketLike` since the auth
 * layer never calls socket methods during the challenge/response phase.
 */
const makeSocket = (): WebSocketLike => ({}) as WebSocketLike;

/**
 * Drive a full HMAC challenge/response round-trip in-memory.
 *
 * Wire: server sends → client.handleAuthMessage, client sends → server.handleAuthMessage.
 * Both sides run concurrently to avoid deadlocking on their respective awaits.
 * @param serverAuth - Server-side HmacAuth instance
 * @param clientAuth - Client-side HmacAuth instance
 * @param socket - Shared socket stub used to key server-side state
 * @returns Resolves when both sides finish; rejects if either throws
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

// ---------------------------------------------------------------------------
// Global-secret mode (backward compat)
// ---------------------------------------------------------------------------

describe('HmacAuth — global-secret mode', () => {
  it('authenticates successfully with matching secret', async () => {
    const secret = 'shared-global-secret';
    const serverAuth = new HmacAuth({ secret, challengeTimeout: 200 });
    const clientAuth = new HmacAuth({ secret, challengeTimeout: 200 });
    const socket = makeSocket();

    await expect(runAuthHandshake(serverAuth, clientAuth, socket)).resolves.toBeUndefined();
    expect(serverAuth.isSocketAuthenticated(socket)).toBe(true);
  });

  it('uses distinct connection ids without an attesting caller in global-secret mode', async () => {
    const secret = 'shared-global-secret';
    const serverAuth = new HmacAuth({ secret, challengeTimeout: 200 });
    const clientAuth = new HmacAuth({ secret, challengeTimeout: 200 });
    const socket = makeSocket();

    await runAuthHandshake(serverAuth, clientAuth, socket);
    const context = serverAuth.getReceiveContext(socket);
    expect(context).toEqual({ transportName: '', connectionId: expect.any(String), authenticated: true });
    expect(serverAuth.getReceiveContext(socket)?.connectionId).toBe(context?.connectionId);

    const secondSocket = makeSocket();
    await runAuthHandshake(serverAuth, new HmacAuth({ secret, challengeTimeout: 200 }), secondSocket);
    expect(serverAuth.getReceiveContext(secondSocket)?.connectionId).not.toBe(context?.connectionId);
  });

  it('authenticates global-secret clients when an identity resolver is configured', async () => {
    const secret = 'shared-global-secret-with-resolver';
    const serverAuth = new HmacAuth({
      secret,
      challengeTimeout: 200,
      resolveSecret: () => null,
    });
    const clientAuth = new HmacAuth({ secret, challengeTimeout: 200 });
    const socket = makeSocket();

    await expect(runAuthHandshake(serverAuth, clientAuth, socket)).resolves.toBeUndefined();
    expect(serverAuth.isSocketAuthenticated(socket)).toBe(true);
    expect(serverAuth.getReceiveContext(socket)).toEqual({
      transportName: '',
      connectionId: expect.any(String),
      authenticated: true,
    });
  });

  it('rejects when client uses wrong secret', async () => {
    const serverAuth = new HmacAuth({ secret: 'correct-secret', challengeTimeout: 200 });
    const clientAuth = new HmacAuth({ secret: 'wrong-secret', challengeTimeout: 200 });
    const socket = makeSocket();

    await expect(runAuthHandshake(serverAuth, clientAuth, socket)).rejects.toThrow('HMAC authentication failed');
  });
});

// ---------------------------------------------------------------------------
// Identity-bound mode
// ---------------------------------------------------------------------------

describe('HmacAuth — identity-bound mode', () => {
  it('authenticates the registered local CLI identity as its dedicated party kind', async () => {
    clearHmacIdentitySecretsForTesting();
    const secret = 'local-cli-shared-secret';
    const cleanup = registerMakaioLocalCliHmacIdentity(secret);

    try {
      const serverAuth = new HmacAuth({
        secret,
        challengeTimeout: 200,
        resolveSecret: resolveHmacIdentitySecret,
        resolveParty: resolveHmacIdentityParty,
      });
      const clientAuth = new HmacAuth({
        secret,
        identityId: MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID,
        challengeTimeout: 200,
      });
      const socket = makeSocket();

      await expect(runAuthHandshake(serverAuth, clientAuth, socket)).resolves.toBeUndefined();
      expect(serverAuth.getReceiveContext(socket)?.authenticated).toBe(true);
      expect(serverAuth.getReceiveContext(socket)?.attests).toBe('inbound');
      expect(serverAuth.getReceiveContext(socket)?.caller).toEqual({
        kind: MAKAIO_CLI_LOCAL_PARTY_KIND,
        id: MAKAIO_LOCAL_CLI_HMAC_IDENTITY_ID,
      });
    } finally {
      cleanup();
      clearHmacIdentitySecretsForTesting();
    }
  });

  it('authenticates successfully when resolveSecret returns the correct secret', async () => {
    const executionId = 'exec-abc-123';
    const secret = 'per-execution-secret';

    const serverAuth = new HmacAuth({
      secret: 'ignored-on-server',
      challengeTimeout: 200,
      resolveSecret: (claimedId) => (claimedId === executionId ? secret : null),
    });
    const clientAuth = new HmacAuth({
      secret,
      identityId: executionId,
      challengeTimeout: 200,
    });
    const socket = makeSocket();

    await expect(runAuthHandshake(serverAuth, clientAuth, socket)).resolves.toBeUndefined();
  });

  it('does not infer caller authorization when no trusted party resolver is configured', async () => {
    const executionId = 'exec-def-456';
    const secret = 'per-execution-secret-2';

    const serverAuth = new HmacAuth({
      secret: 'ignored',
      challengeTimeout: 200,
      resolveSecret: (claimedId) => (claimedId === executionId ? secret : null),
    });
    const clientAuth = new HmacAuth({ secret, identityId: executionId, challengeTimeout: 200 });
    const socket = makeSocket();

    await runAuthHandshake(serverAuth, clientAuth, socket);

    expect(serverAuth.getReceiveContext(socket)).toBeUndefined();
  });

  it('authenticates against the process-local identity secret registry', async () => {
    clearHmacIdentitySecretsForTesting();
    const attemptId = 'attempt-registry-1';
    const executionId = 'wfx-registry-1';
    const secret = 'per-execution-registry-secret';
    registerHmacIdentitySecret(attemptId, secret, {
      partyKind: 'test.workflow-execution-attempt',
      attestingRole: 'job-run',
      claims: { executionId },
    });

    try {
      const serverAuth = new HmacAuth({
        secret: 'global-secret',
        challengeTimeout: 200,
        resolveSecret: resolveHmacIdentitySecret,
        resolveParty: resolveHmacIdentityParty,
      });
      const clientAuth = new HmacAuth({ secret, identityId: attemptId, challengeTimeout: 200 });
      const socket = makeSocket();

      await expect(runAuthHandshake(serverAuth, clientAuth, socket)).resolves.toBeUndefined();
      expect(serverAuth.isSocketAuthenticated(socket)).toBe(true);
      expect(serverAuth.getReceiveContext(socket)?.authenticated).toBe(true);
      expect(serverAuth.getReceiveContext(socket)?.attests).toBe('inbound');
      expect(serverAuth.getReceiveContext(socket)?.caller).toEqual({
        kind: 'test.workflow-execution-attempt',
        id: attemptId,
        claims: { executionId },
      });

      const rotatedSecret = 'rotated-registry-secret';
      rotateHmacIdentitySecret(attemptId, rotatedSecret);
      expect(serverAuth.getReceiveContext(socket)?.attests).toBeUndefined();

      const rotatedClient = new HmacAuth({ secret: rotatedSecret, identityId: attemptId, challengeTimeout: 200 });
      const rotatedSocket = makeSocket();
      await runAuthHandshake(serverAuth, rotatedClient, rotatedSocket);
      expect(serverAuth.getReceiveContext(rotatedSocket)?.attests).toBe('inbound');

      clearHmacIdentitySecretsForTesting();
      expect(serverAuth.getReceiveContext(rotatedSocket)).toBeUndefined();
      expect(serverAuth.isSocketAuthenticated(socket)).toBe(false);
      expect(serverAuth.getReceiveContext(socket)).toBeUndefined();
    } finally {
      clearHmacIdentitySecretsForTesting();
    }
  });

  it('exposes registered non-workflow party kinds through receive context', async () => {
    clearHmacIdentitySecretsForTesting();
    const identityId = 'dashboard:session-1';
    const secret = 'per-dashboard-session-secret';
    registerHmacIdentitySecret(identityId, secret, { partyKind: 'test.dashboard-session' });

    try {
      const serverAuth = new HmacAuth({
        secret: 'global-secret',
        challengeTimeout: 200,
        resolveSecret: resolveHmacIdentitySecret,
        resolveParty: resolveHmacIdentityParty,
      });
      const clientAuth = new HmacAuth({ secret, identityId, challengeTimeout: 200 });
      const socket = makeSocket();

      await expect(runAuthHandshake(serverAuth, clientAuth, socket)).resolves.toBeUndefined();
      expect(serverAuth.getReceiveContext(socket)?.authenticated).toBe(true);
      expect(serverAuth.getReceiveContext(socket)).not.toHaveProperty('attests');
      expect(serverAuth.getReceiveContext(socket)?.caller).toEqual({
        kind: 'test.dashboard-session',
        id: identityId,
      });
    } finally {
      clearHmacIdentitySecretsForTesting();
    }
  });

  it('keeps a newer party registration when an older cleanup uses the same secret', () => {
    clearHmacIdentitySecretsForTesting();
    const identityId = 'shared-identity';
    const secret = 'same-transport-secret';
    const cleanupBootstrapParty = registerHmacIdentitySecret(identityId, secret, {
      partyKind: 'test.worker-bootstrap',
    });
    const cleanupDashboardParty = registerHmacIdentitySecret(identityId, secret, {
      partyKind: 'test.dashboard-session',
    });

    try {
      cleanupBootstrapParty();

      expect(resolveHmacIdentitySecret(identityId)).toBe(secret);
      expect(resolveHmacIdentityParty(identityId)).toEqual({
        kind: 'test.dashboard-session',
        id: identityId,
      });
    } finally {
      cleanupDashboardParty();
      clearHmacIdentitySecretsForTesting();
    }
  });

  it('rejects when resolveSecret returns null for the claimed identity', async () => {
    const serverAuth = new HmacAuth({
      secret: 'ignored',
      challengeTimeout: 200,
      resolveSecret: () => null,
    });
    const clientAuth = new HmacAuth({
      secret: 'any-secret',
      identityId: 'unknown-exec',
      challengeTimeout: 200,
    });
    const socket = makeSocket();

    await expect(runAuthHandshake(serverAuth, clientAuth, socket)).rejects.toThrow("Unknown identity 'unknown-exec'");
  });

  it('caller is removed from getReceiveContext after cleanupSocket', async () => {
    const executionId = 'exec-ghi-789';
    const secret = 'cleanup-test-secret';

    const serverAuth = new HmacAuth({
      secret: 'ignored',
      challengeTimeout: 200,
      resolveSecret: (claimedId) => (claimedId === executionId ? secret : null),
      resolveParty: (claimedId) => (claimedId === executionId ? { kind: 'test.identity', id: claimedId } : null),
    });
    const clientAuth = new HmacAuth({ secret, identityId: executionId, challengeTimeout: 200 });
    const socket = makeSocket();

    await runAuthHandshake(serverAuth, clientAuth, socket);
    expect(serverAuth.getReceiveContext(socket)).toBeDefined();
    expect(serverAuth.isSocketAuthenticated(socket)).toBe(true);

    serverAuth.cleanupSocket(socket);
    expect(serverAuth.getReceiveContext(socket)).toBeUndefined();
    expect(serverAuth.isSocketAuthenticated(socket)).toBe(false);
  });

  it('getReceiveContext returns undefined when called without a socket', async () => {
    const executionId = 'exec-no-socket';
    const secret = 'no-socket-secret';

    const serverAuth = new HmacAuth({
      secret: 'ignored',
      challengeTimeout: 200,
      resolveSecret: (claimedId) => (claimedId === executionId ? secret : null),
    });
    const clientAuth = new HmacAuth({ secret, identityId: executionId, challengeTimeout: 200 });
    const socket = makeSocket();

    await runAuthHandshake(serverAuth, clientAuth, socket);

    expect(serverAuth.getReceiveContext(undefined)).toBeUndefined();
  });
});
