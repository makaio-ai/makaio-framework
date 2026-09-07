/**
 * HMAC challenge/response authentication for WebSocket transport.
 *
 * Implements a simple but secure authentication flow:
 * 1. Server sends random nonce to client
 * 2. Client computes HMAC(secret, nonce) and responds
 * 3. Server verifies signature and sends result
 *
 * Uses Web Crypto API for HMAC computation (browser and Node.js compatible).
 */

import type { TransportPeerContext, TransportReceiveContext } from '@makaio/core';
import type { TransportAuth } from './interface.js';
import type { WebSocketLike } from '../types.js';
import { WebSocketConnectionError } from '../connection-error.js';

/**
 * Authentication message types.
 *
 * These are distinct from BusMessage and handled separately.
 */
type AuthMessage =
  | { type: 'auth-challenge'; nonce: string }
  | { type: 'auth-response'; signature: string; identityId?: string }
  | { type: 'auth-result'; success: boolean; error?: string };

/**
 * Shape of an `auth-response` payload: the computed HMAC signature and an
 * optional identity claim for identity-bound mode.
 */
interface AuthResponsePayload {
  signature: string;
  identityId?: string;
}

/**
 * HMAC authentication configuration.
 */
export interface HmacAuthOptions {
  /**
   * Shared secret for HMAC computation.
   *
   * IMPORTANT: This should be a strong, randomly-generated secret.
   * Both client and server must use the same secret.
   *
   * On the server side this field is used for global-secret clients. When
   * `resolveSecret` is also provided, identity-bound clients use their
   * resolved identity secret and clients without an `identityId` continue to
   * use this global secret.
   */
  secret: string;

  /**
   * HMAC algorithm to use.
   * @defaultValue 'sha256'
   */
  algorithm?: string;

  /**
   * Timeout for authentication challenge in milliseconds.
   *
   * If client doesn't respond within this time, authentication fails.
   * @defaultValue 5000
   */
  challengeTimeout?: number;

  /**
   * Client-side identity claim sent alongside the HMAC signature.
   *
   * When set the client includes this value as `identityId` in the
   * `auth-response` frame. The server stores it in
   * `serverAuthenticatedPeers` and exposes it via `getReceiveContext()`.
   *
   * Leave undefined for global-secret mode (backward-compatible default).
   */
  identityId?: string;

  /**
   * Server-side per-identity secret resolver for identity-bound mode.
   *
   * When provided and the client supplies `identityId`, the server calls
   * `resolveSecret(identityId)` and uses the returned secret to verify the
   * HMAC signature. Clients that omit `identityId` continue to authenticate
   * against the global `secret`.
   *
   * Return `null` to reject the connection (unknown identity).
   * @param claimedId - The `identityId` value from the `auth-response` frame.
   * @returns The HMAC secret for this identity, or `null` to reject.
   */
  resolveSecret?: (claimedId: string) => string | null;

  /**
   * Server-side peer context resolver for identity-bound mode.
   *
   * Authenticated identities are exposed to bus handlers only through this
   * trusted resolver. Omitting it authenticates the socket without inventing
   * authorization semantics from the caller-controlled identity ID. Return
   * `null` when no peer context should be exposed.
   * @param claimedId - The authenticated `identityId`.
   * @returns Trusted peer context for the authenticated identity, or `null`.
   */
  resolvePeer?: (claimedId: string) => TransportPeerContext | null;
}

/**
 * Pending authentication state.
 */
interface PendingAuth<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

/**
 * HMAC challenge/response authentication implementation.
 * @example
 * ```typescript
 * const auth = new HmacAuth({
 *   secret: process.env.WEBSOCKET_SECRET,
 *   algorithm: 'sha256',
 *   challengeTimeout: 5000,
 * });
 *
 * const transport = createClientTransport({
 *   websocket: ws,
 *   auth,
 * });
 * ```
 */
export class HmacAuth implements TransportAuth {
  private readonly secret: string;
  private readonly algorithm: string;
  private readonly challengeTimeout: number;
  private readonly identityId: string | undefined;
  private readonly resolveSecret: ((claimedId: string) => string | null) | undefined;
  private readonly resolvePeer: ((claimedId: string) => TransportPeerContext | null) | undefined;

  // Client-side: pending auth operations (single client per instance)
  private pendingChallenge?: PendingAuth<string>;
  private pendingResult?: PendingAuth<{ success: boolean; error?: string }>;
  private queuedChallengeNonce: string | undefined;
  private queuedResult: { success: boolean; error?: string } | undefined;
  private clientAuthComplete = false;

  // Server-side: pending auth operations (multiple concurrent clients)
  private serverPendingResponses = new Map<WebSocketLike, PendingAuth<AuthResponsePayload>>();
  private serverAuthenticatedSockets = new Set<WebSocketLike>();

  /**
   * Maps each successfully authenticated socket to the identity ID it claimed.
   * Populated in identity-bound mode; empty in global-secret mode.
   * Cleaned up in `cleanupSocket()` when the socket disconnects.
   */
  private serverAuthenticatedPeers = new Map<WebSocketLike, string>();

  /**
   * Maps each identity-bound socket to the secret it authenticated with.
   *
   * Used by {@link isSocketAuthenticated} to detect secret rotation: when the
   * registry now holds a different secret for the same identity, the socket is
   * fenced because its handshake credential is stale.
   */
  private serverAuthenticatedSecrets = new Map<WebSocketLike, string>();

  public constructor(options: HmacAuthOptions) {
    this.secret = options.secret;
    this.algorithm = options.algorithm ?? 'sha256';
    this.challengeTimeout = options.challengeTimeout ?? 5000;
    this.identityId = options.identityId;
    this.resolveSecret = options.resolveSecret;
    this.resolvePeer = options.resolvePeer;
  }

  /**
   * Server-side authentication flow.
   *
   * Global-secret mode (default):
   * 1. Generate random nonce
   * 2. Send auth-challenge to client
   * 3. Wait for auth-response with signature (via handleAuthMessage)
   * 4. Verify signature matches HMAC(secret, nonce)
   * 5. Send auth-result
   *
   * Identity-bound mode (`resolveSecret` provided):
   * Same flow, but the `auth-response` also carries `identityId`. The server
   * resolves the per-identity secret via `resolveSecret(identityId)` and
   * verifies HMAC against that secret. On success the socket is registered in
   * `serverAuthenticatedPeers` so `getReceiveContext()` can expose the peer.
   * @param socket - The client WebSocket connection to authenticate
   * @param send - Function to send auth messages to the client
   * @throws Error if authentication fails
   */
  public async authenticateServer(socket: WebSocketLike, send: (message: unknown) => void): Promise<void> {
    // Generate random nonce using Web Crypto API
    const randomBuffer = crypto.getRandomValues(new Uint8Array(32));
    const nonce = Array.from(randomBuffer)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Install the per-socket owner before sending or awaiting anything. It stays
    // registered through crypto so cleanupSocket also fences that async phase.
    const response = this.waitForAuthResponseWithIdentity(socket);
    const owner = this.serverPendingResponses.get(socket)!;
    void response.catch(() => undefined);
    // Only a verified refusal emits auth-result:false. Timeout, disconnect or
    // crypto failure must not masquerade as rejected credentials on the peer.
    try {
      send({ type: 'auth-challenge', nonce } satisfies AuthMessage);
      const { signature, identityId } = await response;
      this.assertServerOwner(socket, owner);

      let expectedSignature: string;
      if (this.resolveSecret && identityId !== undefined) {
        // Identity-bound mode: resolve the per-identity secret.
        const identitySecret = this.resolveSecret(identityId);
        if (identitySecret === null) {
          this.sendAuthResultBestEffort(send, {
            type: 'auth-result',
            success: false,
            error: 'Unknown identity',
          });
          throw new WebSocketConnectionError(
            'WS_AUTHENTICATION_REJECTED',
            `HMAC authentication failed: Unknown identity '${identityId}'`,
          );
        }
        expectedSignature = await this.computeHmacWithSecret(nonce, identitySecret);
        this.assertServerOwner(socket, owner);
        if (this.constantTimeEqual(signature, expectedSignature)) {
          // Persist the authenticated identity for getReceiveContext().
          this.serverAuthenticatedPeers.set(socket, identityId);
          // Record the secret used during this handshake so
          // isSocketAuthenticated can detect post-auth rotation.
          this.serverAuthenticatedSecrets.set(socket, identitySecret);
        }
      } else {
        // Global-secret mode: use the global shared secret.
        expectedSignature = await this.computeHmac(nonce);
        this.assertServerOwner(socket, owner);
      }

      // Verify signature using constant-time comparison to prevent timing attacks.
      if (!this.constantTimeEqual(signature, expectedSignature)) {
        this.sendAuthResultBestEffort(send, {
          type: 'auth-result',
          success: false,
          error: 'Invalid signature',
        });
        throw new WebSocketConnectionError(
          'WS_AUTHENTICATION_REJECTED',
          'HMAC authentication failed: Invalid signature',
        );
      }

      // Admission requires a delivered positive verdict. Unlike a refusal,
      // failure to send success must fail the handshake, not authorize the socket.
      try {
        send({ type: 'auth-result', success: true } satisfies AuthMessage);
        this.assertServerOwner(socket, owner);
      } catch (error) {
        if (this.serverPendingResponses.get(socket) === owner) this.cleanupSocket(socket);
        throw error;
      }
      this.serverAuthenticatedSockets.add(socket);
    } finally {
      clearTimeout(owner.timeoutHandle);
      if (this.serverPendingResponses.get(socket) === owner) this.serverPendingResponses.delete(socket);
    }
  }

  /**
   * Client-side authentication flow.
   *
   * 1. Wait for auth-challenge from server (via handleAuthMessage)
   * 2. Compute signature = HMAC(secret, nonce)
   * 3. Send auth-response with signature
   * 4. Wait for auth-result (via handleAuthMessage)
   * 5. Throw if authentication failed
   * @param send - Function to send auth messages to the server
   * @throws Error if authentication fails
   */
  public async authenticateClient(send: (message: unknown) => void): Promise<void> {
    this.clientAuthComplete = false;
    const challenge = this.waitForAuthChallenge();
    // Keep the same pending object through crypto/result awaits, even after
    // the challenge resolved; cleanup can then invalidate every continuation.
    const owner = this.pendingChallenge!;
    try {
      const nonce = await challenge;
      this.assertClientOwner(owner);

      // Compute signature
      const signature = await this.computeHmac(nonce);
      this.assertClientOwner(owner);

      // Send response — include identityId when operating in identity-bound mode.
      const response: AuthMessage = {
        type: 'auth-response',
        signature,
        ...(this.identityId !== undefined && { identityId: this.identityId }),
      };
      send(response);
      this.assertClientOwner(owner);

      // Wait for result via handleAuthMessage
      const result = await this.waitForAuthResult();
      this.assertClientOwner(owner);

      if (!result.success) {
        throw new WebSocketConnectionError(
          'WS_AUTHENTICATION_REJECTED',
          `HMAC authentication failed: ${result.error ?? 'Unknown error'}`,
        );
      }

      this.clientAuthComplete = true;
    } finally {
      clearTimeout(owner.timeoutHandle);
      if (this.pendingChallenge === owner) this.pendingChallenge = undefined;
    }
  }

  /**
   * Fence a client continuation whose handshake was cleaned up or replaced.
   * @param owner - Pending challenge retained for the entire handshake.
   */
  private assertClientOwner(owner: PendingAuth<string>): void {
    if (this.pendingChallenge !== owner) {
      throw new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Socket disconnected during HMAC authentication');
    }
  }

  /**
   * Fence server crypto completion after socket cleanup.
   * @param socket - Authenticating socket.
   * @param owner - Pending response retained until authentication finishes.
   */
  private assertServerOwner(socket: WebSocketLike, owner: PendingAuth<AuthResponsePayload>): void {
    if (this.serverPendingResponses.get(socket) !== owner) {
      throw new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Socket disconnected during HMAC authentication');
    }
  }

  /**
   * Handle incoming message during authentication phase.
   *
   * Routes auth messages to the appropriate pending operation.
   * ALWAYS consumes auth message types to prevent them from leaking to regular handlers.
   * @param message - Parsed message object
   * @param socket - Optional socket identifier for server-side multi-client scenarios
   * @returns true if the message was an auth message (consumed regardless of pending state)
   */
  public handleAuthMessage(message: unknown, socket?: WebSocketLike): boolean {
    // Validate message structure
    if (typeof message !== 'object' || !message) {
      return false;
    }

    // Validate 'type' field exists and is a string BEFORE casting
    if (!('type' in message) || typeof message.type !== 'string') {
      return false;
    }

    const msg = message as AuthMessage;

    // Client-side: handle challenge from server
    if (msg.type === 'auth-challenge') {
      if (typeof msg.nonce !== 'string') {
        return true;
      }
      if (this.clientAuthComplete) {
        return true;
      }
      if (this.pendingChallenge) {
        clearTimeout(this.pendingChallenge.timeoutHandle);
        this.pendingChallenge.resolve(msg.nonce);
      } else {
        this.queuedChallengeNonce = msg.nonce;
      }
      // Always consume auth-challenge messages (even if no pending state)
      return true;
    }

    // Client-side: handle result from server
    if (msg.type === 'auth-result') {
      if (typeof msg.success !== 'boolean') {
        return true;
      }
      if (this.clientAuthComplete) {
        return true;
      }
      // Diagnostics are untrusted JSON too; only strings may enter error messages.
      const result = { success: msg.success, error: typeof msg.error === 'string' ? msg.error : undefined };
      if (this.pendingResult) {
        clearTimeout(this.pendingResult.timeoutHandle);
        this.pendingResult.resolve(result);
        this.pendingResult = undefined;
      } else {
        this.queuedResult = result;
      }
      // Always consume auth-result messages (even if no pending state)
      return true;
    }

    // Server-side: handle response from client
    if (msg.type === 'auth-response') {
      if (socket) {
        const pendingEntry = this.serverPendingResponses.get(socket);
        if (pendingEntry) {
          clearTimeout(pendingEntry.timeoutHandle);
          if (msg.identityId !== undefined && typeof msg.identityId !== 'string') {
            pendingEntry.reject(new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Malformed HMAC identity'));
            return true;
          }
          pendingEntry.resolve({ signature: msg.signature, identityId: msg.identityId });
          // Note: Map entry will be cleaned up in authenticateServer
        }
      }
      // Always consume auth-response messages (even if no pending state)
      return true;
    }

    return false;
  }

  /**
   * Wait for auth-challenge message from server.
   *
   * Message will be delivered via handleAuthMessage().
   * @returns The nonce from the challenge
   * @throws Error if timeout
   */
  private async waitForAuthChallenge(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new WebSocketConnectionError('WS_HANDSHAKE_TIMEOUT', 'Authentication challenge timeout'));
      }, this.challengeTimeout);

      this.pendingChallenge = { resolve, reject, timeoutHandle };
      if (this.queuedChallengeNonce !== undefined) {
        clearTimeout(timeoutHandle);
        resolve(this.queuedChallengeNonce);
        this.queuedChallengeNonce = undefined;
      }
    });
  }

  /**
   * Wait for auth-response message from client.
   *
   * Message will be delivered via handleAuthMessage().
   * @param socket - The client socket to track
   * @returns The signature and optional identity ID from the response
   * @throws Error if timeout
   */
  private async waitForAuthResponseWithIdentity(socket: WebSocketLike): Promise<AuthResponsePayload> {
    return new Promise<AuthResponsePayload>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new WebSocketConnectionError('WS_HANDSHAKE_TIMEOUT', 'Authentication response timeout'));
      }, this.challengeTimeout);

      const pending: PendingAuth<AuthResponsePayload> = { resolve, reject, timeoutHandle };
      this.serverPendingResponses.set(socket, pending);
    });
  }

  /**
   * Wait for auth-result message from server.
   *
   * Message will be delivered via handleAuthMessage().
   * @returns The authentication result
   * @throws Error if timeout
   */
  private async waitForAuthResult(): Promise<{ success: boolean; error?: string }> {
    if (this.queuedResult !== undefined) {
      const result = this.queuedResult;
      this.queuedResult = undefined;
      return result;
    }

    return new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingResult = undefined;
        reject(new WebSocketConnectionError('WS_HANDSHAKE_TIMEOUT', 'Authentication result timeout'));
      }, this.challengeTimeout);

      this.pendingResult = { resolve, reject, timeoutHandle };
    });
  }

  /**
   * Compute HMAC signature for a nonce using the instance secret.
   * @param nonce - The nonce to sign
   * @returns Promise resolving to hex-encoded HMAC signature
   */
  private async computeHmac(nonce: string): Promise<string> {
    return this.computeHmacWithSecret(nonce, this.secret);
  }

  /**
   * Compute HMAC signature for a nonce using an explicit secret.
   * @param nonce - The nonce to sign
   * @param secret - Secret to use for key derivation
   * @returns Promise resolving to hex-encoded HMAC signature
   */
  private async computeHmacWithSecret(nonce: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);

    // Map algorithm name to Web Crypto API format (e.g., 'sha256' -> 'SHA-256')
    const webCryptoHash = this.algorithm.replace(/^sha/, 'SHA-');

    // Import the secret as a CryptoKey
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: webCryptoHash }, false, ['sign']);

    // Compute HMAC
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(nonce));

    // Convert ArrayBuffer to hex string
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Return trusted receive context for a socket that has authenticated
   * in identity-bound mode.
   *
   * For global-secret clients this returns `undefined` — there is no
   * per-identity peer to expose.
   *
   * The `transportName` is intentionally left as `''` here; the transport
   * registry merges in the registered name when it synthesises the effective
   * receive context (§1.3 of the bus-origin design).
   * @param socket - The socket whose peer identity to retrieve.
   * @returns Trusted receive context with peer identity, or `undefined`.
   */
  public getReceiveContext(socket?: WebSocketLike): TransportReceiveContext | undefined {
    if (!socket) {
      return undefined;
    }
    const identityId = this.serverAuthenticatedPeers.get(socket);
    if (identityId === undefined) {
      return undefined;
    }
    const resolvedPeer = this.resolvePeer?.(identityId);
    if (resolvedPeer === undefined || resolvedPeer === null) {
      return undefined;
    }
    return {
      transportName: '',
      peer: { ...resolvedPeer, id: resolvedPeer.id ?? identityId, authenticated: true },
    };
  }

  /**
   * Check whether a server-side socket remains authorized for bus traffic.
   *
   * Identity-bound HMAC sockets are revalidated against `resolveSecret()` on
   * every inbound frame so process-local registry revocation, such as dashboard
   * session expiry, takes effect without waiting for the WebSocket to close.
   * Global-secret sockets have no identity to revoke and remain authorized by
   * their completed handshake.
   * @param socket - The socket whose live authorization should be checked.
   * @returns `true` when the socket is still authorized.
   */
  public isSocketAuthenticated(socket: WebSocketLike): boolean {
    if (!this.serverAuthenticatedSockets.has(socket)) {
      return false;
    }
    if (!this.resolveSecret) {
      return true;
    }

    const identityId = this.serverAuthenticatedPeers.get(socket);
    if (identityId === undefined) {
      return true;
    }

    const currentSecret = this.resolveSecret(identityId);
    if (currentSecret === null) {
      this.cleanupSocket(socket);
      return false;
    }

    // Detect secret rotation: if the registry now holds a different secret
    // than the one this socket authenticated with, the credential is stale
    // and the socket must be fenced.
    const authenticatedSecret = this.serverAuthenticatedSecrets.get(socket);
    if (authenticatedSecret !== undefined && currentSecret !== authenticatedSecret) {
      this.cleanupSocket(socket);
      return false;
    }

    return true;
  }

  /**
   * Compare two hex-encoded HMAC signatures in constant time.
   *
   * A variable-time `===` comparison leaks information about how many prefix
   * characters match, enabling timing-based secret recovery. This method decodes
   * both signatures to byte arrays and uses a constant-time XOR accumulator so
   * every comparison takes the same wall-clock time regardless of the match point.
   * @param a - Untrusted signature received from the peer
   * @param b - Second hex signature
   * @returns True when both signatures are identical
   */
  private constantTimeEqual(a: unknown, b: string): boolean {
    // Peer JSON is not made trustworthy by the AuthMessage cast. Malformed
    // signatures follow the same typed refusal path as incorrect signatures.
    if (typeof a !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) {
      return false;
    }
    const aBytes = new Uint8Array(a.length / 2);
    const bBytes = new Uint8Array(b.length / 2);
    for (let i = 0; i < aBytes.length; i++) {
      aBytes[i] = parseInt(a.slice(i * 2, i * 2 + 2), 16);
      bBytes[i] = parseInt(b.slice(i * 2, i * 2 + 2), 16);
    }
    let diff = 0;
    for (let i = 0; i < aBytes.length; i++) {
      diff |= aBytes[i]! ^ bBytes[i]!;
    }
    return diff === 0;
  }

  /**
   * Send negative auth results without masking the original auth error.
   *
   * Disconnect races can make `send` throw after auth already failed; callers
   * should still observe the original failure reason.
   * @param send - Transport send function
   * @param message - Auth result message payload
   */
  private sendAuthResultBestEffort(send: (message: unknown) => void, message: AuthMessage): void {
    try {
      send(message);
    } catch {
      // Socket closed while sending auth result; original auth outcome still stands.
    }
  }

  /**
   * Clean up authentication resources for a specific socket.
   *
   * Called when a socket disconnects to immediately release resources
   * and prevent memory leaks during the authentication timeout window.
   * @param socket - The socket to clean up
   */
  public cleanupSocket(socket: WebSocketLike): void {
    const pendingEntry = this.serverPendingResponses.get(socket);
    if (pendingEntry) {
      clearTimeout(pendingEntry.timeoutHandle);
      this.serverPendingResponses.delete(socket);
      pendingEntry.reject(
        new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Socket disconnected during HMAC authentication'),
      );
    }
    this.serverAuthenticatedPeers.delete(socket);
    this.serverAuthenticatedSecrets.delete(socket);
    this.serverAuthenticatedSockets.delete(socket);
  }

  /**
   * Clean up authentication resources.
   *
   * Clears any pending authentication operations and their timeouts.
   */
  public cleanup(): void {
    // Client-side cleanup
    if (this.pendingChallenge) {
      clearTimeout(this.pendingChallenge.timeoutHandle);
      this.pendingChallenge.reject(
        new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Socket disconnected during HMAC authentication'),
      );
      this.pendingChallenge = undefined;
    }
    if (this.pendingResult) {
      clearTimeout(this.pendingResult.timeoutHandle);
      this.pendingResult.reject(
        new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Socket disconnected during HMAC authentication'),
      );
      this.pendingResult = undefined;
    }
    this.queuedChallengeNonce = undefined;
    this.queuedResult = undefined;
    this.clientAuthComplete = false;

    // Server-side cleanup: clear all pending responses
    for (const entry of this.serverPendingResponses.values()) {
      clearTimeout(entry.timeoutHandle);
      entry.reject(
        new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Socket disconnected during HMAC authentication'),
      );
    }
    this.serverPendingResponses.clear();
    this.serverAuthenticatedPeers.clear();
    this.serverAuthenticatedSecrets.clear();
    this.serverAuthenticatedSockets.clear();
  }
}
