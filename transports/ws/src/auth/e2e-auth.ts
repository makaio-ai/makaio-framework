/**
 * E2E (End-to-End) authenticated encryption for WebSocket transport.
 *
 * Implements ephemeral ECDH key exchange with ECDSA signature authentication.
 * After successful handshake, provides a session encryption key for encrypting/decrypting bus messages.
 */

import type { TransportReceiveContext } from '@makaio/core';
import type { TransportAuth } from './interface.js';
import type { WebSocketLike } from '../types.js';
import { WebSocketConnectionError } from '../connection-error.js';
import {
  generateAndSignEphemeralKey,
  verifyEphemeralKeySignature,
  deriveE2ESessionKey,
  generateSaltHex,
} from './e2e-crypto-helpers.js';

/**
 * E2E authentication message types.
 */
type E2EAuthMessage =
  | { type: 'e2e-key-exchange'; deviceId: string; ephemeralPublicKey: string; signature: string }
  | { type: 'e2e-key-exchange-response'; ephemeralPublicKey: string; signature: string; salt: string }
  | { type: 'e2e-auth-result'; success: boolean; error?: string };

/**
 * E2E authentication configuration.
 */
export interface E2EAuthOptions {
  /** Our static identity keypair for signing (ECDSA P-256) */
  signingKeyPair: CryptoKeyPair;
  /** Our identifier (deviceId for browser, machineId for server) */
  identityId: string;
  /** Expected peer identifier (required for browser connections; machineId from QR payload) */
  peerId?: string;
  /** Lookup peer's signing public key by their identity */
  getPeerSigningKey: (peerId: string) => Promise<CryptoKey | null>;
  /** Auth timeout in milliseconds. @defaultValue 10000 */
  timeout?: number;
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
 * Per-socket session data after successful authentication.
 */
interface SessionData {
  sessionKey: CryptoKey;
  peerId: string;
}

/**
 * Validate the wire representation before peer data reaches crypto helpers.
 * @param publicKey - Base64url-encoded SPKI data from the peer.
 * @param signature - Hex-encoded P-256 ECDSA signature from the peer.
 * @returns Whether both fields have the representation produced by this protocol.
 */
function hasValidKeyMaterial(publicKey: unknown, signature: unknown): boolean {
  return (
    typeof publicKey === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(publicKey) &&
    publicKey.length % 4 !== 1 &&
    typeof signature === 'string' &&
    /^[0-9a-f]{128}$/i.test(signature)
  );
}

/**
 * Validate the responder's key material and HKDF salt as one protocol payload.
 * @param response - Untrusted fields from a key-exchange response.
 * @returns Whether the response has the representation produced by this protocol.
 */
function hasValidKeyExchangeResponse(response: {
  ephemeralPublicKey: unknown;
  signature: unknown;
  salt: unknown;
}): boolean {
  return (
    hasValidKeyMaterial(response.ephemeralPublicKey, response.signature) &&
    typeof response.salt === 'string' &&
    /^[0-9a-f]{32}$/i.test(response.salt)
  );
}

/**
 * E2E authenticated encryption implementation.
 */
export class E2EAuth implements TransportAuth {
  private readonly signingKeyPair: CryptoKeyPair;
  private readonly identityId: string;
  private readonly peerId?: string;
  private readonly getPeerSigningKey: (peerId: string) => Promise<CryptoKey | null>;
  private readonly timeout: number;

  // Client-side state
  private pendingKeyExchange?: PendingAuth<{ ephemeralPublicKey: string; signature: string; salt: string }>;
  private pendingResult?: PendingAuth<{ success: boolean; error?: string }>;
  private clientSession?: SessionData;
  private clientEphemeralKeyPair?: CryptoKeyPair;

  // Server-side state
  private serverPendingKeyExchange = new Map<
    WebSocketLike,
    PendingAuth<{ deviceId: string; ephemeralPublicKey: string; signature: string }>
  >();
  private serverSessions = new Map<WebSocketLike, SessionData>();
  private serverEphemeralKeyPairs = new Map<WebSocketLike, CryptoKeyPair>();

  public constructor(options: E2EAuthOptions) {
    this.signingKeyPair = options.signingKeyPair;
    this.identityId = options.identityId;
    this.peerId = options.peerId;
    this.getPeerSigningKey = options.getPeerSigningKey;
    this.timeout = options.timeout ?? 10000;
  }

  /**
   * Client-side authentication flow.
   *
   * If an error occurs after pending promises are created, they are cleaned up
   * before rethrowing to prevent unhandled rejections from lingering timeouts.
   * @param send - Function to send auth messages to the server
   */
  public async authenticateClient(send: (message: unknown) => void): Promise<void> {
    // Missing local configuration is not an authentication verdict from a peer.
    if (!this.peerId) {
      throw new Error('E2E authentication failed: peerId is required for client authentication');
    }

    // The existing pending exchange owns the entire handshake, including crypto
    // and key lookup. Cleanup invalidates it; stale continuations cannot publish
    // a session or clear a replacement handshake's state.
    const responsePromise = this.waitForKeyExchangeResponse();
    const owner = this.pendingKeyExchange!;
    const resultPromise = this.waitForAuthResult();
    void responsePromise.catch(() => undefined);
    void resultPromise.catch(() => undefined);
    try {
      const { ephemeralKeyPair, ephemeralPublicKey, signature } = await generateAndSignEphemeralKey(
        this.signingKeyPair.privateKey,
        this.identityId,
      );
      this.assertClientOwner(owner);
      this.clientEphemeralKeyPair = ephemeralKeyPair;

      send({ type: 'e2e-key-exchange', deviceId: this.identityId, ephemeralPublicKey, signature });
      this.assertClientOwner(owner);

      const response = await responsePromise;
      this.assertClientOwner(owner);

      const serverPublicKey = await this.getPeerSigningKey(this.peerId);
      this.assertClientOwner(owner);
      if (!serverPublicKey)
        throw new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'E2E authentication failed: Unknown server');

      const isValid = await verifyEphemeralKeySignature(
        serverPublicKey,
        response.ephemeralPublicKey,
        response.signature,
        this.peerId,
      );
      this.assertClientOwner(owner);
      if (!isValid)
        throw new WebSocketConnectionError(
          'WS_AUTHENTICATION_REJECTED',
          'E2E authentication failed: Invalid server signature',
        );

      const sessionKey = await deriveE2ESessionKey(
        ephemeralKeyPair.privateKey,
        response.ephemeralPublicKey,
        response.salt,
        'makaio-e2e-session-v1',
      );
      this.assertClientOwner(owner);

      const result = await resultPromise;
      this.assertClientOwner(owner);
      if (!result.success)
        throw new WebSocketConnectionError(
          'WS_AUTHENTICATION_REJECTED',
          `E2E authentication failed: ${result.error ?? 'Unknown error'}`,
        );
      this.clientSession = { sessionKey, peerId: this.peerId };
    } catch (error) {
      if (this.pendingKeyExchange === owner) {
        this.clientSession = undefined;
        this.clientEphemeralKeyPair = undefined;
      }
      throw error;
    } finally {
      clearTimeout(owner.timeoutHandle);
      if (this.pendingKeyExchange === owner) {
        this.pendingKeyExchange = undefined;
        if (this.pendingResult) clearTimeout(this.pendingResult.timeoutHandle);
        this.pendingResult = undefined;
      }
    }
  }

  /**
   * Server-side authentication flow.
   * @param socket - The client WebSocket connection to authenticate
   * @param send - Function to send auth messages to the client
   */
  public async authenticateServer(socket: WebSocketLike, send: (message: unknown) => void): Promise<void> {
    const exchangePromise = this.waitForClientKeyExchange(socket);
    const owner = this.serverPendingKeyExchange.get(socket)!;
    try {
      const clientKeyExchange = await exchangePromise;
      this.assertServerOwner(socket, owner);

      const devicePublicKey = await this.getPeerSigningKey(clientKeyExchange.deviceId);
      this.assertServerOwner(socket, owner);
      if (!devicePublicKey) {
        throw new WebSocketConnectionError(
          'WS_AUTHENTICATION_REJECTED',
          `E2E authentication failed: Unknown device ${clientKeyExchange.deviceId}`,
        );
      }

      const isValid = await verifyEphemeralKeySignature(
        devicePublicKey,
        clientKeyExchange.ephemeralPublicKey,
        clientKeyExchange.signature,
        clientKeyExchange.deviceId,
      );
      this.assertServerOwner(socket, owner);
      if (!isValid) {
        throw new WebSocketConnectionError(
          'WS_AUTHENTICATION_REJECTED',
          'E2E authentication failed: Invalid client signature',
        );
      }

      const { ephemeralKeyPair, ephemeralPublicKey, signature } = await generateAndSignEphemeralKey(
        this.signingKeyPair.privateKey,
        this.identityId,
      );
      this.assertServerOwner(socket, owner);
      const salt = generateSaltHex();
      this.serverEphemeralKeyPairs.set(socket, ephemeralKeyPair);

      send({ type: 'e2e-key-exchange-response', ephemeralPublicKey, signature, salt });
      this.assertServerOwner(socket, owner);

      const sessionKey = await deriveE2ESessionKey(
        ephemeralKeyPair.privateKey,
        clientKeyExchange.ephemeralPublicKey,
        salt,
        'makaio-e2e-session-v1',
      );
      this.assertServerOwner(socket, owner);

      this.serverSessions.set(socket, { sessionKey, peerId: clientKeyExchange.deviceId });
      send({ type: 'e2e-auth-result', success: true });
      this.assertServerOwner(socket, owner);
    } catch (error) {
      if (this.serverPendingKeyExchange.get(socket) === owner) {
        this.serverEphemeralKeyPairs.delete(socket);
        this.serverSessions.delete(socket);
        // Only a genuine credential refusal produces a negative auth frame.
        // Timer/lookup/crypto failures retain their own category, never rejection.
        try {
          if (error instanceof WebSocketConnectionError && error.code === 'WS_AUTHENTICATION_REJECTED') {
            send({
              type: 'e2e-auth-result',
              success: false,
              error: error.message,
            });
          }
        } catch {
          // A closed socket cannot mask the original authentication failure.
        }
      }
      throw error;
    } finally {
      clearTimeout(owner.timeoutHandle);
      if (this.serverPendingKeyExchange.get(socket) === owner) this.serverPendingKeyExchange.delete(socket);
    }
  }

  /**
   * Reject a client continuation whose handshake was cleaned up or replaced.
   * @param owner - Pending exchange that owns the handshake.
   */
  private assertClientOwner(owner: NonNullable<E2EAuth['pendingKeyExchange']>): void {
    if (this.pendingKeyExchange !== owner) {
      throw new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Connection closed during E2E authentication');
    }
  }

  /**
   * Reject server work that outlived its socket handshake.
   * @param socket - Authenticating socket.
   * @param owner - Pending exchange that owns this socket handshake.
   */
  private assertServerOwner(
    socket: WebSocketLike,
    owner: PendingAuth<{ deviceId: string; ephemeralPublicKey: string; signature: string }>,
  ): void {
    if (this.serverPendingKeyExchange.get(socket) !== owner) {
      throw new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Connection closed during E2E authentication');
    }
  }

  /**
   * Handle incoming message during authentication phase.
   * @param message - Parsed message object
   * @param socket - Optional socket identifier for server-side
   * @returns true if the message was an E2E auth message
   */
  public handleAuthMessage(message: unknown, socket?: WebSocketLike): boolean {
    if (typeof message !== 'object' || !message || !('type' in message) || typeof message.type !== 'string') {
      return false;
    }

    const msg = message as E2EAuthMessage;

    if (msg.type === 'e2e-key-exchange-response') {
      if (this.pendingKeyExchange) {
        clearTimeout(this.pendingKeyExchange.timeoutHandle);
        // A typed message cast does not validate peer JSON. Refuse malformed
        // protocol data here; crypto/provider exceptions retain their own meaning.
        if (!hasValidKeyExchangeResponse(msg)) {
          this.pendingKeyExchange.reject(
            new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Malformed E2E key exchange response'),
          );
          return true;
        }
        this.pendingKeyExchange.resolve({
          ephemeralPublicKey: msg.ephemeralPublicKey,
          signature: msg.signature,
          salt: msg.salt,
        });
      }
      return true;
    }

    if (msg.type === 'e2e-auth-result') {
      // Only an actual boolean is a peer verdict; malformed JSON must neither
      // approve authentication via truthiness nor fabricate an explicit refusal.
      if (typeof msg.success !== 'boolean') return true;
      // A diagnostic object must not throw during coercion and strand the exchange.
      const errorMessage = typeof msg.error === 'string' ? msg.error : undefined;
      if (!msg.success && this.pendingKeyExchange) {
        clearTimeout(this.pendingKeyExchange.timeoutHandle);
        this.pendingKeyExchange.reject(
          new WebSocketConnectionError(
            'WS_AUTHENTICATION_REJECTED',
            `E2E authentication failed: ${errorMessage ?? 'Unknown error'}`,
          ),
        );
      }
      if (this.pendingResult) {
        clearTimeout(this.pendingResult.timeoutHandle);
        this.pendingResult.resolve({ success: msg.success, error: errorMessage });
        this.pendingResult = undefined;
      }
      return true;
    }

    if (msg.type === 'e2e-key-exchange' && socket) {
      const pendingEntry = this.serverPendingKeyExchange.get(socket);
      if (pendingEntry) {
        clearTimeout(pendingEntry.timeoutHandle);
        if (typeof msg.deviceId !== 'string' || !hasValidKeyMaterial(msg.ephemeralPublicKey, msg.signature)) {
          pendingEntry.reject(new WebSocketConnectionError('WS_AUTHENTICATION_REJECTED', 'Malformed E2E key exchange'));
          return true;
        }
        pendingEntry.resolve({
          deviceId: msg.deviceId,
          ephemeralPublicKey: msg.ephemeralPublicKey,
          signature: msg.signature,
        });
      }
      return true;
    }

    return false;
  }

  private async waitForKeyExchangeResponse(): Promise<{
    ephemeralPublicKey: string;
    signature: string;
    salt: string;
  }> {
    return new Promise<{ ephemeralPublicKey: string; signature: string; salt: string }>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new WebSocketConnectionError('WS_HANDSHAKE_TIMEOUT', 'E2E key exchange timeout'));
      }, this.timeout);

      this.pendingKeyExchange = { resolve, reject, timeoutHandle };
    });
  }

  private async waitForAuthResult(): Promise<{ success: boolean; error?: string }> {
    return new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingResult = undefined;
        reject(new WebSocketConnectionError('WS_HANDSHAKE_TIMEOUT', 'E2E authentication result timeout'));
      }, this.timeout);

      this.pendingResult = { resolve, reject, timeoutHandle };
    });
  }

  private async waitForClientKeyExchange(socket: WebSocketLike): Promise<{
    deviceId: string;
    ephemeralPublicKey: string;
    signature: string;
  }> {
    return new Promise<{ deviceId: string; ephemeralPublicKey: string; signature: string }>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new WebSocketConnectionError('WS_HANDSHAKE_TIMEOUT', 'E2E key exchange timeout'));
      }, this.timeout);

      const pending: PendingAuth<{ deviceId: string; ephemeralPublicKey: string; signature: string }> = {
        resolve,
        reject,
        timeoutHandle,
      };
      this.serverPendingKeyExchange.set(socket, pending);
    });
  }

  /**
   * Get the derived AES-256-GCM session key for encrypting/decrypting payloads.
   * @param socket - Optional socket (server-side only)
   * @returns Session key if authenticated, null otherwise
   */
  public getSessionKey(socket?: WebSocketLike): CryptoKey | null {
    if (socket) return this.serverSessions.get(socket)?.sessionKey ?? null;
    return this.clientSession?.sessionKey ?? null;
  }

  /**
   * Get the peer's identity ID authenticated during handshake.
   * @param socket - Optional socket (server-side only)
   * @returns Peer ID if authenticated, null otherwise
   */
  public getPeerId(socket?: WebSocketLike): string | null {
    if (socket) return this.serverSessions.get(socket)?.peerId ?? null;
    return this.clientSession?.peerId ?? null;
  }

  /**
   * Return trusted receive context for a socket that has completed E2E authentication.
   *
   * The `transportName` is intentionally left as `''` here; the transport
   * registry merges in the registered name when it synthesises the effective
   * receive context.
   * @param socket - Optional socket (server-side only)
   * @returns Trusted receive context with peer identity, or `undefined`.
   */
  public getReceiveContext(socket?: WebSocketLike): TransportReceiveContext | undefined {
    const peerId = this.getPeerId(socket);
    if (peerId === null) {
      return undefined;
    }
    return {
      transportName: '',
      peer: { kind: 'e2e', id: peerId, authenticated: true, encrypted: true },
    };
  }

  /**
   * Clean up authentication resources for a specific socket.
   * @param socket - The socket to clean up
   */
  public cleanupSocket(socket: WebSocketLike): void {
    const pendingEntry = this.serverPendingKeyExchange.get(socket);
    if (pendingEntry) {
      clearTimeout(pendingEntry.timeoutHandle);
      pendingEntry.reject(
        new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Connection closed during E2E authentication'),
      );
      this.serverPendingKeyExchange.delete(socket);
    }

    this.serverSessions.delete(socket);
    this.serverEphemeralKeyPairs.delete(socket);
  }

  /**
   * Clean up authentication resources.
   */
  public cleanup(): void {
    if (this.pendingKeyExchange) {
      clearTimeout(this.pendingKeyExchange.timeoutHandle);
      this.pendingKeyExchange.reject(
        new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Connection closed during E2E authentication'),
      );
      this.pendingKeyExchange = undefined;
    }
    if (this.pendingResult) {
      clearTimeout(this.pendingResult.timeoutHandle);
      this.pendingResult.reject(
        new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Connection closed during E2E authentication'),
      );
      this.pendingResult = undefined;
    }
    this.clientSession = undefined;
    this.clientEphemeralKeyPair = undefined;

    for (const entry of this.serverPendingKeyExchange.values()) {
      clearTimeout(entry.timeoutHandle);
      entry.reject(
        new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'Connection closed during E2E authentication'),
      );
    }
    this.serverPendingKeyExchange.clear();
    this.serverSessions.clear();
    this.serverEphemeralKeyPairs.clear();
  }
}
