/**
 * DispatchingAuth unit tests.
 *
 * Verifies routing to the correct strategy based on the first auth message type,
 * as well as cleanup delegation and error handling.
 *
 * These tests use real `DispatchingAuth` with mock `TransportAuth` implementations.
 * The mock strategies record calls and expose control handles so tests can assert
 * behavior without depending on the full HMAC / E2E protocol.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { DispatchingAuth } from './dispatching-auth.js';
import { HmacAuth } from './hmac-auth.js';
import { E2EAuth } from './e2e-auth.js';
import type { TransportAuth } from './interface.js';
import type { WebSocketLike } from '../types.js';

/**
 * Captured arguments from `authenticateServer` for assertion.
 */
interface CapturedServerAuth {
  socket: WebSocketLike;
  send: (message: unknown) => void;
}

/**
 * Create a mock TransportAuth whose `authenticateServer` parks a controllable
 * promise so tests can resolve or reject it at will.
 * @returns Mock strategy and helpers for controlling / inspecting its behaviour
 */
function createMockStrategy(): {
  strategy: TransportAuth;
  capturedServerAuths: CapturedServerAuth[];
  resolveServerAuth: () => void;
  rejectServerAuth: (error: Error) => void;
} {
  const capturedServerAuths: CapturedServerAuth[] = [];
  let pendingResolve: (() => void) | undefined;
  let pendingReject: ((error: Error) => void) | undefined;

  const strategy: TransportAuth = {
    authenticateClient: mock(async () => undefined),
    authenticateServer: mock(async (socket: WebSocketLike, send: (message: unknown) => void) => {
      capturedServerAuths.push({ socket, send });
      return new Promise<void>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
    }),
    handleAuthMessage: mock(() => true),
    cleanupSocket: mock(() => undefined),
    cleanup: mock(() => undefined),
  };

  return {
    strategy,
    capturedServerAuths,
    resolveServerAuth: () => pendingResolve?.(),
    rejectServerAuth: (error: Error) => pendingReject?.(error),
  };
}

/**
 * Create a minimal WebSocketLike stub for tracking per-socket state.
 * @returns Stub WebSocket object usable as a Map key
 */
function createSocket(): WebSocketLike {
  return {
    send: mock(() => undefined),
    close: mock(() => undefined),
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    readyState: 1,
  };
}

/**
 * Generate an ECDSA P-256 signing keypair for E2E auth tests.
 * @returns Generated signing keypair
 */
async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]) as Promise<CryptoKeyPair>;
}

describe('DispatchingAuth', () => {
  let hmockStrategy: ReturnType<typeof createMockStrategy>;
  let e2eStrategy: ReturnType<typeof createMockStrategy>;
  let socket: WebSocketLike;
  let send: ReturnType<typeof mock>;

  beforeEach(() => {
    hmockStrategy = createMockStrategy();
    e2eStrategy = createMockStrategy();
    socket = createSocket();
    send = mock(() => undefined);
  });

  describe('authenticateServer + handleAuthMessage routing', () => {
    it('routes to E2E strategy when the first message type is e2e-key-exchange', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);

      // HMAC must have been started eagerly so it can send its challenge
      expect(hmockStrategy.strategy.authenticateServer).toHaveBeenCalledWith(socket, expect.any(Function));
      // E2E has not started yet — it waits for the first client message
      expect(e2eStrategy.strategy.authenticateServer).not.toHaveBeenCalled();

      // First message from client identifies as E2E
      const handled = auth.handleAuthMessage({ type: 'e2e-key-exchange', deviceId: 'dev-1' }, socket);
      expect(handled).toBe(true);

      // E2E strategy's authenticateServer should now have been called
      expect(e2eStrategy.strategy.authenticateServer).toHaveBeenCalledWith(socket, send);

      // E2E strategy's handleAuthMessage should receive the first message
      expect(e2eStrategy.strategy.handleAuthMessage).toHaveBeenCalledWith(
        { type: 'e2e-key-exchange', deviceId: 'dev-1' },
        socket,
      );

      // HMAC should have been cancelled: cleanupSocket called to abort it
      expect(hmockStrategy.strategy.cleanupSocket).toHaveBeenCalledWith(socket);
      // HMAC's handleAuthMessage must not be called — E2E owns this socket
      expect(hmockStrategy.strategy.handleAuthMessage).not.toHaveBeenCalled();

      // Resolve the delegated E2E auth → overall promise resolves
      e2eStrategy.resolveServerAuth();
      await expect(serverAuthPromise).resolves.toBeUndefined();
    });

    it('routes to HMAC strategy when the first message type is auth-response', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);

      // HMAC already started eagerly
      expect(hmockStrategy.strategy.authenticateServer).toHaveBeenCalledWith(socket, expect.any(Function));

      const handled = auth.handleAuthMessage({ type: 'auth-response', signature: 'abc123' }, socket);
      expect(handled).toBe(true);

      // HMAC's handleAuthMessage receives the auth-response
      expect(hmockStrategy.strategy.handleAuthMessage).toHaveBeenCalledWith(
        { type: 'auth-response', signature: 'abc123' },
        socket,
      );

      // HMAC was not cancelled — it won the dispatch
      expect(hmockStrategy.strategy.cleanupSocket).not.toHaveBeenCalled();

      // E2E must not have been involved
      expect(e2eStrategy.strategy.authenticateServer).not.toHaveBeenCalled();
      expect(e2eStrategy.strategy.handleAuthMessage).not.toHaveBeenCalled();

      // Resolve HMAC auth → overall promise resolves
      hmockStrategy.resolveServerAuth();
      await expect(serverAuthPromise).resolves.toBeUndefined();
    });

    it('delegates to a single strategy immediately when only one is configured (no dispatch)', async () => {
      // Single-strategy fast path: authenticateServer delegates without waiting
      // for the first message, so handleAuthMessage is not needed for routing.
      const auth = new DispatchingAuth({ e2e: e2eStrategy.strategy });

      const serverAuthPromise = auth.authenticateServer(socket, send);

      // E2E started immediately, with the original send function
      expect(e2eStrategy.strategy.authenticateServer).toHaveBeenCalledWith(socket, send);
      // HMAC not touched
      expect(hmockStrategy.strategy.authenticateServer).not.toHaveBeenCalled();

      e2eStrategy.resolveServerAuth();
      await expect(serverAuthPromise).resolves.toBeUndefined();
    });

    it('delegates HMAC immediately when only HMAC is configured', async () => {
      const auth = new DispatchingAuth({ hmac: hmockStrategy.strategy });

      const serverAuthPromise = auth.authenticateServer(socket, send);

      expect(hmockStrategy.strategy.authenticateServer).toHaveBeenCalledWith(socket, send);
      expect(e2eStrategy.strategy.authenticateServer).not.toHaveBeenCalled();

      hmockStrategy.resolveServerAuth();
      await expect(serverAuthPromise).resolves.toBeUndefined();
    });

    it('forwards subsequent messages directly to the resolved strategy', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);

      // Route is established by the first message
      auth.handleAuthMessage({ type: 'e2e-key-exchange', deviceId: 'dev-1' }, socket);
      (e2eStrategy.strategy.handleAuthMessage as ReturnType<typeof mock>).mockClear();

      // Second message goes directly to E2E without re-inspection
      auth.handleAuthMessage({ type: 'e2e-key-exchange-response', ephemeralPublicKey: 'pk' }, socket);
      expect(e2eStrategy.strategy.handleAuthMessage).toHaveBeenCalledTimes(1);
      expect(e2eStrategy.strategy.handleAuthMessage).toHaveBeenCalledWith(
        { type: 'e2e-key-exchange-response', ephemeralPublicKey: 'pk' },
        socket,
      );
      expect(hmockStrategy.strategy.handleAuthMessage).not.toHaveBeenCalled();

      e2eStrategy.resolveServerAuth();
      await expect(serverAuthPromise).resolves.toBeUndefined();
    });

    it('throws a clear error when authenticateServer is called without configured strategies', async () => {
      const auth = new DispatchingAuth({});
      await expect(auth.authenticateServer(socket, send)).rejects.toThrow(/no auth strategy configured/);
    });

    it('rejects when both strategies configured but message type is unrecognised', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);

      const handled = auth.handleAuthMessage({ type: 'completely-unknown' }, socket);
      expect(handled).toBe(false);

      // HMAC was cancelled (started eagerly, but unknown type wins nothing)
      expect(hmockStrategy.strategy.cleanupSocket).toHaveBeenCalledWith(socket);

      await expect(serverAuthPromise).rejects.toThrow(/unrecognised auth message type.*completely-unknown/);
    });

    it('propagates rejection from the delegated E2E strategy', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);
      auth.handleAuthMessage({ type: 'e2e-key-exchange' }, socket);

      e2eStrategy.rejectServerAuth(new Error('E2E handshake failed'));

      await expect(serverAuthPromise).rejects.toThrow('E2E handshake failed');
    });

    it('propagates rejection from the delegated HMAC strategy', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);
      auth.handleAuthMessage({ type: 'auth-response', signature: 'bad' }, socket);

      hmockStrategy.rejectServerAuth(new Error('HMAC signature mismatch'));

      await expect(serverAuthPromise).rejects.toThrow('HMAC signature mismatch');
    });
  });

  describe('cleanupSocket', () => {
    it('delegates cleanupSocket to the resolved E2E strategy and removes mapping', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);
      auth.handleAuthMessage({ type: 'e2e-key-exchange' }, socket);

      // Clear the call from the HMAC cancellation so we can assert cleanupSocket
      // is called again for the resolved strategy
      (hmockStrategy.strategy.cleanupSocket as ReturnType<typeof mock>).mockClear();

      auth.cleanupSocket(socket);

      expect(e2eStrategy.strategy.cleanupSocket).toHaveBeenCalledWith(socket);
      // HMAC was already cancelled when E2E won; no second cleanupSocket call expected
      expect(hmockStrategy.strategy.cleanupSocket).not.toHaveBeenCalled();

      // Subsequent messages return false because socket was removed
      const handled = auth.handleAuthMessage({ type: 'e2e-key-exchange-response' }, socket);
      expect(handled).toBe(false);

      e2eStrategy.resolveServerAuth();
      await expect(serverAuthPromise).resolves.toBeUndefined();
    });

    it('rejects the pending server-auth promise when socket disconnects before type is determined', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);

      // Disconnect before any auth message arrives
      auth.cleanupSocket(socket);

      await expect(serverAuthPromise).rejects.toThrow(/disconnected before auth type/);
    });

    it('cancels eagerly-started HMAC auth when socket disconnects before type is determined', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);

      // Disconnect before any auth message arrives
      auth.cleanupSocket(socket);

      // HMAC was started eagerly and must be cleaned up
      expect(hmockStrategy.strategy.cleanupSocket).toHaveBeenCalledWith(socket);

      // Consume the rejection so it does not escape the test boundary
      await expect(serverAuthPromise).rejects.toThrow(/disconnected before auth type/);
    });

    it('is a no-op for an untracked socket', () => {
      const auth = new DispatchingAuth({ e2e: e2eStrategy.strategy });
      const unknownSocket = createSocket();

      // Should not throw
      expect(() => auth.cleanupSocket(unknownSocket)).not.toThrow();
      expect(e2eStrategy.strategy.cleanupSocket).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('calls cleanup on both configured strategies', () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      auth.cleanup();

      expect(hmockStrategy.strategy.cleanup).toHaveBeenCalledTimes(1);
      expect(e2eStrategy.strategy.cleanup).toHaveBeenCalledTimes(1);
    });

    it('calls cleanup only on the configured strategy when one is absent', () => {
      const auth = new DispatchingAuth({ e2e: e2eStrategy.strategy });

      auth.cleanup();

      expect(e2eStrategy.strategy.cleanup).toHaveBeenCalledTimes(1);
      expect(hmockStrategy.strategy.cleanup).not.toHaveBeenCalled();
    });

    it('rejects pending server auth promises during cleanup', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);
      auth.cleanup();

      await expect(serverAuthPromise).rejects.toThrow(/cleanup called before authentication completed/);
    });
  });

  describe('authenticateClient', () => {
    it('delegates to HMAC strategy when HMAC is configured', async () => {
      const auth = new DispatchingAuth({ hmac: hmockStrategy.strategy });
      (hmockStrategy.strategy.authenticateClient as ReturnType<typeof mock>).mockResolvedValue(undefined);

      await auth.authenticateClient(send);

      expect(hmockStrategy.strategy.authenticateClient).toHaveBeenCalledWith(send);
    });

    it('delegates to E2E strategy when only E2E is configured', async () => {
      const auth = new DispatchingAuth({ e2e: e2eStrategy.strategy });
      (e2eStrategy.strategy.authenticateClient as ReturnType<typeof mock>).mockResolvedValue(undefined);

      await auth.authenticateClient(send);

      expect(e2eStrategy.strategy.authenticateClient).toHaveBeenCalledWith(send);
    });

    it('throws when no strategy is configured', async () => {
      const auth = new DispatchingAuth({});

      await expect(auth.authenticateClient(send)).rejects.toThrow(/no auth strategy configured/);
    });
  });

  describe('HMAC eagerly started — cancellation when E2E wins', () => {
    it('does not forward HMAC send calls to the client after E2E wins', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);

      // Capture the hmacSend wrapper passed to HMAC's authenticateServer
      const hmacSend = hmockStrategy.capturedServerAuths[0]?.send;
      expect(hmacSend).toBeDefined();

      // E2E wins
      auth.handleAuthMessage({ type: 'e2e-key-exchange' }, socket);

      // Simulate HMAC's error path trying to send a failure message after cancellation
      hmacSend!({ type: 'auth-result', success: false });

      // The original send must NOT have received HMAC's failure message
      expect(send).not.toHaveBeenCalledWith({ type: 'auth-result', success: false });

      e2eStrategy.resolveServerAuth();
      await expect(serverAuthPromise).resolves.toBeUndefined();
    });

    it('allows HMAC send calls before the dispatch decision is made', async () => {
      const auth = new DispatchingAuth({
        hmac: hmockStrategy.strategy,
        e2e: e2eStrategy.strategy,
      });

      const serverAuthPromise = auth.authenticateServer(socket, send);

      // Capture the hmacSend wrapper
      const hmacSend = hmockStrategy.capturedServerAuths[0]?.send;
      expect(hmacSend).toBeDefined();

      // Before any dispatch decision, HMAC challenge must reach the client
      const challenge = { type: 'auth-challenge', nonce: 'abc' };
      hmacSend!(challenge);

      expect(send).toHaveBeenCalledWith(challenge);

      // Choose HMAC route, then resolve.
      auth.handleAuthMessage({ type: 'auth-response', signature: 'ok' }, socket);
      hmockStrategy.resolveServerAuth();
      await expect(serverAuthPromise).resolves.toBeUndefined();
    });
  });

  describe('integration with real strategies', () => {
    it('authenticates E2E client/server through DispatchingAuth when both strategies are configured', async () => {
      const serverId = 'machine-1';
      const deviceId = 'device-1';
      const [serverSigningKeyPair, clientSigningKeyPair] = await Promise.all([
        generateSigningKeyPair(),
        generateSigningKeyPair(),
      ]);

      const serverE2E = new E2EAuth({
        signingKeyPair: serverSigningKeyPair,
        identityId: serverId,
        getPeerSigningKey: async (peerId: string) => (peerId === deviceId ? clientSigningKeyPair.publicKey : null),
        timeout: 1000,
      });
      const clientE2E = new E2EAuth({
        signingKeyPair: clientSigningKeyPair,
        identityId: deviceId,
        peerId: serverId,
        getPeerSigningKey: async (peerId: string) => (peerId === serverId ? serverSigningKeyPair.publicKey : null),
        timeout: 1000,
      });

      const dispatch = new DispatchingAuth({
        hmac: new HmacAuth({ secret: 'dispatch-integration-secret', challengeTimeout: 1000 }),
        e2e: serverE2E,
      });
      const integrationSocket = createSocket();

      const serverPromise = dispatch.authenticateServer(integrationSocket, (message: unknown) => {
        // Route auth frames from server to client strategy.
        clientE2E.handleAuthMessage(message);
      });

      const clientPromise = clientE2E.authenticateClient((message: unknown) => {
        // Route auth frames from client to dispatching server strategy.
        dispatch.handleAuthMessage(message, integrationSocket);
      });

      await Promise.all([serverPromise, clientPromise]);

      // After handshake, auth layer should no longer consume non-auth payloads.
      expect(dispatch.handleAuthMessage({ type: 'post-auth-message' }, integrationSocket)).toBe(false);
    });
  });
});
