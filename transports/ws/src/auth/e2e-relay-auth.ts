/**
 * E2E authenticated encryption for relay (client-to-client) connections.
 *
 * Both peers act as clients connected to a relay that forwards messages.
 * This handshake exchanges ephemeral keys and verifies signatures using
 * known peer signing keys, deriving a shared session key.
 */

import type { TransportReceiveContext } from '@makaio/core';
import type { TransportAuth } from './interface.js';
import type { WebSocketLike } from '../types.js';
import {
  deriveE2ESessionKey,
  deriveRelaySaltHex,
  generateAndSignEphemeralKey,
  verifyEphemeralKeySignature,
} from './e2e-crypto-helpers.js';

/** Sentinel error message for auth sessions aborted by a reconnect cycle. */
const AUTH_ABORTED = 'E2E relay auth session aborted by reconnect';

type RelayAuthMode = 'initiator' | 'responder';

/**
 * Relay handshake message.
 */
interface RelayKeyExchangeMessage {
  type: 'e2e-relay-key-exchange';
  identityId: string;
  ephemeralPublicKey: string;
  signature: string;
}

interface PendingAuth<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

/**
 * Configuration for relay-mode E2E authentication.
 */
export interface E2ERelayAuthOptions {
  /** Static ECDSA signing keypair */
  signingKeyPair: CryptoKeyPair;
  /** Local identity ID */
  identityId: string;
  /** Lookup peer signing key by identity */
  getPeerSigningKey: (peerId: string) => Promise<CryptoKey | null>;
  /** Auth timeout in milliseconds. @defaultValue 10000 */
  timeout?: number;
  /**
   * Relay handshake mode.
   * - initiator: sends exchange immediately (browser)
   * - responder: waits for peer exchange before responding (machine)
   * @defaultValue "initiator"
   */
  mode?: RelayAuthMode;
  /**
   * Whether authenticateClient should block until handshake completes.
   * Use false for machine-side relay connections to avoid startup stalls
   * when no browser is connected.
   * @defaultValue true
   */
  blocking?: boolean;
}

/**
 * Relay-mode E2E authentication implementation.
 */
export class E2ERelayAuth implements TransportAuth {
  private readonly signingKeyPair: CryptoKeyPair;
  private readonly identityId: string;
  private readonly getPeerSigningKey: (peerId: string) => Promise<CryptoKey | null>;
  private readonly timeout: number;
  private readonly mode: RelayAuthMode;
  private readonly blocking: boolean;

  private pendingPeer?: PendingAuth<RelayKeyExchangeMessage>;
  private sessionKey?: CryptoKey;
  private peerId?: string;
  private localEphemeral?: CryptoKeyPair;
  private localExchangeMessage?: RelayKeyExchangeMessage;
  private sentLocalExchange = false;
  private earlyPeer?: RelayKeyExchangeMessage;
  private sendAuthMessage?: (message: unknown) => void;
  /**
   * Monotonically increasing counter to invalidate stale async
   * `processPeerExchange` tasks from previous sessions.
   */
  private authGeneration = 0;
  /**
   * True while a non-blocking `processPeerExchange` is in flight.
   * Prevents duplicate dispatches when the initiator sends its exchange
   * twice (initial + confirmation after deriving its own key).
   */
  private processingExchange = false;

  public constructor(options: E2ERelayAuthOptions) {
    this.signingKeyPair = options.signingKeyPair;
    this.identityId = options.identityId;
    this.getPeerSigningKey = options.getPeerSigningKey;
    this.timeout = options.timeout ?? 10000;
    this.mode = options.mode ?? 'initiator';
    this.blocking = options.blocking ?? true;
  }

  /**
   * Client-side authentication flow (relay mode).
   *
   * Resets all derived session state before starting a fresh handshake so that
   * this instance can be reused across WebSocketClientTransport reconnections.
   * Constructor-time config (`signingKeyPair`, `identityId`, `getPeerSigningKey`,
   * `mode`, `blocking`) is intentionally preserved by `cleanup()`.
   * @param send - Function to send auth messages to peer via relay
   */
  public async authenticateClient(send: (message: unknown) => void): Promise<void> {
    // Reset state from any previous session so the auth can be reused across
    // WebSocketClientTransport reconnections. Preserve earlyPeer because it may
    // contain a peer exchange that arrived for THIS session before
    // authenticateClient() was called (e.g. non-blocking responder receiving the
    // initiator exchange while waiting).
    // Only preserve earlyPeer on the very first authenticateClient call
    // (sendAuthMessage is undefined from the constructor). On reconnect,
    // sendAuthMessage is set from the previous session, so any earlyPeer is
    // stale ephemeral data from the old connection and must be discarded.
    const pendingEarlyPeer = this.sendAuthMessage === undefined ? this.earlyPeer : undefined;
    this.cleanup();
    const generation = this.authGeneration;
    this.earlyPeer = pendingEarlyPeer;
    this.sendAuthMessage = send;

    if (this.mode === 'initiator') {
      await this.ensureLocalExchangeMessage();
      // A reconnect may have started during key generation — bail out so the
      // stale ephemeral keys (already written by ensureLocalExchangeMessage)
      // don't get sent through the new session's sendAuthMessage.
      if (generation !== this.authGeneration) {
        throw new Error(AUTH_ABORTED);
      }
      this.sendLocalExchange();
    }

    if (!this.blocking) {
      if (this.earlyPeer) {
        const peer = this.earlyPeer;
        this.earlyPeer = undefined;
        this.dispatchPeerExchange(peer, generation);
      }
      return;
    }

    const peer = await this.waitForPeerExchange();
    await this.processPeerExchange(peer, generation);
    // In the blocking path, a silent generation mismatch inside
    // processPeerExchange means the session was not established. Surface
    // the failure so WebSocketClientTransport does not treat it as success.
    if (generation !== this.authGeneration || !this.sessionKey) {
      throw new Error(AUTH_ABORTED);
    }
  }

  /**
   * Server-side auth is not used in relay mode.
   *
   * No `cleanup()` call is needed here: this method throws unconditionally
   * before setting any session state, so there is nothing to reset.
   * @param _socket - WebSocket connection (unused)
   * @param _send - Auth send function (unused)
   */
  public async authenticateServer(_socket: WebSocketLike, _send: (message: unknown) => void): Promise<void> {
    throw new Error('E2ERelayAuth does not support server authentication');
  }

  /**
   * Handle incoming message during authentication phase.
   * @param message - Parsed message
   * @returns true if handled
   */
  public handleAuthMessage(message: unknown): boolean {
    const payload = message as RelayKeyExchangeMessage | undefined;
    if (!payload || payload.type !== 'e2e-relay-key-exchange') {
      return false;
    }

    if (payload.identityId === this.identityId) {
      return true;
    }

    if (this.pendingPeer) {
      this.pendingPeer.resolve(payload);
      this.pendingPeer = undefined;
      return true;
    }

    this.earlyPeer = payload;

    // Only dispatch once authenticateClient() has installed sendAuthMessage for
    // the current session. Before that point the peer exchange must remain
    // queued in earlyPeer; otherwise a responder that receives a peer message
    // before startup will spin in a retry loop that never advances auth state.
    // On reconnect, cleanup() clears sendAuthMessage before authenticateClient()
    // re-installs it, so exchanges arriving in that window are safely queued in
    // earlyPeer and dispatched when authenticateClient() processes them.
    // After sendAuthMessage exists, processingExchange prevents duplicate
    // dispatches when the initiator sends its exchange twice (initial +
    // confirmation). sessionKey is set exactly once per generation; re-keying
    // requires a full authenticateClient cycle which resets both flags.
    if (!this.blocking && this.sendAuthMessage && !this.sessionKey && !this.processingExchange) {
      this.dispatchPeerExchange(payload, this.authGeneration);
    }

    return true;
  }

  public cleanupSocket(_socket: WebSocketLike): void {
    // No per-socket resources in relay mode.
  }

  public cleanup(): void {
    // Advance generation so stale async tasks (and their .finally() handlers)
    // see a mismatch and bail out without clearing flags for the new session.
    this.authGeneration++;
    if (this.pendingPeer) {
      // Reject any in-flight waiter so previous authenticateClient() calls
      // do not hang forever when cleanup is called during reconnection.
      this.pendingPeer.reject(new Error(AUTH_ABORTED));
      this.pendingPeer = undefined;
    }
    if (this.earlyPeer) {
      this.earlyPeer = undefined;
    }
    this.sessionKey = undefined;
    this.peerId = undefined;
    this.localEphemeral = undefined;
    this.localExchangeMessage = undefined;
    this.sentLocalExchange = false;
    this.processingExchange = false;
    this.sendAuthMessage = undefined;
  }

  /**
   * Fire-and-forget `processPeerExchange` with `processingExchange` tracking
   * and generation-guarded cleanup.
   * @param peer - Peer key-exchange message
   * @param generation - Auth generation at dispatch time
   */
  private dispatchPeerExchange(peer: RelayKeyExchangeMessage, generation: number): void {
    this.processingExchange = true;
    void this.processPeerExchange(peer, generation)
      .catch((error: unknown) => {
        // Expected during reconnect — cleanup() aborts in-flight exchanges.
        if (error instanceof Error && error.message === AUTH_ABORTED) return;
        console.error('[E2ERelayAuth] Peer exchange failed:', error);
      })
      .finally(() => {
        if (generation === this.authGeneration) {
          this.processingExchange = false;
          this.retryQueuedPeerExchange(generation);
        }
      });
  }

  /**
   * Get derived session key after handshake.
   * @returns Session key or null
   */
  public getSessionKey(): CryptoKey | null {
    return this.sessionKey ?? null;
  }

  /**
   * Get peer identity ID after handshake.
   * @returns Peer identity ID or null
   */
  public getPeerId(): string | null {
    return this.peerId ?? null;
  }

  /**
   * Return trusted receive context after a successful relay handshake.
   *
   * Relay auth is always client-mode (no socket parameter). The `transportName`
   * is intentionally left as `''`; the transport registry fills it in.
   * @returns Trusted receive context with peer identity, or `undefined`.
   */
  public getReceiveContext(): TransportReceiveContext | undefined {
    const peerId = this.getPeerId();
    if (peerId === null) {
      return undefined;
    }
    return {
      transportName: '',
      peer: { kind: 'e2e', id: peerId, authenticated: true, encrypted: true },
    };
  }

  private async waitForPeerExchange(): Promise<RelayKeyExchangeMessage> {
    if (this.earlyPeer) {
      const payload = this.earlyPeer;
      this.earlyPeer = undefined;
      return payload;
    }

    return new Promise<RelayKeyExchangeMessage>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingPeer = undefined;
        reject(new Error('E2E relay key exchange timeout'));
      }, this.timeout);

      const finalize = (): void => {
        clearTimeout(timeoutHandle);
        this.pendingPeer = undefined;
      };

      this.pendingPeer = {
        resolve: (value) => {
          finalize();
          resolve(value);
        },
        reject: (error) => {
          finalize();
          reject(error);
        },
        timeoutHandle,
      };
    });
  }

  private async ensureLocalExchangeMessage(): Promise<RelayKeyExchangeMessage> {
    if (this.localExchangeMessage && this.localEphemeral) {
      return this.localExchangeMessage;
    }

    const { ephemeralKeyPair, ephemeralPublicKey, signature } = await generateAndSignEphemeralKey(
      this.signingKeyPair.privateKey,
      this.identityId,
    );
    this.localEphemeral = ephemeralKeyPair;

    this.localExchangeMessage = {
      type: 'e2e-relay-key-exchange',
      identityId: this.identityId,
      ephemeralPublicKey,
      signature,
    };

    return this.localExchangeMessage;
  }

  private sendLocalExchange(force = false): void {
    if (!this.sendAuthMessage || !this.localExchangeMessage) {
      return;
    }
    if (!force && this.sentLocalExchange) {
      return;
    }
    this.sendAuthMessage(this.localExchangeMessage);
    this.sentLocalExchange = true;
  }

  /**
   * Retry the latest queued peer exchange after an in-flight attempt settles.
   *
   * Non-blocking relay auth can receive a newer peer exchange while the current
   * one is still deriving keys. WebSocketClientTransport reconnects are already
   * generation-scoped; this helper only re-dispatches messages queued within the
   * same live auth session so newer exchanges are not stranded behind a failure.
   * @param generation - Auth generation that just finished processing
   */
  private retryQueuedPeerExchange(generation: number): void {
    if (
      this.blocking ||
      !this.sendAuthMessage ||
      this.sessionKey ||
      this.processingExchange ||
      generation !== this.authGeneration
    ) {
      return;
    }

    const queuedPeer = this.earlyPeer;
    if (!queuedPeer) {
      return;
    }

    this.earlyPeer = undefined;
    this.dispatchPeerExchange(queuedPeer, generation);
  }

  /**
   * Verify the peer's exchange, derive the shared session key, and store it.
   *
   * The `generation` parameter prevents stale async tasks from a previous
   * session from overwriting the current session's keys. Each call to
   * `authenticateClient` increments `authGeneration`; if a task's generation
   * no longer matches, it silently aborts before writing any state.
   * @param peer - Peer key-exchange message
   * @param generation - Auth generation at dispatch time
   */
  private async processPeerExchange(peer: RelayKeyExchangeMessage, generation: number): Promise<void> {
    if (!this.sendAuthMessage) {
      this.earlyPeer = peer;
      return;
    }

    const localMessage = await this.ensureLocalExchangeMessage();
    if (generation !== this.authGeneration) {
      return;
    }

    const peerKey = await this.getPeerSigningKey(peer.identityId);
    if (!peerKey) {
      throw new Error(`E2E relay authentication failed: Unknown peer ${peer.identityId}`);
    }

    const isValid = await verifyEphemeralKeySignature(
      peerKey,
      peer.ephemeralPublicKey,
      peer.signature,
      peer.identityId,
    );
    if (!isValid) {
      throw new Error('E2E relay authentication failed: Invalid peer signature');
    }

    const salt = await deriveRelaySaltHex(
      this.identityId,
      peer.identityId,
      localMessage.ephemeralPublicKey,
      peer.ephemeralPublicKey,
    );
    if (!this.localEphemeral) {
      throw new Error('E2E relay authentication failed: Local ephemeral key missing');
    }

    const sessionKey = await deriveE2ESessionKey(
      this.localEphemeral.privateKey,
      peer.ephemeralPublicKey,
      salt,
      'makaio-e2e-relay-v1',
    );

    // Guard placed after deriveE2ESessionKey (the last await) so a reconnect
    // that starts during key derivation cannot leak stale state or send through
    // the new session's sendAuthMessage callback.
    if (generation !== this.authGeneration) {
      return;
    }

    this.sessionKey = sessionKey;
    this.peerId = peer.identityId;

    if (this.mode === 'initiator') {
      this.sendLocalExchange(true);
    } else {
      this.sendLocalExchange();
    }
  }
}
