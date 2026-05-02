/**
 * Per-client state management for the server-mode WebSocket transport.
 *
 * Tracks connected clients, their subscription subjects, payload filters,
 * and provides routing helpers used by the server transport to deliver
 * messages to interested clients.
 */

import type { BusMessage, BusSubscribeMessage } from '@makaio/bus-core';
import type { PayloadFilter } from '@makaio/core';
import { shouldReceiveMessage, getSubjectFromBusMessage } from '@makaio/bus-core';
import type { WebSocketLike } from './types.js';

/**
 * Options for `ClientRegistry`.
 */
export interface ClientRegistryOptions {
  /** Enable debug logging. */
  debug?: boolean;
}

/**
 * Manages the set of connected WebSocket clients and their per-client state.
 *
 * Responsibilities:
 * - Tracks which clients are fully authenticated vs. still authenticating.
 * - Tracks per-client subscription subjects and payload filters.
 * - Provides helpers for routing (interested clients, request priority).
 * - Forwards events between clients within the same server transport instance.
 *
 * This class is intentionally free of I/O — all message sends are performed
 * by the caller via `sendSafely`.
 */
export class ClientRegistry {
  private readonly clients = new Set<WebSocketLike>();
  private readonly authenticatingClients = new Set<WebSocketLike>();
  private readonly clientSubscriptions = new Map<WebSocketLike, Set<string>>();
  private readonly clientFilters = new Map<WebSocketLike, Map<string, PayloadFilter>>();
  private readonly debug: boolean;

  /**
   * @param options - Registry configuration
   */
  public constructor(options: ClientRegistryOptions = {}) {
    this.debug = options.debug ?? false;
  }

  // ---------------------------------------------------------------------------
  // Authentication lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Mark a socket as being in the authentication phase.
   * @param socket - The socket beginning authentication
   */
  public addAuthenticating(socket: WebSocketLike): void {
    this.authenticatingClients.add(socket);
  }

  /**
   * Remove a socket from the authentication-phase set.
   * @param socket - The socket that completed (or failed) authentication
   */
  public removeAuthenticating(socket: WebSocketLike): void {
    this.authenticatingClients.delete(socket);
  }

  /**
   * Check whether a socket is still in the authentication phase.
   * @param socket - Socket to check
   * @returns `true` if the socket has not yet completed authentication
   */
  public isAuthenticating(socket: WebSocketLike): boolean {
    return this.authenticatingClients.has(socket);
  }

  // ---------------------------------------------------------------------------
  // Client lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Add a fully-authenticated socket to the connected clients set.
   * @param socket - The authenticated socket
   */
  public addClient(socket: WebSocketLike): void {
    this.clients.add(socket);
  }

  /**
   * Remove a socket from all tracking maps and sets.
   *
   * Safe to call on sockets that were never fully added (e.g. auth failures).
   * @param socket - The socket to remove
   */
  public removeClient(socket: WebSocketLike): void {
    this.clients.delete(socket);
    this.authenticatingClients.delete(socket);
    this.clientSubscriptions.delete(socket);
    this.clientFilters.delete(socket);

    if (this.debug) {
      console.info(`[ClientRegistry] Client removed (${this.clients.size} remaining)`);
    }
  }

  /**
   * Return the number of fully connected (authenticated) clients.
   * @returns Client count
   */
  public get size(): number {
    return this.clients.size;
  }

  /**
   * Return all sockets tracked by this registry, including those still
   * authenticating.
   *
   * Used by `ServerTransport.disconnect()` to close every outstanding socket.
   * @returns Set containing all tracked sockets
   */
  public getAllSockets(): Set<WebSocketLike> {
    return new Set([...this.clients, ...this.authenticatingClients]);
  }

  // ---------------------------------------------------------------------------
  // Subscription management
  // ---------------------------------------------------------------------------

  /**
   * Apply a subscribe message to the per-client tracking state.
   *
   * Adds subjects to the client's subscription set and records any per-subject
   * payload filters. When a subject is (re-)subscribed without a filter, any
   * previously stored filter for that subject is removed to prevent stale
   * server-side filtering.
   * @param client - The WebSocket client
   * @param message - Subscribe message with subjects and optional filters
   */
  public handleSubscribeMessage(client: WebSocketLike, message: BusSubscribeMessage): void {
    let subs = this.clientSubscriptions.get(client);
    if (!subs) {
      subs = new Set();
      this.clientSubscriptions.set(client, subs);
    }

    let filters = this.clientFilters.get(client);

    for (const [subject] of Object.entries(message.subjects)) {
      subs.add(subject);
      const newFilter = message.filters?.[subject];
      if (newFilter !== undefined) {
        if (!filters) {
          filters = new Map<string, PayloadFilter>();
          this.clientFilters.set(client, filters);
        }
        filters.set(subject, newFilter);
      } else {
        filters?.delete(subject);
      }
    }

    if (this.debug) {
      const subjectCount = Object.keys(message.subjects).length;
      const filterCount = message.filters ? Object.keys(message.filters).length : 0;
      console.info(`[ClientRegistry] Client subscribed to ${subjectCount} subjects, ${filterCount} filters`);
    }
  }

  /**
   * Apply an unsubscribe message to the per-client tracking state.
   * @param client - The WebSocket client
   * @param subjects - Map of subject patterns to priorities being removed
   */
  public handleUnsubscribeMessage(client: WebSocketLike, subjects: Record<string, number[]>): void {
    const subs = this.clientSubscriptions.get(client);
    const filters = this.clientFilters.get(client);

    for (const subject of Object.keys(subjects)) {
      subs?.delete(subject);
      filters?.delete(subject);
    }

    if (this.debug) {
      console.info(`[ClientRegistry] Client unsubscribed from ${Object.keys(subjects).length} subjects`);
    }
  }

  // ---------------------------------------------------------------------------
  // Routing helpers
  // ---------------------------------------------------------------------------

  /**
   * Collect all connected clients with open (`readyState === 1`) sockets.
   * @returns Array of ready clients
   */
  public getReadyClients(): WebSocketLike[] {
    const result: WebSocketLike[] = [];
    for (const client of this.clients) {
      if (client.readyState === 1) {
        result.push(client);
      }
    }
    return result;
  }

  /**
   * Compute request routing priority for a client.
   *
   * Prioritization is best-effort only; requests still remain unfiltered.
   * - 2: client has subscriptions and the subject/filter matches
   * - 1: client has no subscriptions declared (default catch-all mode)
   * - 0: client has subscriptions but the current request does not match
   * @param client - Target client
   * @param fullSubject - Full request subject (`namespace.subject`)
   * @param payload - Request payload
   * @returns Priority score (higher is preferred)
   */
  public getRequestRoutingPriority(client: WebSocketLike, fullSubject: string, payload: unknown): number {
    const subs = this.clientSubscriptions.get(client);
    if (!subs || subs.size === 0) {
      return 1;
    }
    return this.clientWantsMessage(client, fullSubject, payload) ? 2 : 0;
  }

  /**
   * Collect all connected clients interested in a given subject/payload.
   * @param subject - The message subject (if any)
   * @param payload - The message payload (if any)
   * @param exclude - Optional client to exclude (e.g. the sender in cross-client event forwarding)
   * @returns Array of interested, ready clients
   */
  public getInterestedClients(subject: string | undefined, payload: unknown, exclude?: WebSocketLike): WebSocketLike[] {
    const result: WebSocketLike[] = [];
    for (const client of this.clients) {
      if (client !== exclude && client.readyState === 1 && this.clientWantsMessage(client, subject, payload)) {
        result.push(client);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Cross-client forwarding
  // ---------------------------------------------------------------------------

  /**
   * Forward an event from one client to all other interested clients.
   *
   * The transport registry's relay excludes the source transport to prevent
   * loops, so cross-client forwarding within the same `ServerTransport` must
   * happen here. The sender is excluded to avoid echo.
   * @param sender - The client that emitted the event
   * @param message - The event message to forward
   * @param sendSafely - Callback to send serialized data to a specific client
   */
  public forwardEventToClients(
    sender: WebSocketLike,
    message: BusMessage,
    sendSafely: (client: WebSocketLike, data: string) => void,
  ): void {
    const subject = getSubjectFromBusMessage(message) ?? undefined;
    const payload = 'payload' in message ? message.payload : undefined;
    const serialized = JSON.stringify(message);
    const interested = this.getInterestedClients(subject, payload, sender);
    for (const client of interested) {
      sendSafely(client, serialized);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether a client wants to receive a message given its subscriptions
   * and filters.
   * @param client - The WebSocket client
   * @param subject - The message subject (if any)
   * @param payload - The message payload (if any)
   * @returns `true` if the client should receive the message
   */
  private clientWantsMessage(client: WebSocketLike, subject: string | undefined, payload: unknown): boolean {
    const subs = this.clientSubscriptions.get(client) ?? new Set<string>();
    const filters = this.clientFilters.get(client) ?? new Map<string, PayloadFilter>();
    return shouldReceiveMessage(subject, payload, subs, filters);
  }
}
