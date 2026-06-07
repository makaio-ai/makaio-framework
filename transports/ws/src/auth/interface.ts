/**
 * Authentication interface for WebSocket transport.
 *
 * This interface provides a seam for implementing different authentication
 * strategies (e.g., token-based, certificate-based, OAuth) without coupling
 * the transport to specific auth implementations.
 */

import type { WebSocketLike } from '../types.js';
import type { TransportReceiveContext } from '@makaio/core';

/**
 * Transport authentication strategy.
 *
 * Implementations authenticate WebSocket connections and manage auth lifecycle.
 * Auth messages are handled during a pre-connect phase before normal message flow begins.
 */
export interface TransportAuth {
  /**
   * Authenticate a client connection.
   *
   * Called during the pre-connect phase after the WebSocket is open but before
   * normal message handling begins. Auth messages flow through handleAuthMessage().
   * @param send - Function to send auth messages to the server
   * @throws Error if authentication fails
   */
  authenticateClient(send: (message: unknown) => void): Promise<void>;

  /**
   * Authenticate a server connection with a specific client socket.
   *
   * Called when a new client connects to the server, during the pre-connect phase.
   * @param socket - The client WebSocket connection to authenticate
   * @param send - Function to send auth messages to the client
   * @throws Error if authentication fails
   */
  authenticateServer(socket: WebSocketLike, send: (message: unknown) => void): Promise<void>;

  /**
   * Handle incoming message during authentication phase.
   *
   * This is called by the transport's message handler to route auth messages
   * to the auth implementation during the pre-connect phase.
   * @param message - Parsed message object
   * @param socket - Optional socket identifier for server-side multi-client scenarios
   * @returns true if the message was an auth message and was handled, false otherwise
   */
  handleAuthMessage(message: unknown, socket?: WebSocketLike): boolean;

  /**
   * Return trusted receive context for a socket after authentication.
   *
   * Server transports call this when routing inbound bus messages from the
   * socket. Undefined means the auth strategy has no context to expose.
   * @param socket - Optional socket for server-side multi-client transports
   * @returns Trusted local receive context, or undefined
   */
  getReceiveContext?(socket?: WebSocketLike): TransportReceiveContext | undefined;

  /**
   * Return whether a previously authenticated socket may still send bus frames.
   *
   * Auth strategies with expiring or revocable credentials should re-check the
   * backing authorization state here because a successful WebSocket handshake
   * can outlive the credential used for that handshake.
   * @param socket - Server-side socket whose live authorization should be checked.
   * @returns `true` when the socket remains authorized, `false` when it must be closed.
   */
  isSocketAuthenticated?(socket: WebSocketLike): boolean;

  /**
   * Clean up authentication resources for a specific socket.
   *
   * Called when a socket disconnects to immediately release per-socket resources like:
   * - Pending authentication state
   * - Authentication timers for that socket
   * - Socket-specific auth data
   *
   * This prevents memory leaks when sockets disconnect during authentication.
   * @param socket - The socket to clean up auth resources for
   */
  cleanupSocket(socket: WebSocketLike): void;

  /**
   * Clean up authentication resources.
   *
   * Called during disconnect() to release resources like:
   * - Authentication timers
   * - Token refresh intervals
   * - Event listeners
   * - Cached credentials
   */
  cleanup(): void;
}
