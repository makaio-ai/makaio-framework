/**
 * Unit tests for BroadcastAggregator.
 *
 * Tests cover both client-initiated and server-initiated broadcast modes,
 * including timeout, partial responses, and client disconnect scenarios.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BroadcastAggregator, type BroadcastResult } from '../broadcast-aggregator.js';
import type { WebSocketLike } from '../types.js';
import type { BusBroadcastMessage } from '@makaio/bus-core';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket stub returned by {@link makeMockClient}.
 *
 * Extends {@link WebSocketLike} directly, replacing `send` and `close` with
 * typed spy variants so call assertions remain available at test call-sites.
 */
type MockClient = Omit<WebSocketLike, 'send' | 'close'> & {
  send: ReturnType<typeof vi.fn<(data: string | BufferSource | Blob) => void>>;
  sentMessages: string[];
  close: ReturnType<typeof vi.fn<(code?: number, reason?: string) => void>>;
};

/**
 * Create a mock WebSocket client.
 * @param readyState - Initial readyState (default: 1 = OPEN)
 * @returns A mock WebSocketLike instance
 */
function makeMockClient(readyState = 1): MockClient {
  const sentMessages: string[] = [];
  const send = vi.fn<(data: string | BufferSource | Blob) => void>((data) => {
    sentMessages.push(typeof data === 'string' ? data : '[binary]');
  });

  return {
    send,
    sentMessages,
    readyState,
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

/**
 * Cast a {@link MockClient} to {@link WebSocketLike} for aggregator calls.
 *
 * `MockClient` satisfies the full `WebSocketLike` structural contract —
 * `send` and `close` are the only overridden members (to carry spy types),
 * and both are assignment-compatible with their `WebSocketLike` counterparts.
 * @param client - The mock client to cast
 * @returns The same object typed as WebSocketLike
 */
function asWs(client: MockClient): WebSocketLike {
  return client as WebSocketLike;
}

/**
 * Build a minimal BusBroadcastMessage.
 * @param correlationId - Correlation ID for the broadcast
 * @returns A minimal broadcast message
 */
function makeBroadcastMessage(correlationId: string): BusBroadcastMessage {
  return {
    type: 'broadcast',
    subject: 'test.subject',
    namespace: 'default',
    payload: { value: 42 },
    correlationId,
    messageId: `msg-${correlationId}`,
  };
}

/**
 * Decode the last message sent by a mock client.
 * @param client - The mock client
 * @returns Parsed JSON of the last sent message
 */
function lastSentMessage(client: MockClient): unknown {
  const last = client.sentMessages.at(-1);
  if (!last) throw new Error('No messages sent');
  return JSON.parse(last);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BroadcastAggregator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: client-initiated with 0 peer clients
  // -------------------------------------------------------------------------
  describe('client-initiated with 0 peer clients', () => {
    it('finalizes immediately when handleNodeResults is called with no peer clients', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient();
      const message = makeBroadcastMessage('corr-zero-peers');

      const forwarded: string[] = [];
      aggregator.startClientBroadcast(asWs(sender), message, [], (_client, data) => {
        forwarded.push(data);
      });

      // No forwarding should occur
      expect(forwarded).toHaveLength(0);

      const nodeResults: BroadcastResult[] = [{ nodeId: 'node-1', payload: 'hello' }];
      const handled = aggregator.handleNodeResults('corr-zero-peers', nodeResults);

      expect(handled).toBe(true);
      // Sender must receive the aggregated response
      expect(sender.send).toHaveBeenCalledOnce();
      const response = lastSentMessage(sender) as {
        type: string;
        correlationId: string;
        results: BroadcastResult[];
      };
      expect(response.type).toBe('broadcast-response');
      expect(response.correlationId).toBe('corr-zero-peers');
      expect(response.results).toEqual(nodeResults);
    });

    it('does not send to sender when sender readyState is not OPEN', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient(3); // CLOSED
      const message = makeBroadcastMessage('corr-closed-sender');

      aggregator.startClientBroadcast(asWs(sender), message, [], vi.fn());
      aggregator.handleNodeResults('corr-closed-sender', []);

      // Sender is closed — should not attempt to send
      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: client-initiated with N peer clients, partial responses
  // -------------------------------------------------------------------------
  describe('client-initiated with N peer clients and partial responses', () => {
    it('forwards broadcast to all peer clients', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient();
      const peerA = makeMockClient();
      const peerB = makeMockClient();
      const message = makeBroadcastMessage('corr-peers');

      const forwarded: Array<{ client: WebSocketLike; data: string }> = [];
      aggregator.startClientBroadcast(asWs(sender), message, [asWs(peerA), asWs(peerB)], (client, data) =>
        forwarded.push({ client, data }),
      );

      expect(forwarded).toHaveLength(2);
      expect(forwarded[0].client).toBe(asWs(peerA));
      expect(forwarded[1].client).toBe(asWs(peerB));
    });

    it('does not finalize until all peer clients respond AND handleNodeResults is called', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient();
      const peerA = makeMockClient();
      const peerB = makeMockClient();
      const message = makeBroadcastMessage('corr-partial');

      aggregator.startClientBroadcast(asWs(sender), message, [asWs(peerA), asWs(peerB)], vi.fn());

      // Only peerA responds
      aggregator.handleResponse(asWs(peerA), {
        type: 'broadcast-response',
        correlationId: 'corr-partial',
        results: [{ nodeId: 'peer-a', payload: 'a' }],
      });

      // Not finalized yet — peerB still pending and node results not received
      expect(sender.send).not.toHaveBeenCalled();

      // Node results arrive before peerB
      aggregator.handleNodeResults('corr-partial', [{ nodeId: 'server-node', payload: 'srv' }]);

      // Still not done — peerB is still pending
      expect(sender.send).not.toHaveBeenCalled();

      // peerB responds
      aggregator.handleResponse(asWs(peerB), {
        type: 'broadcast-response',
        correlationId: 'corr-partial',
        results: [{ nodeId: 'peer-b', payload: 'b' }],
      });

      // Now all conditions met — should be finalized
      expect(sender.send).toHaveBeenCalledOnce();
      const response = lastSentMessage(sender) as { results: BroadcastResult[] };
      expect(response.results).toHaveLength(3);
    });

    it('aggregates results from all peer clients and node results', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient();
      const peerA = makeMockClient();
      const message = makeBroadcastMessage('corr-agg');

      aggregator.startClientBroadcast(asWs(sender), message, [asWs(peerA)], vi.fn());

      aggregator.handleNodeResults('corr-agg', [{ nodeId: 'node', payload: 'node-result' }]);
      aggregator.handleResponse(asWs(peerA), {
        type: 'broadcast-response',
        correlationId: 'corr-agg',
        results: [{ nodeId: 'peer-a', payload: 'peer-result' }],
      });

      const response = lastSentMessage(sender) as { results: BroadcastResult[] };
      // Order: node results pushed first, then peer response
      expect(response.results).toEqual([
        { nodeId: 'node', payload: 'node-result' },
        { nodeId: 'peer-a', payload: 'peer-result' },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: timeout before handleNodeResults is called
  // -------------------------------------------------------------------------
  describe('timeout fires before handleNodeResults is called', () => {
    it('finalizes with available partial results on timeout', () => {
      const aggregator = new BroadcastAggregator({ timeout: 1000 });
      const sender = makeMockClient();
      const peer = makeMockClient();
      const message = makeBroadcastMessage('corr-timeout-before-node');

      aggregator.startClientBroadcast(asWs(sender), message, [asWs(peer)], vi.fn());

      // peer responds but node results have not arrived yet
      aggregator.handleResponse(asWs(peer), {
        type: 'broadcast-response',
        correlationId: 'corr-timeout-before-node',
        results: [{ nodeId: 'peer', payload: 'peer-data' }],
      });

      expect(sender.send).not.toHaveBeenCalled();

      // Advance past timeout — should finalize with whatever results are present
      vi.advanceTimersByTime(1001);

      expect(sender.send).toHaveBeenCalledOnce();
      const response = lastSentMessage(sender) as {
        type: string;
        results: BroadcastResult[];
      };
      expect(response.type).toBe('broadcast-response');
      expect(response.results).toEqual([{ nodeId: 'peer', payload: 'peer-data' }]);
    });

    it('finalizes with empty results on timeout when no responses received', () => {
      const aggregator = new BroadcastAggregator({ timeout: 500 });
      const sender = makeMockClient();
      const peer = makeMockClient();
      const message = makeBroadcastMessage('corr-full-timeout');

      aggregator.startClientBroadcast(asWs(sender), message, [asWs(peer)], vi.fn());

      vi.advanceTimersByTime(501);

      expect(sender.send).toHaveBeenCalledOnce();
      const response = lastSentMessage(sender) as { results: BroadcastResult[] };
      expect(response.results).toEqual([]);
    });

    it('does not double-finalize if handleNodeResults is called after timeout', () => {
      const aggregator = new BroadcastAggregator({ timeout: 500 });
      const sender = makeMockClient();
      const message = makeBroadcastMessage('corr-late-node');

      aggregator.startClientBroadcast(asWs(sender), message, [], vi.fn());

      vi.advanceTimersByTime(501);

      // Timeout fired — broadcast is finalized and removed
      expect(sender.send).toHaveBeenCalledOnce();

      // Late handleNodeResults call should be a no-op
      const handled = aggregator.handleNodeResults('corr-late-node', [{ nodeId: 'late', payload: 'late-data' }]);
      expect(handled).toBe(false);
      // Sender still only called once
      expect(sender.send).toHaveBeenCalledOnce();
    });

    it('honors timeout 0 as no automatic timeout for client-initiated broadcasts', () => {
      const aggregator = new BroadcastAggregator({ timeout: 500 });
      const sender = makeMockClient();
      const message = makeBroadcastMessage('corr-client-no-timeout');

      aggregator.startClientBroadcast(asWs(sender), message, [], vi.fn(), 0);

      vi.advanceTimersByTime(501);
      expect(sender.send).not.toHaveBeenCalled();

      aggregator.handleNodeResults('corr-client-no-timeout', [{ nodeId: 'node', payload: 'late-result' }]);

      expect(sender.send).toHaveBeenCalledOnce();
      const response = lastSentMessage(sender) as { results: BroadcastResult[] };
      expect(response.results).toEqual([{ nodeId: 'node', payload: 'late-result' }]);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: client disconnect during pending broadcast
  // -------------------------------------------------------------------------
  describe('client disconnect during pending broadcast', () => {
    it('aborts the broadcast when the sender disconnects', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient();
      const peer = makeMockClient();
      const message = makeBroadcastMessage('corr-sender-disc');

      aggregator.startClientBroadcast(asWs(sender), message, [asWs(peer)], vi.fn());

      // Sender disconnects
      aggregator.handleClientDisconnect(asWs(sender));

      // Broadcast is aborted — peer response is a no-op
      const handled = aggregator.handleResponse(asWs(peer), {
        type: 'broadcast-response',
        correlationId: 'corr-sender-disc',
        results: [{ nodeId: 'peer', payload: 'data' }],
      });
      expect(handled).toBe(false);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('finalizes when the only pending peer client disconnects and node results are ready', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient();
      const peer = makeMockClient();
      const message = makeBroadcastMessage('corr-peer-disc');

      aggregator.startClientBroadcast(asWs(sender), message, [asWs(peer)], vi.fn());

      // Node results arrive first
      aggregator.handleNodeResults('corr-peer-disc', [{ nodeId: 'node', payload: 'node-data' }]);

      expect(sender.send).not.toHaveBeenCalled();

      // Peer disconnects before responding
      aggregator.handleClientDisconnect(asWs(peer));

      // Peer was the only pending client — should finalize now
      expect(sender.send).toHaveBeenCalledOnce();
      const response = lastSentMessage(sender) as { results: BroadcastResult[] };
      expect(response.results).toEqual([{ nodeId: 'node', payload: 'node-data' }]);
    });

    it('does not finalize when a peer disconnects but node results have not arrived yet', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient();
      const peer = makeMockClient();
      const message = makeBroadcastMessage('corr-peer-disc-no-node');

      aggregator.startClientBroadcast(asWs(sender), message, [asWs(peer)], vi.fn());

      // Peer disconnects before node results
      aggregator.handleClientDisconnect(asWs(peer));

      // pendingClients is now empty but nodeResultsReceived is still false
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('resolves server-initiated broadcast when the only client disconnects', async () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const client = makeMockClient();
      const message = makeBroadcastMessage('corr-srv-disc');

      const resultPromise = aggregator.startServerBroadcast(message, [asWs(client)], vi.fn());

      aggregator.handleClientDisconnect(asWs(client));

      const results = await resultPromise;
      expect(results).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: server-initiated with 0 clients
  // -------------------------------------------------------------------------
  describe('server-initiated with 0 clients', () => {
    it('resolves immediately with empty results when no clients are provided', async () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const message = makeBroadcastMessage('corr-srv-empty');

      const results = await aggregator.startServerBroadcast(message, [], vi.fn());

      expect(results).toEqual([]);
    });

    it('does not forward any messages when no clients are provided', async () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const message = makeBroadcastMessage('corr-srv-empty-no-fwd');
      const sendToClient = vi.fn();

      await aggregator.startServerBroadcast(message, [], sendToClient);

      expect(sendToClient).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Server-initiated: complete and timeout paths
  // -------------------------------------------------------------------------
  describe('server-initiated with clients', () => {
    it('resolves when all clients respond', async () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const clientA = makeMockClient();
      const clientB = makeMockClient();
      const message = makeBroadcastMessage('corr-srv-all');

      const resultPromise = aggregator.startServerBroadcast(message, [asWs(clientA), asWs(clientB)], vi.fn());

      aggregator.handleResponse(asWs(clientA), {
        type: 'broadcast-response',
        correlationId: 'corr-srv-all',
        results: [{ nodeId: 'a', payload: 'result-a' }],
      });
      aggregator.handleResponse(asWs(clientB), {
        type: 'broadcast-response',
        correlationId: 'corr-srv-all',
        results: [{ nodeId: 'b', payload: 'result-b' }],
      });

      const results = await resultPromise;
      expect(results).toHaveLength(2);
      expect(results).toEqual(
        expect.arrayContaining([
          { nodeId: 'a', payload: 'result-a' },
          { nodeId: 'b', payload: 'result-b' },
        ]),
      );
    });

    it('resolves with partial results on timeout', async () => {
      const aggregator = new BroadcastAggregator({ timeout: 1000 });
      const clientA = makeMockClient();
      const clientB = makeMockClient();
      const message = makeBroadcastMessage('corr-srv-timeout');

      const resultPromise = aggregator.startServerBroadcast(message, [asWs(clientA), asWs(clientB)], vi.fn());

      // Only clientA responds
      aggregator.handleResponse(asWs(clientA), {
        type: 'broadcast-response',
        correlationId: 'corr-srv-timeout',
        results: [{ nodeId: 'a', payload: 'result-a' }],
      });

      vi.advanceTimersByTime(1001);

      const results = await resultPromise;
      expect(results).toEqual([{ nodeId: 'a', payload: 'result-a' }]);
    });

    it('honors per-send timeout overrides', async () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const client = makeMockClient();
      const message = makeBroadcastMessage('corr-srv-timeout-override');

      const resultPromise = aggregator.startServerBroadcast(message, [asWs(client)], vi.fn(), 250);

      vi.advanceTimersByTime(251);

      await expect(resultPromise).resolves.toEqual([]);
    });

    it('honors timeout 0 as no automatic timeout for server-initiated broadcasts', async () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const client = makeMockClient();
      const message = makeBroadcastMessage('corr-srv-no-timeout');

      let settled = false;
      const resultPromise = aggregator.startServerBroadcast(message, [asWs(client)], vi.fn(), 0).then((result) => {
        settled = true;
        return result;
      });

      vi.advanceTimersByTime(5001);
      await Promise.resolve();
      expect(settled).toBe(false);

      aggregator.handleResponse(asWs(client), {
        type: 'broadcast-response',
        correlationId: 'corr-srv-no-timeout',
        results: [{ nodeId: 'client', payload: 'late-result' }],
      });

      await expect(resultPromise).resolves.toEqual([{ nodeId: 'client', payload: 'late-result' }]);
    });
  });

  // -------------------------------------------------------------------------
  // handleNodeResults: edge cases
  // -------------------------------------------------------------------------
  describe('handleNodeResults', () => {
    it('returns false for an unknown correlationId', () => {
      const aggregator = new BroadcastAggregator();
      const handled = aggregator.handleNodeResults('no-such-id', []);
      expect(handled).toBe(false);
    });

    it('finalizes with error when node results include a structured error', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient();
      const message = makeBroadcastMessage('corr-node-error');

      aggregator.startClientBroadcast(asWs(sender), message, [], vi.fn());
      aggregator.handleNodeResults('corr-node-error', [], {
        message: 'Node execution failed',
        code: 'NODE_FAILED',
      });

      expect(sender.send).toHaveBeenCalledOnce();
      const response = lastSentMessage(sender) as {
        type: string;
        correlationId: string;
        error?: { message: string; code?: string };
        results?: BroadcastResult[];
      };
      expect(response.type).toBe('broadcast-response');
      expect(response.correlationId).toBe('corr-node-error');
      expect(response.error).toEqual({
        message: 'Node execution failed',
        code: 'NODE_FAILED',
      });
      expect(response.results).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // handleResponse: edge cases
  // -------------------------------------------------------------------------
  describe('handleResponse', () => {
    it('returns false for an unknown correlationId', () => {
      const aggregator = new BroadcastAggregator();
      const client = makeMockClient();
      const handled = aggregator.handleResponse(asWs(client), {
        type: 'broadcast-response',
        correlationId: 'no-such-id',
      });
      expect(handled).toBe(false);
    });

    it('handles response with no results field gracefully', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient();
      const peer = makeMockClient();
      const message = makeBroadcastMessage('corr-no-results');

      aggregator.startClientBroadcast(asWs(sender), message, [asWs(peer)], vi.fn());

      // Response with no results (undefined)
      aggregator.handleResponse(asWs(peer), {
        type: 'broadcast-response',
        correlationId: 'corr-no-results',
      });

      aggregator.handleNodeResults('corr-no-results', []);

      // Should finalize cleanly with empty results
      expect(sender.send).toHaveBeenCalledOnce();
      const response = lastSentMessage(sender) as { results: BroadcastResult[] };
      expect(response.results).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------
  describe('cleanup', () => {
    it('clears all pending client-initiated broadcasts without sending', () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const sender = makeMockClient();
      const peer = makeMockClient();
      const message = makeBroadcastMessage('corr-cleanup-client');

      aggregator.startClientBroadcast(asWs(sender), message, [asWs(peer)], vi.fn());
      aggregator.cleanup();

      // Timer cleared — advancing time should not trigger finalize
      vi.advanceTimersByTime(6000);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('resolves server-initiated broadcasts with partial results on cleanup', async () => {
      const aggregator = new BroadcastAggregator({ timeout: 5000 });
      const clientA = makeMockClient();
      const clientB = makeMockClient();
      const message = makeBroadcastMessage('corr-cleanup-server');

      const resultPromise = aggregator.startServerBroadcast(message, [asWs(clientA), asWs(clientB)], vi.fn());

      // Only clientA responds before cleanup
      aggregator.handleResponse(asWs(clientA), {
        type: 'broadcast-response',
        correlationId: 'corr-cleanup-server',
        results: [{ nodeId: 'a', payload: 'partial' }],
      });

      aggregator.cleanup();

      const results = await resultPromise;
      expect(results).toEqual([{ nodeId: 'a', payload: 'partial' }]);
    });
  });
});
