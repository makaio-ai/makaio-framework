/**
 * Test helper utilities for WebSocket transport tests.
 *
 * Provides mock WebSocket and WebSocketServer implementations.
 */

import {
  createWebSocketCloseEvent,
  type WebSocketCloseEvent,
  type WebSocketLike,
  type WebSocketServerLike,
} from '../types.js';
import { E2ERelayAuth } from '../auth/e2e-relay-auth.js';
import { generateSigningKeyPair } from '../crypto/ecdsa.js';

/**
 * Event type map for mock WebSocket event listeners.
 *
 * Maps event names to their corresponding event types, enabling
 * generic `addEventListener`/`removeEventListener` without overloads.
 */
interface WebSocketMockEventMap {
  message: MessageEvent;
  error: Event;
  close: WebSocketCloseEvent;
  open: Event;
}

/**
 * Mock WebSocket implementation for testing.
 *
 * Simulates a WebSocket connection with event handling and message sending.
 */
export class MockWebSocket implements WebSocketLike {
  public readyState: number = 1; // OPEN
  public sentMessages: string[] = [];

  public listeners: Map<string, Set<(event: unknown) => void>> = new Map();

  send(data: string | BufferSource | Blob): void {
    if (this.readyState !== 1) {
      throw new Error('WebSocket is not open');
    }
    // Tests only send string-encoded JSON; binary frames are not exercised here.
    const str = typeof data === 'string' ? data : '[binary]';
    // subscribe-sync-complete is a transport-level handshake, not a bus message.
    // Exclude from recorded messages so tests asserting on counts are not affected.
    if (!str.includes('"subscribe-sync-complete"')) {
      this.sentMessages.push(str);
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.emit('close', createWebSocketCloseEvent(code, reason));
  }

  addEventListener<K extends keyof WebSocketMockEventMap>(
    event: K,
    listener: (event: WebSocketMockEventMap[K]) => void,
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as (event: unknown) => void);
  }

  removeEventListener<K extends keyof WebSocketMockEventMap>(
    event: K,
    listener: (event: WebSocketMockEventMap[K]) => void,
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(listener as (event: unknown) => void);
    }
  }

  /**
   * Test helper: Emit an event to all registered listeners.
   * @param event - Event name
   * @param data - Event data
   */
  emit(event: string, data: unknown): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        listener(data);
      }
    }
  }

  /**
   * Test helper: Simulate receiving a message.
   * @param data - Message data
   */
  receiveMessage(data: string | Buffer): void {
    this.emit('message', { data });
  }

  /**
   * Test helper: Clear sent messages.
   */
  clearSentMessages(): void {
    this.sentMessages = [];
  }
}

/**
 * Mock WebSocketServer implementation for testing.
 *
 * Simulates a WebSocket server that manages multiple client connections.
 */
export class MockWebSocketServer implements WebSocketServerLike {
  private listeners: Map<string, Set<(data: unknown) => void>> = new Map();
  private _closed: boolean = false;

  on(event: 'connection', listener: (socket: WebSocketLike) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  on(
    event: 'connection' | 'error' | 'close',
    listener: ((socket: WebSocketLike) => void) | ((error: Error) => void) | (() => void),
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as (data: unknown) => void);
  }

  off(event: 'connection', listener: (socket: WebSocketLike) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  off(event: 'close', listener: () => void): void;
  off(
    event: 'connection' | 'error' | 'close',
    listener: ((socket: WebSocketLike) => void) | ((error: Error) => void) | (() => void),
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(listener as (data: unknown) => void);
    }
  }

  close(callback?: (err?: Error) => void): void {
    this._closed = true;
    // Simulate async close
    setImmediate(() => {
      this.emit('close', undefined);
      callback?.();
    });
  }

  /**
   * Test helper: Emit an event to all registered listeners.
   * @param event - Event name
   * @param data - Event data
   */
  emit(event: string, data: unknown): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        listener(data);
      }
    }
  }

  /**
   * Test helper: Simulate a new client connection.
   * @param client - Mock WebSocket client
   */
  simulateConnection(client: WebSocketLike): void {
    this.emit('connection', client);
  }

  /**
   * Test helper: Check if server is closed.
   * @returns True if server is closed
   */
  isClosed(): boolean {
    return this._closed;
  }
}

/** Result of creating an unauthenticated relay auth pair. */
export interface RelayAuthPairRaw {
  /** Initiator-side auth instance */
  initiator: E2ERelayAuth;
  /** Responder-side auth instance */
  responder: E2ERelayAuth;
  /** Forwards a message to the responder */
  sendToResponder: (message: unknown) => void;
  /** Forwards a message to the initiator */
  sendToInitiator: (message: unknown) => void;
}

/**
 * Create an unauthenticated E2ERelayAuth initiator/responder pair.
 *
 * Wires up message forwarding but does NOT run authenticateClient.
 * Use this when tests need manual control over the handshake sequence.
 * @param ids - Optional device and machine identity IDs
 * @returns Unauthenticated pair with message-forwarding functions
 */
export async function createRelayAuthPairRaw(ids?: {
  deviceId?: string;
  machineId?: string;
}): Promise<RelayAuthPairRaw> {
  const deviceId = ids?.deviceId ?? 'device-transport';
  const machineId = ids?.machineId ?? 'machine-transport';

  const deviceSigningKeys = await generateSigningKeyPair();
  const machineSigningKeys = await generateSigningKeyPair();

  const initiator = new E2ERelayAuth({
    signingKeyPair: deviceSigningKeys,
    identityId: deviceId,
    getPeerSigningKey: async (peerId) => (peerId === machineId ? machineSigningKeys.publicKey : null),
    mode: 'initiator',
    blocking: true,
  });

  const responder = new E2ERelayAuth({
    signingKeyPair: machineSigningKeys,
    identityId: machineId,
    getPeerSigningKey: async (peerId) => (peerId === deviceId ? deviceSigningKeys.publicKey : null),
    mode: 'responder',
    blocking: false,
  });

  const sendToResponder = (message: unknown): void => {
    responder.handleAuthMessage(message);
  };

  const sendToInitiator = (message: unknown): void => {
    initiator.handleAuthMessage(message);
  };

  return { initiator, responder, sendToResponder, sendToInitiator };
}

/**
 * Create a paired E2ERelayAuth initiator/responder for testing.
 *
 * Performs the full handshake so both sides have derived session keys.
 * @param ids - Optional device and machine identity IDs
 * @returns Authenticated initiator and responder E2ERelayAuth instances
 */
export async function createRelayAuthPair(ids?: {
  deviceId?: string;
  machineId?: string;
}): Promise<{ initiator: E2ERelayAuth; responder: E2ERelayAuth }> {
  const { initiator, responder, sendToResponder, sendToInitiator } = await createRelayAuthPairRaw(ids);

  await Promise.all([responder.authenticateClient(sendToInitiator), initiator.authenticateClient(sendToResponder)]);

  return { initiator, responder };
}

/**
 * Compute HMAC signature using Web Crypto API.
 * @param secret - Shared secret for HMAC computation
 * @param nonce - Nonce to sign
 * @returns Promise resolving to hex-encoded HMAC signature
 */
export async function computeHmacSignature(secret: string, nonce: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(nonce));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
