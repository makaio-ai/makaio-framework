import { afterEach, describe, it, expect, vi } from 'vitest';
import { createJsonRpcClient } from '../json-rpc-client.js';
import type { JsonlChannel, MessageListener } from '../types.js';
import type { TransportEnd } from '../process-end.js';
import type { IJsonRpcClient } from '../json-rpc-client.js';

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

/**
 * Message channel double for the client's own dispatch and settlement rules. The
 * channel's production of messages and of its end report is driven through real
 * children in `json-rpc-over-jsonl.test.ts`.
 */
interface FakeTransport extends JsonlChannel {
  simulateMessage(msg: unknown): void;
  /** Publish the end report, as a transport does once its end is decided. */
  publishEnd(end: TransportEnd): void;
  readonly sent: object[];
  readonly closeCount: number;
}

function createFakeTransport(): FakeTransport {
  const messageListeners = new Set<MessageListener>();
  const ended = Promise.withResolvers<TransportEnd>();
  const sent: object[] = [];
  let closeCount = 0;

  return {
    send(message: object): void {
      sent.push(message);
    },
    close(): Promise<TransportEnd> {
      closeCount += 1;
      return ended.promise;
    },
    onMessage(listener: MessageListener): () => void {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    ended: ended.promise,
    simulateMessage(msg: unknown): void {
      for (const l of messageListeners) l(msg);
    },
    publishEnd(end: TransportEnd): void {
      ended.resolve(end);
    },
    get sent(): object[] {
      return sent;
    },
    get closeCount(): number {
      return closeCount;
    },
  };
}

/**
 * Build an end report for a child that exited.
 * @param cause - Cause the transport derived.
 * @param exit - How the child ended.
 * @returns A complete end report with a drained channel and no tree ownership.
 */
function endReport(
  cause: TransportEnd['cause'],
  exit: TransportEnd['exit'] = { kind: 'exited', code: null, signal: 'SIGTERM' },
): TransportEnd {
  return {
    cause,
    exit,
    drain: { kind: 'complete', discardedChars: 0 },
    communicationFailure: undefined,
    tree: { kind: 'not-owned' },
  };
}

/**
 * Wait for async JSON-RPC dispatch handlers scheduled from an inbound message.
 */
async function flushDispatch(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createJsonRpcClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('request()', () => {
    it('sends a JSON-RPC 2.0 request and resolves on correlated response', async () => {
      const transport = createFakeTransport();
      const client: IJsonRpcClient = createJsonRpcClient(transport);

      const promise = client.request<{ value: number }>('add', { a: 1, b: 2 });

      expect(transport.sent).toHaveLength(1);
      const sent = transport.sent[0] as Record<string, unknown>;
      expect(sent['jsonrpc']).toBe('2.0');
      expect(sent['method']).toBe('add');
      expect(sent['params']).toEqual({ a: 1, b: 2 });
      expect(typeof sent['id']).toBe('number');

      transport.simulateMessage({ jsonrpc: '2.0', id: sent['id'], result: { value: 3 } });

      const result = await promise;
      expect(result).toEqual({ value: 3 });
    });

    it('rejects on JSON-RPC error response', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const promise = client.request<never>('boom', {});

      const sent = transport.sent[0] as Record<string, unknown>;
      transport.simulateMessage({
        jsonrpc: '2.0',
        id: sent['id'],
        error: { code: -32600, message: 'Invalid Request' },
      });

      await expect(promise).rejects.toThrow('JSON-RPC error -32600: Invalid Request');
    });

    it('rejects immediately if client is already closed', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);
      client.close();

      await expect(client.request('test', {})).rejects.toThrow('JSON-RPC client is closed');
    });

    it('rejects pending requests when the request timeout elapses', async () => {
      vi.useFakeTimers();

      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const promise = client.request('slow', {}, 25);
      const expectation = expect(promise).rejects.toThrow('JSON-RPC request timed out after 25ms: slow');

      await vi.advanceTimersByTimeAsync(25);
      await expectation;
    });

    it('clears request timeout timers when a response arrives', async () => {
      vi.useFakeTimers();

      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const promise = client.request('fast', {}, 25);
      const sent = transport.sent[0] as Record<string, unknown>;

      transport.simulateMessage({ jsonrpc: '2.0', id: sent['id'], result: 'ok' });

      await expect(promise).resolves.toBe('ok');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('notification()', () => {
    it('sends a fire-and-forget message with no id', () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      client.notification('initialized', { version: '1.0' });

      expect(transport.sent).toHaveLength(1);
      const sent = transport.sent[0] as Record<string, unknown>;
      expect(sent['jsonrpc']).toBe('2.0');
      expect(sent['method']).toBe('initialized');
      expect(sent['params']).toEqual({ version: '1.0' });
      expect('id' in sent).toBe(false);
    });

    it('is a no-op when client is closed', () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);
      client.close();

      client.notification('ping', {});

      // only the close() itself causes no sends; no notification send happened
      expect(transport.sent).toHaveLength(0);
    });
  });

  describe('onNotification()', () => {
    it('dispatches incoming notifications to the matching method handler', () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const handler = vi.fn();
      client.onNotification('turn/started', handler);

      transport.simulateMessage({ jsonrpc: '2.0', method: 'turn/started', params: { id: 42 } });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith('turn/started', { id: 42 });
    });

    it('does not dispatch to a handler for a different method', () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const handler = vi.fn();
      client.onNotification('turn/started', handler);

      transport.simulateMessage({ jsonrpc: '2.0', method: 'turn/finished', params: {} });

      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribes and stops receiving notifications after calling the returned function', () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const handler = vi.fn();
      const unsubscribe = client.onNotification('event', handler);

      transport.simulateMessage({ jsonrpc: '2.0', method: 'event', params: { x: 1 } });
      expect(handler).toHaveBeenCalledOnce();

      unsubscribe();

      transport.simulateMessage({ jsonrpc: '2.0', method: 'event', params: { x: 2 } });
      expect(handler).toHaveBeenCalledOnce(); // still only once
    });

    it('continues notification fan-out when a handler throws synchronously', () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      client.onNotification('event', () => {
        throw new Error('handler failed');
      });
      const laterHandler = vi.fn();
      client.onNotification('event', laterHandler);

      expect(() => {
        transport.simulateMessage({ jsonrpc: '2.0', method: 'event', params: { ok: true } });
      }).not.toThrow();
      expect(laterHandler).toHaveBeenCalledWith('event', { ok: true });
    });

    it('delivers a notification to exactly the handlers registered when it arrived', () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);
      const calls: string[] = [];
      const added = vi.fn();
      let unsubscribeSecond: () => void = () => undefined;

      client.onNotification('event', () => {
        calls.push('first');
        // Neither change may alter who receives the message already in dispatch.
        unsubscribeSecond();
        client.onNotification('event', added);
      });
      unsubscribeSecond = client.onNotification('event', () => calls.push('second'));

      transport.simulateMessage({ jsonrpc: '2.0', method: 'event', params: {} });
      expect(calls).toEqual(['first', 'second']);
      expect(added).not.toHaveBeenCalled();

      transport.simulateMessage({ jsonrpc: '2.0', method: 'event', params: {} });
      expect(calls).toEqual(['first', 'second', 'first']);
      expect(added).toHaveBeenCalledOnce();
    });
  });

  describe('onServerRequest()', () => {
    it('receives server-initiated requests and sends the result back with the same id', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      client.onServerRequest(async (request) => {
        const req = request as { method: string; params: { decision: string } };
        expect(req.method).toBe('approval/request');
        return { approved: true };
      });

      transport.simulateMessage({
        jsonrpc: '2.0',
        id: 99,
        method: 'approval/request',
        params: { decision: 'pending' },
      });

      await flushDispatch();

      expect(transport.sent).toHaveLength(1);
      const response = transport.sent[0] as Record<string, unknown>;
      expect(response['jsonrpc']).toBe('2.0');
      expect(response['id']).toBe(99);
      expect(response['result']).toEqual({ approved: true });
    });

    it('sends a JSON-RPC error response when the handler rejects', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      client.onServerRequest(async () => {
        throw new Error('handler failed');
      });

      transport.simulateMessage({ jsonrpc: '2.0', id: 7, method: 'risky/op', params: {} });

      await flushDispatch();

      const response = transport.sent[0] as Record<string, unknown>;
      expect(response['id']).toBe(7);
      expect(response['error']).toEqual({ code: -32603, message: 'handler failed' });
    });

    it('waits for a successful handler instead of letting a faster rejection win', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      client.onServerRequest(async () => {
        throw new Error('fast failure');
      });
      client.onServerRequest(async () => {
        await Promise.resolve();
        return { approved: true };
      });

      transport.simulateMessage({ jsonrpc: '2.0', id: 8, method: 'approval/request', params: {} });

      await flushDispatch();

      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]).toEqual({
        jsonrpc: '2.0',
        id: 8,
        result: { approved: true },
      });
    });

    it('returns the first successful handler in registration order', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      client.onServerRequest(async () => 'first');
      client.onServerRequest(async () => 'second');

      transport.simulateMessage({ jsonrpc: '2.0', id: 9, method: 'approval/request', params: {} });

      await flushDispatch();

      expect(transport.sent[0]).toEqual({ jsonrpc: '2.0', id: 9, result: 'first' });
    });

    it('turns synchronous server-request throws into JSON-RPC error responses', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      client.onServerRequest(() => {
        throw new Error('sync failure');
      });

      expect(() => {
        transport.simulateMessage({ jsonrpc: '2.0', id: 10, method: 'approval/request', params: {} });
      }).not.toThrow();

      await flushDispatch();

      expect(transport.sent[0]).toEqual({
        jsonrpc: '2.0',
        id: 10,
        error: { code: -32603, message: 'sync failure' },
      });
    });

    it('sends a -32601 method-not-found error when no handler is registered', async () => {
      const transport = createFakeTransport();
      const _client = createJsonRpcClient(transport);

      transport.simulateMessage({ jsonrpc: '2.0', id: 5, method: 'do/something', params: {} });

      await flushDispatch();

      expect(transport.sent).toHaveLength(1);
      const response = transport.sent[0] as Record<string, unknown>;
      expect(response['id']).toBe(5);
      expect(response['error']).toMatchObject({ code: -32601 });
    });

    it('sends a -32601 method-not-found error after all handlers unsubscribe', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const handler = vi.fn().mockResolvedValue({ ok: true });
      const unsubscribe = client.onServerRequest(handler);

      unsubscribe();

      transport.simulateMessage({ jsonrpc: '2.0', id: 5, method: 'do/something', params: {} });

      await flushDispatch();

      expect(handler).not.toHaveBeenCalled();
      expect(transport.sent).toHaveLength(1);
      const response = transport.sent[0] as Record<string, unknown>;
      expect(response['id']).toBe(5);
      expect(response['error']).toMatchObject({ code: -32601 });
    });
  });

  describe('close()', () => {
    it('rejects all pending requests with a closed error', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const p1 = client.request('slow', {});
      const p2 = client.request('alsoslow', {});

      client.close();

      await expect(p1).rejects.toThrow('JSON-RPC client closed');
      await expect(p2).rejects.toThrow('JSON-RPC client closed');
    });

    it('closes the client on an unexpected end: pending requests reject with the end, later ones at once', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const p1 = client.request('pending', {});

      transport.publishEnd(endReport('unexpected', { kind: 'exited', code: 3, signal: null }));

      await expect(p1).rejects.toThrow('JSON-RPC transport ended unexpectedly: exited with code 3');
      await expect(client.request('later', {})).rejects.toThrow('JSON-RPC client is closed');
      expect(transport.sent).toHaveLength(1);
    });

    it('settles pending requests when the transport was stopped by someone else', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const p1 = client.request('pending', {}, 0);

      transport.publishEnd(endReport('requested'));

      await expect(p1).rejects.toThrow('JSON-RPC transport stopped on request: exited with signal SIGTERM');
      await expect(client.request('later', {})).rejects.toThrow('JSON-RPC client is closed');
    });

    it('keeps the immediate closed rejection when the client itself closes before the end', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const p1 = client.request('pending', {}, 0);
      client.close();
      transport.publishEnd(endReport('requested'));

      await expect(p1).rejects.toThrow('JSON-RPC client closed');
      expect(transport.closeCount).toBe(1);
    });

    it('does not close a transport that already ended', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      transport.publishEnd(endReport('unexpected'));
      await flushDispatch();
      await expect(client.request('later', {})).rejects.toThrow('JSON-RPC client is closed');
      client.close();

      expect(transport.closeCount).toBe(0);
    });

    it('detaches from transport so no further messages are dispatched after close', () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const handler = vi.fn();
      client.onNotification('event', handler);
      client.close();

      transport.simulateMessage({ jsonrpc: '2.0', method: 'event', params: {} });

      expect(handler).not.toHaveBeenCalled();
    });

    it('is idempotent', () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      client.close();
      client.close();

      expect(transport.closeCount).toBe(1);
    });
  });
});
