/**
 * E2E (End-to-End) authenticated encryption for WebSocket transport.
 *
 * Implements ephemeral ECDH key exchange with ECDSA signature authentication.
 * After successful handshake, provides a session encryption key for encrypting/decrypting bus messages.
 */

import type { TransportReceiveContext } from '@makaio/core';
import type { TransportAuth } from './interface.js';
import type { WebSocketLike } from '../types.js';
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
    if (!this.peerId) {
      throw new Error('E2E authentication failed: peerId is required for client authentication');
    }

    const { ephemeralKeyPair, ephemeralPublicKey, signature } = await generateAndSignEphemeralKey(
      this.signingKeyPair.privateKey,
      this.identityId,
    );
    this.clientEphemeralKeyPair = ephemeralKeyPair;

    try {
      const responsePromise = this.waitForKeyExchangeResponse();
      const resultPromise = this.waitForAuthResult();

      send({ type: 'e2e-key-exchange', deviceId: this.identityId, ephemeralPublicKey, signature });

      const response = await responsePromise;

      const serverPublicKey = await this.getPeerSigningKey(this.peerId);
      if (!serverPublicKey) throw new Error('E2E authentication failed: Unknown server');

      const isValid = await verifyEphemeralKeySignature(
        serverPublicKey,
        response.ephemeralPublicKey,
        response.signature,
        this.peerId,
      );
      if (!isValid) throw new Error('E2E authentication failed: Invalid server signature');

      const sessionKey = await deriveE2ESessionKey(
        ephemeralKeyPair.privateKey,
        response.ephemeralPublicKey,
        response.salt,
        'makaio-e2e-session-v1',
      );

      this.clientSession = { sessionKey, peerId: this.peerId };

      const result = await resultPromise;
      if (!result.success) throw new Error(`E2E authentication failed: ${result.error ?? 'Unknown error'}`);
    } catch (error) {
      // Clear pending promises to prevent lingering timeouts
      if (this.pendingKeyExchange) {
        clearTimeout(this.pendingKeyExchange.timeoutHandle);
        this.pendingKeyExchange = undefined;
      }
      if (this.pendingResult) {
        clearTimeout(this.pendingResult.timeoutHandle);
        this.pendingResult = undefined;
      }
      // Clear client auth state so getSessionKey() won't return a key after failed auth
      this.clientSession = undefined;
      this.clientEphemeralKeyPair = undefined;
      throw error;
    }
  }

  /**
   * Server-side authentication flow.
   * @param socket - The client WebSocket connection to authenticate
   * @param send - Function to send auth messages to the client
   */
  public async authenticateServer(socket: WebSocketLike, send: (message: unknown) => void): Promise<void> {
    try {
      const clientKeyExchange = await this.waitForClientKeyExchange(socket);

      const devicePublicKey = await this.getPeerSigningKey(clientKeyExchange.deviceId);
      if (!devicePublicKey) {
        send({ type: 'e2e-auth-result', success: false, error: 'Unknown device' });
        throw new Error(`E2E authentication failed: Unknown device ${clientKeyExchange.deviceId}`);
      }

      const isValid = await verifyEphemeralKeySignature(
        devicePublicKey,
        clientKeyExchange.ephemeralPublicKey,
        clientKeyExchange.signature,
        clientKeyExchange.deviceId,
      );
      if (!isValid) {
        send({ type: 'e2e-auth-result', success: false, error: 'Invalid signature' });
        throw new Error('E2E authentication failed: Invalid client signature');
      }

      const { ephemeralKeyPair, ephemeralPublicKey, signature } = await generateAndSignEphemeralKey(
        this.signingKeyPair.privateKey,
        this.identityId,
      );
      const salt = generateSaltHex();
      this.serverEphemeralKeyPairs.set(socket, ephemeralKeyPair);

      send({ type: 'e2e-key-exchange-response', ephemeralPublicKey, signature, salt });

      const sessionKey = await deriveE2ESessionKey(
        ephemeralKeyPair.privateKey,
        clientKeyExchange.ephemeralPublicKey,
        salt,
        'makaio-e2e-session-v1',
      );

      this.serverSessions.set(socket, { sessionKey, peerId: clientKeyExchange.deviceId });
      send({ type: 'e2e-auth-result', success: true });
    } catch (error) {
      this.serverPendingKeyExchange.delete(socket);
      this.serverEphemeralKeyPairs.delete(socket);
      send({
        type: 'e2e-auth-result',
        success: false,
        error: error instanceof Error ? error.message : 'Authentication failed',
      });
      throw error;
    } finally {
      this.serverPendingKeyExchange.delete(socket);
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
        this.pendingKeyExchange.resolve({
          ephemeralPublicKey: msg.ephemeralPublicKey,
          signature: msg.signature,
          salt: msg.salt,
        });
        this.pendingKeyExchange = undefined;
      }
      return true;
    }

    if (msg.type === 'e2e-auth-result') {
      if (!msg.success && this.pendingKeyExchange) {
        clearTimeout(this.pendingKeyExchange.timeoutHandle);
        this.pendingKeyExchange.reject(new Error(`E2E authentication failed: ${msg.error ?? 'Unknown error'}`));
        this.pendingKeyExchange = undefined;
      }
      if (this.pendingResult) {
        clearTimeout(this.pendingResult.timeoutHandle);
        this.pendingResult.resolve({ success: msg.success, error: msg.error });
        this.pendingResult = undefined;
      }
      return true;
    }

    if (msg.type === 'e2e-key-exchange' && socket) {
      const pendingEntry = this.serverPendingKeyExchange.get(socket);
      if (pendingEntry) {
        clearTimeout(pendingEntry.timeoutHandle);
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
        this.pendingKeyExchange = undefined;
        reject(new Error('E2E key exchange timeout'));
      }, this.timeout);

      this.pendingKeyExchange = { resolve, reject, timeoutHandle };
    });
  }

  private async waitForAuthResult(): Promise<{ success: boolean; error?: string }> {
    return new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingResult = undefined;
        reject(new Error('E2E authentication result timeout'));
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
        this.serverPendingKeyExchange.delete(socket);
        reject(new Error('E2E key exchange timeout'));
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
      this.pendingKeyExchange = undefined;
    }
    if (this.pendingResult) {
      clearTimeout(this.pendingResult.timeoutHandle);
      this.pendingResult = undefined;
    }
    this.clientSession = undefined;
    this.clientEphemeralKeyPair = undefined;

    for (const entry of this.serverPendingKeyExchange.values()) {
      clearTimeout(entry.timeoutHandle);
    }
    this.serverPendingKeyExchange.clear();
    this.serverSessions.clear();
    this.serverEphemeralKeyPairs.clear();
  }
}
