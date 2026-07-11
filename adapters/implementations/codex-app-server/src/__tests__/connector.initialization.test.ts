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
import { CodexConnectorCloseError } from '../connector/connector-shutdown.js';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  MockJsonRpcClient,
  createApiKeyAdapterAuth,
  startConnectorAndEmitThreadStarted,
  startConnectorWithThread,
  type ConnectorTestContext,
} from './shared.js';
import { CodexAccountLoginError } from '../connector/account-login.js';

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

  it('performs API-key login after initialize and before every thread operation', async () => {
    cleanupConnectorTestContext(ctx);
    ctx = await createConnectorTestContext({ adapterAuth: createApiKeyAdapterAuth('private-api-key') });

    await ctx.connector.initialize();

    expect(ctx.mockJsonRpcClient.operations.slice(0, 4)).toEqual([
      { kind: 'request', method: 'initialize', params: expect.any(Object) },
      { kind: 'notification', method: 'initialized', params: {} },
      {
        kind: 'request',
        method: 'account/login/start',
        params: { type: 'apiKey', apiKey: 'private-api-key' },
      },
      { kind: 'request', method: 'thread/start', params: expect.any(Object) },
    ]);
  });

  it('logs in at most once for one successfully initialized app-server process', async () => {
    cleanupConnectorTestContext(ctx);
    ctx = await createConnectorTestContext({ adapterAuth: createApiKeyAdapterAuth() });

    await ctx.connector.initialize();
    await ctx.connector.initialize();

    expect(ctx.mockJsonRpcClient.sentRequests.filter(({ method }) => method === 'account/login/start')).toHaveLength(1);
    expect(ctx.mockJsonRpcClient.sentRequests.filter(({ method }) => method.startsWith('thread/'))).toHaveLength(1);
  });

  it('does not issue API-key login for native or access-token process auth', async () => {
    cleanupConnectorTestContext(ctx);
    const native = await createConnectorTestContext({ env: { CODEX_HOME: '/isolated/native-codex' } });
    const accessToken = await createConnectorTestContext({
      env: { CODEX_HOME: '/isolated/token-codex', CODEX_ACCESS_TOKEN: 'access-token' },
      adapterAuth: {
        processEnv: { CODEX_ACCESS_TOKEN: 'access-token' },
        connectorDeliveries: [],
        configInheritance: 'empty',
      },
    });

    try {
      await native.connector.initialize();
      await accessToken.connector.initialize();
      expect(native.mockJsonRpcClient.sentRequests.some(({ method }) => method === 'account/login/start')).toBe(false);
      expect(accessToken.mockJsonRpcClient.sentRequests.some(({ method }) => method === 'account/login/start')).toBe(
        false,
      );
    } finally {
      await native.connector.close();
      await accessToken.connector.close();
      cleanupConnectorTestContext(native);
      cleanupConnectorTestContext(accessToken);
    }
  });

  it('blocks thread startup, sanitizes login failure, and retries the full process-ready handshake', async () => {
    class FailFirstLoginClient extends MockJsonRpcClient {
      private shouldFailLogin = true;

      public override async request<T>(method: string, params: unknown): Promise<T> {
        if (method === 'account/login/start' && this.shouldFailLogin) {
          this.shouldFailLogin = false;
          this.sentRequests.push({ method, params });
          this.operations.push({ kind: 'request', method, params });
          throw new Error('provider echoed private-api-key');
        }
        return super.request<T>(method, params);
      }
    }

    cleanupConnectorTestContext(ctx);
    const client = new FailFirstLoginClient();
    ctx = await createConnectorTestContext({
      adapterAuth: createApiKeyAdapterAuth('private-api-key'),
      jsonRpcClient: client,
    });

    let loginError: unknown;
    try {
      await ctx.connector.initialize();
    } catch (error) {
      loginError = error;
    }

    expect(loginError).toBeInstanceOf(CodexAccountLoginError);
    expect((loginError as Error).message).not.toContain('private-api-key');
    expect(client.sentRequests.some(({ method }) => method.startsWith('thread/'))).toBe(false);

    await ctx.connector.initialize();

    expect(client.sentRequests.filter(({ method }) => method === 'initialize')).toHaveLength(2);
    expect(client.sentRequests.filter(({ method }) => method === 'account/login/start')).toHaveLength(2);
    expect(client.sentRequests.filter(({ method }) => method === 'thread/start')).toHaveLength(1);
  });

  it('discards private API-key login material when the connector closes', async () => {
    cleanupConnectorTestContext(ctx);
    ctx = await createConnectorTestContext({ adapterAuth: createApiKeyAdapterAuth('private-api-key') });
    await ctx.connector.initialize();

    expect(Reflect.get(ctx.connector, 'accountLogin')).toMatchObject({ type: 'apiKey' });

    await ctx.connector.close();

    expect(Reflect.get(ctx.connector, 'accountLogin')).toBeUndefined();
  });

  it('attempts client close, sanitizes both shutdown failures, and discards private login material', async () => {
    class FailingShutdownClient extends MockJsonRpcClient {
      public override async request<T>(method: string, params: unknown): Promise<T> {
        if (method === 'thread/archive') {
          throw new Error('archive echoed private-api-key');
        }
        return super.request<T>(method, params);
      }

      public override close(): void {
        super.close();
        throw new Error('close echoed private-api-key');
      }
    }

    cleanupConnectorTestContext(ctx);
    const client = new FailingShutdownClient();
    ctx = await createConnectorTestContext({
      adapterAuth: createApiKeyAdapterAuth('private-api-key'),
      jsonRpcClient: client,
    });
    await ctx.connector.initialize();

    let closeError: unknown;
    try {
      await ctx.connector.close();
    } catch (error) {
      closeError = error;
    }

    expect(closeError).toBeInstanceOf(AggregateError);
    expect((closeError as AggregateError).errors).toEqual([
      expect.objectContaining<Partial<CodexConnectorCloseError>>({ reason: 'archive-failed' }),
      expect.objectContaining<Partial<CodexConnectorCloseError>>({ reason: 'client-close-failed' }),
    ]);
    expect((closeError as Error).message).not.toContain('private-api-key');
    expect(client.operations.some(({ kind }) => kind === 'close')).toBe(true);
    expect(Reflect.get(ctx.connector, 'accountLogin')).toBeUndefined();
  });

  it('sanitizes an abort close failure and still discards private login material', async () => {
    class FailingCloseClient extends MockJsonRpcClient {
      public override close(): void {
        throw new Error('close echoed private-api-key');
      }
    }

    cleanupConnectorTestContext(ctx);
    ctx = await createConnectorTestContext({
      adapterAuth: createApiKeyAdapterAuth('private-api-key'),
      jsonRpcClient: new FailingCloseClient(),
    });

    expect(() => ctx.connector.abort()).toThrowError(
      expect.objectContaining<Partial<CodexConnectorCloseError>>({ reason: 'client-close-failed' }),
    );
    expect(Reflect.get(ctx.connector, 'accountLogin')).toBeUndefined();
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
