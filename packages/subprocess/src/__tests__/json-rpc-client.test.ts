import { afterEach, describe, it, expect, vi } from 'vitest';
import { createJsonRpcClient } from '../json-rpc-client.js';
import type { IJsonlTransport, MessageListener, ErrorListener } from '../types.js';
import type { IJsonRpcClient } from '../json-rpc-client.js';

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

interface FakeTransport extends IJsonlTransport {
  simulateMessage(msg: unknown): void;
  simulateError(error: Error): void;
  readonly sent: object[];
  readonly closeCount: number;
}

function createFakeTransport(): FakeTransport {
  const messageListeners = new Set<MessageListener>();
  const errorListeners = new Set<ErrorListener>();
  const sent: object[] = [];
  let closeCount = 0;

  return {
    send(message: object): void {
      sent.push(message);
    },
    close(): void {
      closeCount += 1;
    },
    onMessage(listener: MessageListener): () => void {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onError(listener: ErrorListener): () => void {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    get process(): never {
      return undefined as never;
    },
    simulateMessage(msg: unknown): void {
      for (const l of messageListeners) l(msg);
    },
    simulateError(error: Error): void {
      for (const l of errorListeners) l(error);
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

    it('rejects all pending requests when the transport emits an error', async () => {
      const transport = createFakeTransport();
      const client = createJsonRpcClient(transport);

      const p1 = client.request('pending', {});

      transport.simulateError(new Error('transport died'));

      await expect(p1).rejects.toThrow('transport died');
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
