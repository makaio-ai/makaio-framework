/**
 * Shared factory for E2E encrypted client transports.
 *
 * Both browser clients and machine clients use identical encryption logic
 * when connecting to a server or relay. This factory captures that shared
 * pattern: wrap a WebSocketClientTransport with E2E encryption/decryption
 * of application payload/result/error fields using the session key from an
 * E2EAuth instance.
 *
 * Decryption is handled via the `messageTransform` hook, which runs before
 * correlation tracking. This ensures request/response flows see decrypted
 * results rather than raw ciphertext.
 */

import type { E2EAuth } from './auth/e2e-auth.js';
import type { WebSocketLike } from './types.js';
import { WebSocketClientTransport, type WebSocketClientTransportOptions } from './ws-client-transport.js';
import type { BusMessage, BusRequestMessage, BusBroadcastMessage, BusTransport } from '@makaio/bus-core';
import { encryptMessage, decryptMessage, type MaybeEncryptedMessage } from './e2e-message-crypto.js';

/**
 * E2E transport configuration.
 *
 * The `e2eAuth` instance serves as both the TransportAuth (for the handshake)
 * and the session key provider (for message encryption/decryption).
 *
 * Provide a pre-created `websocket` to wrap a caller-owned socket. All other
 * options are forwarded to `WebSocketClientTransport` (excluding `auth`,
 * `messageTransform`, `url`, `createWebSocket`, and `autoReconnect`, which
 * are managed internally by this factory).
 */
export interface E2ETransportOptions
  extends Omit<
    WebSocketClientTransportOptions,
    'auth' | 'messageTransform' | 'url' | 'createWebSocket' | 'autoReconnect'
  > {
  /**
   * Pre-created WebSocket instance to wrap.
   *
   * The factory treats this socket as caller-owned and disables
   * auto-reconnect. When reconnect is needed, the caller is responsible for
   * creating new sockets.
   */
  websocket: WebSocketLike;
  /**
   * E2E auth instance used for both handshake and encryption.
   */
  e2eAuth: E2EAuth;
}

/**
 * Create an E2E encrypted client transport.
 *
 * Wraps a `WebSocketClientTransport` to transparently encrypt/decrypt
 * application payload/result/error fields using the session key established
 * during E2E auth.
 *
 * Decryption runs in the `messageTransform` pipeline, so response
 * correlation sees decrypted results and errors.
 * @param options - E2E transport configuration
 * @returns BusTransport with E2E encryption
 */
export function createE2ETransport(options: E2ETransportOptions): BusTransport {
  const { e2eAuth, websocket: ws, ...rest } = options;

  // Create inner transport with E2EAuth as both auth strategy and
  // messageTransform for pre-correlation decryption.
  // The pre-created socket is injected via createWebSocket so the transport
  // does not attempt to dial a URL. Auto-reconnect is disabled because this
  // factory is responsible for a single caller-owned socket.
  const innerTransport = new WebSocketClientTransport({
    ...rest,
    url: '<pre-connected>',
    createWebSocket: () => ws,
    auth: e2eAuth,
    autoReconnect: false,
    messageTransform: async (message: BusMessage): Promise<BusMessage> => {
      const sessionKey = e2eAuth.getSessionKey();
      if (!sessionKey) return message; // Pre-auth: pass through
      const maybe = message as MaybeEncryptedMessage;
      if (!maybe.e2e) {
        // After session is established, reject plaintext to prevent injection
        throw new Error('Received plaintext message on E2E-encrypted channel — possible injection');
      }
      return decryptMessage(maybe, sessionKey);
    },
  });

  /**
   * Wrapped send that encrypts outgoing messages.
   * @param message - Bus message to encrypt and send
   * @param timeout - Correlation timeout in milliseconds; `0` means no automatic timeout
   * @returns Promise resolving to response (requests), results array (broadcasts), or boolean (events)
   */
  async function send<TMessage extends BusMessage>(
    message: TMessage,
    timeout?: number,
  ): Promise<
    TMessage extends BusRequestMessage
      ? unknown
      : TMessage extends BusBroadcastMessage
        ? Array<{ nodeId: string; payload: unknown }>
        : boolean
  > {
    const sessionKey = e2eAuth.getSessionKey();
    if (!sessionKey) {
      throw new Error('E2E session key not available - authentication may have failed');
    }

    const encrypted = await encryptMessage(message, sessionKey);
    return innerTransport.send(encrypted as TMessage, timeout);
  }

  return {
    name: innerTransport.name,
    connect: innerTransport.connect.bind(innerTransport),
    disconnect: innerTransport.disconnect.bind(innerTransport),
    send,
    cancelRequest: innerTransport.cancelRequest.bind(innerTransport),
    onReceive: innerTransport.onReceive.bind(innerTransport),
    // Direct E2E uses field-level encryption for application data. The
    // ServerTransport still needs subscribe/unsubscribe frames in plaintext to
    // maintain its routing registry; changing that requires a server-side
    // encrypted-control-plane protocol, not a client wrapper patch.
    subscribe: innerTransport.subscribe.bind(innerTransport),
    unsubscribe: innerTransport.unsubscribe.bind(innerTransport),
    getSubscriptions: innerTransport.getSubscriptions.bind(innerTransport),
  };
}
