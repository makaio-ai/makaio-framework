/**
 * Broadcast aggregation logic for server transport.
 *
 * Handles collecting responses from multiple clients for broadcast messages,
 * both client-initiated (forwarded through server) and server-initiated.
 */

import type { BusBroadcastMessage, BusBroadcastResponseMessage, BusTransportError } from '@makaio/bus-core';
import type { WebSocketLike } from './types.js';

/** Result from a broadcast respondent */
export interface BroadcastResult {
  nodeId: string;
  payload: unknown;
}

/** Shared fields for all pending broadcast tracking entries */
interface PendingBroadcastBase {
  results: BroadcastResult[];
  pendingClients: Set<WebSocketLike>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Client-initiated pending broadcast.
 *
 * Awaits two completion signals:
 * 1. All peer WS clients have responded (or disconnected).
 * 2. The transport-registry node has delivered its results via
 *    {@link BroadcastAggregator.handleNodeResults}.
 *
 * Only when both conditions are satisfied is the aggregated
 * `broadcast-response` sent back to the originating sender socket.
 */
interface ClientPending extends PendingBroadcastBase {
  kind: 'client';
  /** The WebSocket that originated the broadcast */
  sender: WebSocketLike;
  /**
   * True once the transport-registry node (local handlers + relay transports)
   * has reported its results via {@link BroadcastAggregator.handleNodeResults}.
   */
  nodeResultsReceived: boolean;
  /**
   * Optional transport-registry error to forward to the broadcast originator.
   *
   * When present, finalization emits `broadcast-response.error` instead of
   * `broadcast-response.results`.
   */
  nodeError?: BusTransportError;
}

/**
 * Server-initiated pending broadcast.
 *
 * Awaits all peer WS clients responding (or disconnecting), then resolves
 * the Promise returned by {@link BroadcastAggregator.startServerBroadcast}.
 */
interface ServerPending extends PendingBroadcastBase {
  kind: 'server';
  resolve: (results: BroadcastResult[]) => void;
}

/** Union of all pending broadcast tracking states */
type PendingBroadcast = ClientPending | ServerPending;

export interface BroadcastAggregatorOptions {
  /** Timeout for collecting broadcast responses (ms) */
  timeout?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Clear a pending broadcast timeout when one was scheduled.
 * @param pending - Pending broadcast entry to clear.
 */
function clearPendingTimer(pending: PendingBroadcast): void {
  if (pending.timer !== undefined) {
    clearTimeout(pending.timer);
  }
}

/**
 * Aggregates broadcast responses from multiple clients.
 *
 * Supports two modes:
 * 1. Client-initiated: Client sends broadcast, server forwards to others, aggregates responses
 * 2. Server-initiated: Server sends broadcast, collects responses from clients
 *
 * Both modes are tracked in a single `pendingBroadcasts` map, distinguished by
 * the `kind` discriminant on each entry. Completion conditions differ by kind:
 * - `'client'`: all peer clients responded **and** node results received
 * - `'server'`: all peer clients responded
 */
export class BroadcastAggregator {
  private readonly pendingBroadcasts = new Map<string, PendingBroadcast>();
  private readonly timeout: number;
  private readonly debug: boolean;

  public constructor(options: BroadcastAggregatorOptions = {}) {
    this.timeout = options.timeout ?? 5000;
    this.debug = options.debug ?? false;
  }

  /**
   * Start tracking a client-initiated broadcast.
   * @param sender - The client that initiated the broadcast
   * @param message - The broadcast message
   * @param targetClients - Clients to forward the broadcast to
   * @param sendToClient - Function to send serialized message to a client
   * @param timeout - Timeout for collecting responses (ms); `0` disables the automatic timeout
   */
  public startClientBroadcast(
    sender: WebSocketLike,
    message: BusBroadcastMessage,
    targetClients: WebSocketLike[],
    sendToClient: (client: WebSocketLike, data: string) => void,
    timeout?: number,
  ): void {
    const correlationId = message.correlationId;
    const effectiveTimeout = timeout ?? this.timeout;

    const pending: ClientPending = {
      kind: 'client',
      sender,
      results: [],
      pendingClients: new Set(targetClients),
      nodeResultsReceived: false,
      timer:
        effectiveTimeout === 0
          ? undefined
          : setTimeout(() => {
              if (this.debug) {
                console.warn(`[BroadcastAggregator] Broadcast ${correlationId} timed out`);
              }
              this.finalizeBroadcast(correlationId);
            }, effectiveTimeout),
    };
    this.pendingBroadcasts.set(correlationId, pending);

    // Forward to target clients
    const serialized = JSON.stringify(message);
    for (const client of targetClients) {
      sendToClient(client, serialized);
    }

    if (this.debug) {
      console.info(`[BroadcastAggregator] Broadcast ${correlationId} forwarded to ${targetClients.length} clients`);
    }
  }

  /**
   * Start a server-initiated broadcast.
   * @param message - The broadcast message
   * @param targetClients - Clients to send the broadcast to
   * @param sendToClient - Function to send serialized message to a client
   * @param timeout - Timeout for collecting responses (ms)
   * @returns Promise resolving to aggregated results
   */
  public startServerBroadcast(
    message: BusBroadcastMessage,
    targetClients: WebSocketLike[],
    sendToClient: (client: WebSocketLike, data: string) => void,
    timeout?: number,
  ): Promise<BroadcastResult[]> {
    const correlationId = message.correlationId;
    const effectiveTimeout = timeout ?? this.timeout;

    // If no clients, return empty immediately
    if (targetClients.length === 0) {
      if (this.debug) {
        console.info(`[BroadcastAggregator] Server broadcast ${correlationId} - no target clients`);
      }
      return Promise.resolve([]);
    }

    return new Promise<BroadcastResult[]>((resolve) => {
      const pending: ServerPending = {
        kind: 'server',
        results: [],
        pendingClients: new Set(targetClients),
        timer:
          effectiveTimeout === 0
            ? undefined
            : setTimeout(() => {
                if (this.debug) {
                  console.warn(`[BroadcastAggregator] Server broadcast ${correlationId} timed out`);
                }
                this.finalizeServerBroadcast(correlationId);
              }, effectiveTimeout),
        resolve,
      };
      this.pendingBroadcasts.set(correlationId, pending);

      // Send to all target clients
      const serialized = JSON.stringify(message);
      for (const client of targetClients) {
        sendToClient(client, serialized);
      }

      if (this.debug) {
        console.info(`[BroadcastAggregator] Server broadcast ${correlationId} sent to ${targetClients.length} clients`);
      }
    });
  }

  /**
   * Handle a broadcast response from a client.
   * @param client - The client that responded
   * @param response - The broadcast response
   * @returns true if response was handled, false if no pending broadcast found
   */
  public handleResponse(client: WebSocketLike, response: BusBroadcastResponseMessage): boolean {
    const pending = this.pendingBroadcasts.get(response.correlationId);
    if (!pending) return false;

    if (response.results) {
      pending.results.push(...response.results);
    }
    pending.pendingClients.delete(client);

    if (this.debug) {
      console.info(
        `[BroadcastAggregator] Broadcast ${response.correlationId} got response, ${pending.pendingClients.size} pending`,
      );
    }

    this.checkBroadcastComplete(response.correlationId, pending);
    return true;
  }

  /**
   * Handle node results for a client-initiated broadcast.
   *
   * "Node results" covers all results produced by the transport-registry on
   * this server node — both local bus handlers and any relay transports that
   * were invoked. This must be called once per broadcast before finalization
   * can proceed.
   * @param correlationId - The broadcast correlation ID
   * @param results - Results from node handlers (local + relay)
   * @param error - Optional structured node error to propagate to sender
   * @returns true if results were handled, false if no pending broadcast found
   */
  public handleNodeResults(
    correlationId: string,
    results: ReadonlyArray<BroadcastResult>,
    error?: BusTransportError,
  ): boolean {
    const pending = this.pendingBroadcasts.get(correlationId);
    if (!pending || pending.kind !== 'client') return false;

    pending.results.push(...results);
    pending.nodeResultsReceived = true;
    pending.nodeError = error;

    if (this.debug) {
      console.info(
        `[BroadcastAggregator] Broadcast ${correlationId} node results aggregated${error ? ' (with error)' : ''}`,
      );
    }

    this.checkBroadcastComplete(correlationId, pending);
    return true;
  }

  /**
   * Handle a client disconnecting - clean up any pending broadcasts involving it.
   * @param client - The disconnected client
   */
  public handleClientDisconnect(client: WebSocketLike): void {
    for (const [correlationId, pending] of this.pendingBroadcasts) {
      if (pending.kind === 'client' && pending.sender === client) {
        // Sender disconnected — abort the broadcast entirely
        clearPendingTimer(pending);
        this.pendingBroadcasts.delete(correlationId);
      } else if (pending.pendingClients.has(client)) {
        // Responding client disconnected — remove and check if complete
        pending.pendingClients.delete(client);
        this.checkBroadcastComplete(correlationId, pending);
      }
    }
  }

  /**
   * Clean up all pending broadcasts.
   * Server-initiated broadcasts are resolved with partial results.
   * Client-initiated broadcasts are cancelled without sending.
   */
  public cleanup(): void {
    for (const pending of this.pendingBroadcasts.values()) {
      clearPendingTimer(pending);
      if (pending.kind === 'server') {
        pending.resolve(pending.results);
      }
    }
    this.pendingBroadcasts.clear();
  }

  /**
   * Check if a broadcast is complete and finalize if so.
   *
   * Completion conditions differ by kind:
   * - `'client'`: all peer clients responded **and** node results received
   * - `'server'`: all peer clients responded
   * @param correlationId - The broadcast correlation ID
   * @param pending - The pending broadcast state (avoids redundant map lookup)
   */
  private checkBroadcastComplete(correlationId: string, pending: PendingBroadcast): void {
    if (pending.pendingClients.size > 0) return;

    if (pending.kind === 'client') {
      if (!pending.nodeResultsReceived) return;
      this.finalizeBroadcast(correlationId);
    } else {
      this.finalizeServerBroadcast(correlationId);
    }
  }

  /**
   * Finalize a client-initiated pending broadcast by sending aggregated response to originator.
   * @param correlationId - The broadcast correlation ID
   */
  private finalizeBroadcast(correlationId: string): void {
    const pending = this.pendingBroadcasts.get(correlationId);
    if (!pending || pending.kind !== 'client') return;

    clearPendingTimer(pending);
    this.pendingBroadcasts.delete(correlationId);

    const response: BusBroadcastResponseMessage = pending.nodeError
      ? {
          type: 'broadcast-response',
          correlationId,
          error: pending.nodeError,
        }
      : {
          type: 'broadcast-response',
          correlationId,
          results: pending.results,
        };

    if (pending.sender.readyState === 1) {
      pending.sender.send(JSON.stringify(response));
    }

    if (this.debug) {
      console.info(`[BroadcastAggregator] Broadcast ${correlationId} finalized with ${pending.results.length} results`);
    }
  }

  /**
   * Finalize a server-initiated pending broadcast by resolving its Promise.
   * @param correlationId - The broadcast correlation ID
   */
  private finalizeServerBroadcast(correlationId: string): void {
    const pending = this.pendingBroadcasts.get(correlationId);
    if (!pending || pending.kind !== 'server') return;

    clearPendingTimer(pending);
    this.pendingBroadcasts.delete(correlationId);
    pending.resolve(pending.results);

    if (this.debug) {
      console.info(
        `[BroadcastAggregator] Server broadcast ${correlationId} finalized with ${pending.results.length} results`,
      );
    }
  }
}
