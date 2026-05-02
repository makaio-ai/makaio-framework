/**
 * Tests for CodexAppServerConnector - Initialization
 *
 * Tests the initialization handshake:
 * - Initialize handshake (initialize → initialized)
 * - Thread start (thread/start → thread/started)
 * - Initial turn/start request
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexAppServerConnector } from '../connector.js';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  MockJsonRpcClient,
  startConnectorAndEmitThreadStarted,
  startConnectorWithThread,
  type ConnectorTestContext,
} from './shared.js';

describe('CodexAppServerConnector - Initialization', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('should send initialize request on first start', async () => {
    await startConnectorWithThread(ctx, 'Hello');

    expect(ctx.mockJsonRpcClient.sentRequests).toHaveLength(3);
    expect(ctx.mockJsonRpcClient.sentRequests[0]).toMatchObject({
      method: 'initialize',
    });
  });

  it('should send initialized notification after initialize', async () => {
    await startConnectorWithThread(ctx, 'Hello');

    expect(ctx.mockJsonRpcClient.sentNotifications).toHaveLength(1);
    expect(ctx.mockJsonRpcClient.sentNotifications[0]).toMatchObject({
      method: 'initialized',
    });
  });

  it('should send thread/start request after initialization', async () => {
    await startConnectorWithThread(ctx, 'Hello');

    expect(ctx.mockJsonRpcClient.sentRequests[1]).toMatchObject({
      method: 'thread/start',
    });
  });

  it('should set threadId from thread/started notification', async () => {
    const result = await startConnectorWithThread(ctx, 'Hello');

    expect(result.adapterSessionId).toBe('thread-123');
  });

  it('should send turn/start request with user message', async () => {
    await startConnectorWithThread(ctx, 'Hello world');

    // Check that turn/start was sent with correct UserInput format
    const turnStart = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'turn/start');
    expect(turnStart).toBeDefined();
    expect(turnStart?.params).toMatchObject({
      threadId: 'thread-123',
      input: [
        {
          type: 'text',
          text: 'Hello world',
        },
      ],
    });
  });

  it('should include experimentalRawEvents in thread/start request', async () => {
    await startConnectorWithThread(ctx, 'Hello');

    const threadStart = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'thread/start');
    expect(threadStart).toBeDefined();
    expect((threadStart?.params as { experimentalRawEvents?: boolean }).experimentalRawEvents).toBe(false);
  });

  it('should include reasoningEffort in turn/start request when configured', async () => {
    // Create a new context with reasoningEffort configured
    cleanupConnectorTestContext(ctx);
    ctx = await createConnectorTestContext({ reasoningEffort: 'high' });

    await startConnectorWithThread(ctx, 'Hello');

    const turnStart = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'turn/start');
    expect(turnStart).toBeDefined();
    expect((turnStart?.params as { effort?: string }).effort).toBe('high');
  });

  it('should send null effort in turn/start when reasoningEffort not configured', async () => {
    await startConnectorWithThread(ctx, 'Hello');

    const turnStart = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'turn/start');
    expect(turnStart).toBeDefined();
    expect((turnStart?.params as { effort?: string | null }).effort).toBeNull();
  });

  it('retries initialization cleanly after an initialize failure', async () => {
    const failingClient = new MockJsonRpcClient();
    const requestSpy = vi.spyOn(failingClient, 'request');
    requestSpy.mockImplementationOnce(async (method, params) => {
      failingClient.sentRequests.push({ method, params });
      throw new Error('initialize failed');
    });

    cleanupConnectorTestContext(ctx);
    ctx = await createConnectorTestContext();
    ctx.mockJsonRpcClient = failingClient;
    ctx.connector = new CodexAppServerConnector({
      bus: ctx.mockBus,
      adapterId: 'test-adapter',
      adapterName: 'codex-app-server',
      agentId: 'test-agent',
      model: 'claude-3-5-sonnet-20241022',
      cwd: ctx.tempCwd,
      env: {},
      jsonRpcClient: failingClient,
    });

    await expect(ctx.connector.initialize()).rejects.toThrow('initialize failed');
    expect(failingClient.sentNotifications).toHaveLength(0);

    await startConnectorAndEmitThreadStarted(ctx.connector, failingClient, 'Hello after retry');

    expect(failingClient.sentRequests.filter((request) => request.method === 'initialize')).toHaveLength(2);
    expect(failingClient.sentNotifications).toEqual([{ method: 'initialized', params: {} }]);
    expect(failingClient.notificationHandlers.size).toBeGreaterThan(0);
  });
});
