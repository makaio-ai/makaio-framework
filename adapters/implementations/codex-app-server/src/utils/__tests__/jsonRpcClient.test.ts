import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createJsonRpcClient } from '../jsonRpcClient.js';
import type { StdioTransport, StdioMessage } from '../createStdioTransport.js';

/**
 * Mock transport for testing
 */
class MockTransport implements StdioTransport {
  sentMessages: unknown[] = [];

  /** No child process backs this double, so its exit is never observed. */
  readonly exited = new Promise<number | null>(() => {});

  closeRequested = false;

  messageCallback: ((message: StdioMessage) => void) | null = null;
  errorCallback: ((error: Error) => void) | null = null;

  send(message: object): void {
    this.sentMessages.push(message);
  }

  close(): void {
    this.closeRequested = true;
  }

  shutdownRequested(): boolean {
    return this.closeRequested;
  }

  onMessage(callback: (message: StdioMessage) => void): void {
    this.messageCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback;
  }

  /**
   * Simulate receiving a message from the transport
   * @param message - Message to receive
   */
  receiveMessage(message: unknown): void {
    this.messageCallback?.(message as StdioMessage);
  }

  /**
   * Simulate receiving an error from the transport
   * @param error - Error to receive
   */
  receiveError(error: Error): void {
    this.errorCallback?.(error);
  }
}

describe('createJsonRpcClient', () => {
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
    vi.clearAllMocks();
  });

  it('should send JSON-RPC 2.0 request with correct format', async () => {
    const client = createJsonRpcClient(transport);

    const requestPromise = client.request('test/method', { foo: 'bar' });

    // Check that message was sent
    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'test/method',
      params: { foo: 'bar' },
    });

    // Simulate response
    transport.receiveMessage({
      id: 1,
      result: { success: true },
    });

    await expect(requestPromise).resolves.toEqual({ success: true });
  });

  it('should generate sequential request IDs', async () => {
    const client = createJsonRpcClient(transport);

    client.request('method1', {});
    client.request('method2', {});
    client.request('method3', {});

    expect(transport.sentMessages).toHaveLength(3);
    expect(transport.sentMessages[0]).toMatchObject({ id: 1 });
    expect(transport.sentMessages[1]).toMatchObject({ id: 2 });
    expect(transport.sentMessages[2]).toMatchObject({ id: 3 });
  });

  it('should resolve request promise on successful response', async () => {
    const client = createJsonRpcClient(transport);

    const requestPromise = client.request<{ result: string }>('test/method', {});

    transport.receiveMessage({
      id: 1,
      result: { result: 'test-value' },
    });

    await expect(requestPromise).resolves.toEqual({ result: 'test-value' });
  });

  it('should reject request promise on error response', async () => {
    const client = createJsonRpcClient(transport);

    const requestPromise = client.request('test/method', {});

    transport.receiveMessage({
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    });

    await expect(requestPromise).rejects.toThrow('Method not found');
  });

  it('should reject request promise on transport error', async () => {
    const client = createJsonRpcClient(transport);

    const requestPromise = client.request('test/method', {});

    transport.receiveError(new Error('Transport error'));

    await expect(requestPromise).rejects.toThrow('Transport error');
  });

  it('should send JSON-RPC 2.0 notification without ID', () => {
    const client = createJsonRpcClient(transport);

    client.notification('test/notification', { foo: 'bar' });

    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toEqual({
      jsonrpc: '2.0',
      method: 'test/notification',
      params: { foo: 'bar' },
    });
    // Should not have id field
    expect(transport.sentMessages[0]).not.toHaveProperty('id');
  });

  it('should dispatch notifications to registered handlers', () => {
    const client = createJsonRpcClient(transport);
    const handler = vi.fn();

    client.onNotification('test/notification', handler);

    transport.receiveMessage({
      method: 'test/notification',
      params: { foo: 'bar' },
    });

    expect(handler).toHaveBeenCalledWith('test/notification', { foo: 'bar' });
  });

  it('should not dispatch notifications to unregistered methods', () => {
    const client = createJsonRpcClient(transport);
    const handler = vi.fn();

    client.onNotification('other/notification', handler);

    transport.receiveMessage({
      method: 'test/notification',
      params: { foo: 'bar' },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should support multiple notification handlers', () => {
    const client = createJsonRpcClient(transport);
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    client.onNotification('test/notification', handler1);
    client.onNotification('other/notification', handler2);

    transport.receiveMessage({
      method: 'test/notification',
      params: { foo: 'bar' },
    });

    transport.receiveMessage({
      method: 'other/notification',
      params: { baz: 'qux' },
    });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should handle server requests and send response back', async () => {
    const client = createJsonRpcClient(transport);
    const handler = vi.fn().mockResolvedValue({ decision: 'accept' });

    client.onServerRequest(handler);

    // Simulate server request
    transport.receiveMessage({
      id: 100,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'ls' },
    });

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Check that handler was called
    expect(handler).toHaveBeenCalled();

    // Check that response was sent back
    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toEqual({
      jsonrpc: '2.0',
      id: 100,
      result: { decision: 'accept' },
    });
  });

  it('should send error response when server request handler fails', async () => {
    const client = createJsonRpcClient(transport);
    const handler = vi.fn().mockRejectedValue(new Error('Handler failed'));

    client.onServerRequest(handler);

    // Simulate server request
    transport.receiveMessage({
      id: 100,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'ls' },
    });

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Check that error response was sent back
    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 100,
      error: {
        code: -32603,
        message: 'Handler failed',
      },
    });
  });

  it('should close transport and reject pending requests on close', async () => {
    const client = createJsonRpcClient(transport);

    const request1 = client.request('method1', {});
    const request2 = client.request('method2', {});
    const request3 = client.request('method3', {});

    // Respond to request 2 only
    transport.receiveMessage({
      id: 2,
      result: { success: true },
    });

    // Close client
    client.close();

    // Request 2 should resolve
    await expect(request2).resolves.toEqual({ success: true });

    // Requests 1 and 3 should be rejected
    await expect(request1).rejects.toThrow('JSON-RPC client closed');
    await expect(request3).rejects.toThrow('JSON-RPC client closed');
  });

  it('should handle multiple concurrent requests correctly', async () => {
    const client = createJsonRpcClient(transport);

    const request1 = client.request('method1', {});
    const request2 = client.request('method2', {});
    const request3 = client.request('method3', {});

    // Respond in different order
    transport.receiveMessage({ id: 3, result: 'result3' });
    transport.receiveMessage({ id: 1, result: 'result1' });
    transport.receiveMessage({ id: 2, result: 'result2' });

    await expect(request1).resolves.toBe('result1');
    await expect(request2).resolves.toBe('result2');
    await expect(request3).resolves.toBe('result3');
  });

  it('should ignore response messages for unknown request IDs', () => {
    const client = createJsonRpcClient(transport);
    const handler = vi.fn();

    client.onNotification('test/notification', handler);

    // Response for unknown ID should not cause errors
    expect(() => {
      transport.receiveMessage({ id: 999, result: 'unknown' });
    }).not.toThrow();
  });

  it('should handle messages without method or id gracefully', () => {
    createJsonRpcClient(transport);

    // Message without method or id should not cause errors
    expect(() => {
      transport.receiveMessage({ foo: 'bar' });
    }).not.toThrow();
  });

  it('should allow registering only one server request handler', async () => {
    const client = createJsonRpcClient(transport);
    const handler1 = vi.fn().mockResolvedValue({ decision: 'accept' });
    const handler2 = vi.fn().mockResolvedValue({ decision: 'decline' });

    client.onServerRequest(handler1);
    client.onServerRequest(handler2); // Should replace handler1

    transport.receiveMessage({
      id: 100,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'ls' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
    expect(transport.sentMessages[0]).toEqual({
      jsonrpc: '2.0',
      id: 100,
      result: { decision: 'decline' },
    });
  });
});
