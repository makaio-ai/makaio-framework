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

import type { TransportAuth } from './interface.js';
import type { WebSocketLike } from '../types.js';

/**
 * Authentication message types.
 *
 * These are distinct from BusMessage and handled separately.
 */
type AuthMessage =
  | { type: 'auth-challenge'; nonce: string }
  | { type: 'auth-response'; signature: string }
  | { type: 'auth-result'; success: boolean; error?: string };

/**
 * HMAC authentication configuration.
 */
export interface HmacAuthOptions {
  /**
   * Shared secret for HMAC computation.
   *
   * IMPORTANT: This should be a strong, randomly-generated secret.
   * Both client and server must use the same secret.
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

  // Client-side: pending auth operations (single client per instance)
  private pendingChallenge?: PendingAuth<string>;
  private pendingResult?: PendingAuth<{ success: boolean; error?: string }>;
  private queuedChallengeNonce: string | undefined;
  private queuedResult: { success: boolean; error?: string } | undefined;
  private clientAuthComplete = false;

  // Server-side: pending auth operations (multiple concurrent clients)
  private serverPendingResponses = new Map<WebSocketLike, PendingAuth<string>>();

  public constructor(options: HmacAuthOptions) {
    this.secret = options.secret;
    this.algorithm = options.algorithm ?? 'sha256';
    this.challengeTimeout = options.challengeTimeout ?? 5000;
  }

  /**
   * Server-side authentication flow.
   *
   * 1. Generate random nonce
   * 2. Send auth-challenge to client
   * 3. Wait for auth-response with signature (via handleAuthMessage)
   * 4. Verify signature matches HMAC(secret, nonce)
   * 5. Send auth-result
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
    const expectedSignature = await this.computeHmac(nonce);

    // Send challenge
    const challenge: AuthMessage = { type: 'auth-challenge', nonce };
    send(challenge);

    // Wait for response via handleAuthMessage (with per-socket tracking)
    let authResultSent = false;
    try {
      const signature = await this.waitForAuthResponse(socket);

      // Verify signature
      if (signature !== expectedSignature) {
        this.sendAuthResultBestEffort(send, {
          type: 'auth-result',
          success: false,
          error: 'Invalid signature',
        });
        authResultSent = true;
        throw new Error('HMAC authentication failed: Invalid signature');
      }

      // Success
      this.sendAuthResultBestEffort(send, { type: 'auth-result', success: true });
      authResultSent = true;
    } catch (error) {
      const wasPending = this.serverPendingResponses.has(socket);
      // Clean up the pending entry
      this.serverPendingResponses.delete(socket);

      // Send failure only when this socket is still pending and no result has been sent yet.
      if (!authResultSent && wasPending) {
        this.sendAuthResultBestEffort(send, {
          type: 'auth-result',
          success: false,
          error: error instanceof Error ? error.message : 'Authentication failed',
        });
      }
      throw error;
    } finally {
      // Ensure cleanup happens even on success
      this.serverPendingResponses.delete(socket);
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

    // Wait for challenge via handleAuthMessage
    const nonce = await this.waitForAuthChallenge();

    // Compute signature
    const signature = await this.computeHmac(nonce);

    // Send response
    const response: AuthMessage = { type: 'auth-response', signature };
    send(response);

    // Wait for result via handleAuthMessage
    const result = await this.waitForAuthResult();

    if (!result.success) {
      throw new Error(`HMAC authentication failed: ${result.error ?? 'Unknown error'}`);
    }

    this.clientAuthComplete = true;
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
        this.pendingChallenge = undefined;
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
      const result = { success: msg.success, error: msg.error };
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
          pendingEntry.resolve(msg.signature);
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
    if (this.queuedChallengeNonce !== undefined) {
      const nonce = this.queuedChallengeNonce;
      this.queuedChallengeNonce = undefined;
      return nonce;
    }

    return new Promise<string>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingChallenge = undefined;
        reject(new Error('Authentication challenge timeout'));
      }, this.challengeTimeout);

      this.pendingChallenge = { resolve, reject, timeoutHandle };
    });
  }

  /**
   * Wait for auth-response message from client.
   *
   * Message will be delivered via handleAuthMessage().
   * @param socket - The client socket to track
   * @returns The signature from the response
   * @throws Error if timeout
   */
  private async waitForAuthResponse(socket: WebSocketLike): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error('Authentication response timeout'));
      }, this.challengeTimeout);

      const pending: PendingAuth<string> = { resolve, reject, timeoutHandle };
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
        reject(new Error('Authentication result timeout'));
      }, this.challengeTimeout);

      this.pendingResult = { resolve, reject, timeoutHandle };
    });
  }

  /**
   * Compute HMAC signature for a nonce using Web Crypto API.
   * @param nonce - The nonce to sign
   * @returns Promise resolving to hex-encoded HMAC signature
   */
  private async computeHmac(nonce: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.secret);

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
   * Send auth result messages without masking the original auth error.
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
      pendingEntry.reject(new Error('Socket disconnected during HMAC authentication'));
    }
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
      this.pendingChallenge = undefined;
    }
    if (this.pendingResult) {
      clearTimeout(this.pendingResult.timeoutHandle);
      this.pendingResult = undefined;
    }
    this.queuedChallengeNonce = undefined;
    this.queuedResult = undefined;
    this.clientAuthComplete = false;

    // Server-side cleanup: clear all pending responses
    for (const entry of this.serverPendingResponses.values()) {
      clearTimeout(entry.timeoutHandle);
    }
    this.serverPendingResponses.clear();
  }
}
