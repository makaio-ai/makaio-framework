/**
 * Shared test utilities for CodexAppServerConnector tests
 *
 * Contains mock implementations and helper functions used across
 * multiple test files.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ISessionToolLedger } from '@makaio/ai-adapters-core';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import type { ClientExecutionContext } from '@makaio/contracts/client';
import type { AIReasoningLevel, NativeForkDirective } from '@makaio/contracts';
import { CodexAppServerConnector } from '../connector.js';
import { CodexAppServerNamespace } from '../namespaces/index.js';
import type { JsonRpcClient, ServerRequestHandler, NotificationHandler } from '../utils/jsonRpcClient.js';
import type { ServerRequest } from '../protocol/generated/index.js';

/**
 * Mock thread type returned by createMockThread
 */
export interface MockThread {
  id: string;
  preview: string;
  modelProvider: string;
  createdAt: number;
  path: string;
  cwd: string;
  cliVersion: string;
  source: string;
  gitInfo: null;
  turns: unknown[];
}

/**
 * Mock turn type returned by createMockTurn
 */
export interface MockTurn {
  id: string;
  items: unknown[];
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: null;
}

/**
 * Mock JSON-RPC client for testing
 */
export class MockJsonRpcClient implements JsonRpcClient {
  sentRequests: Array<{ method: string; params: unknown }> = [];
  sentNotifications: Array<{ method: string; params: unknown }> = [];
  operations: Array<{ kind: 'request' | 'notification' | 'close'; method?: string; params?: unknown }> = [];
  notificationHandlers = new Map<string, NotificationHandler>();
  serverRequestHandler: ServerRequestHandler | null = null;
  closed = false;

  async request<T>(method: string, params: unknown): Promise<T> {
    this.sentRequests.push({ method, params });
    this.operations.push({ kind: 'request', method, params });
    if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
      return { thread: createMockThread() } as T;
    }
    if (method === 'account/login/start') {
      return { type: 'apiKey' } as T;
    }
    return {} as T;
  }

  notification(method: string, params: unknown): void {
    this.sentNotifications.push({ method, params });
    this.operations.push({ kind: 'notification', method, params });
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.operations.push({ kind: 'close' });
  }

  async receiveNotification(method: string, params: unknown): Promise<void> {
    const handler = this.notificationHandlers.get(method);
    // Note: handler returns void but we await for test pattern consistency

    await handler?.(method, params);
  }

  async receiveServerRequest(
    request: ServerRequest | { id: number; method: string; params: unknown },
  ): Promise<unknown> {
    return this.serverRequestHandler?.(request as ServerRequest) ?? {};
  }
}

/**
 * Helper to create a mock thread object
 * @param overrides - Optional overrides for the mock thread
 */
export function createMockThread(overrides: Partial<{ id: string }> = {}): MockThread {
  return {
    id: overrides.id ?? 'thread-123',
    preview: 'Test thread',
    modelProvider: 'openai',
    createdAt: Date.now() / 1000,
    path: '/tmp/thread',
    cwd: '/tmp',
    cliVersion: '0.1.0',
    source: 'cli',
    gitInfo: null,
    turns: [],
  };
}

/**
 * Helper to create a mock turn object
 * @param overrides - Optional overrides for the mock turn
 */
export function createMockTurn(
  overrides: Partial<{ id: string; status: 'completed' | 'interrupted' | 'failed' | 'inProgress' }> = {},
): MockTurn {
  return {
    id: overrides.id ?? 'turn-456',
    items: [],
    status: overrides.status ?? 'inProgress',
    error: null,
  };
}

/**
 * Test context containing all shared resources for connector tests
 */
export interface ConnectorTestContext {
  mockBus: Awaited<ReturnType<typeof CodexAppServerNamespace.scopedBus>>;
  mockJsonRpcClient: MockJsonRpcClient;
  connector: CodexAppServerConnector;
  tempCwd: string;
}

interface ThreadStartedNotificationReceiver {
  receiveNotification(method: 'thread/started', params: { thread: MockThread }): Promise<void>;
}

/**
 * Options for creating a connector test context
 */
export interface CreateConnectorTestContextOptions {
  globalBus?: IMakaioBus;
  reasoningEffort?: AIReasoningLevel;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  toolLedger?: ISessionToolLedger;
  /** Previous adapter session ID for native resume. */
  resumeAdapterSessionId?: string;
  /** Native fork directive — when present, connector uses thread/fork instead of thread/start. */
  nativeFork?: NativeForkDirective;
  /** Finalized environment supplied by the central adapter runtime. */
  env?: Record<string, string>;
  /** Finalized managed/global client binary selection. */
  clientExecution?: ClientExecutionContext;
  /** Final connector-local auth snapshot. */
  adapterAuth?: ResolvedAdapterAuth;
  /** Optional JSON-RPC client override for failure/reconnect tests. */
  jsonRpcClient?: MockJsonRpcClient;
}

/**
 * Creates a test context with all necessary mocks and connector
 * @param options - Optional configuration overrides for the connector
 * @returns Test context with mockBus, mockJsonRpcClient, connector, and tempCwd
 */
export async function createConnectorTestContext(
  options: CreateConnectorTestContextOptions = {},
): Promise<ConnectorTestContext> {
  const tempCwd = mkdtempSync(join(tmpdir(), 'codex-test-'));
  const mockBus = await CodexAppServerNamespace.scopedBus();
  const mockJsonRpcClient = options.jsonRpcClient ?? new MockJsonRpcClient();

  const connector = new CodexAppServerConnector({
    bus: mockBus,
    adapterId: 'test-adapter',
    adapterName: 'codex-app-server',
    agentId: 'test-agent',
    model: 'claude-3-5-sonnet-20241022',
    cwd: tempCwd,
    env: options.env ?? {},
    jsonRpcClient: mockJsonRpcClient,
    clientId: 'codex',
    ...(options.clientExecution !== undefined && { clientExecution: options.clientExecution }),
    ...(options.adapterAuth !== undefined && { adapterAuth: options.adapterAuth }),
    ...(options.reasoningEffort !== undefined && { reasoningEffort: options.reasoningEffort }),
    ...(options.approvalPolicy !== undefined && { approvalPolicy: options.approvalPolicy }),
    ...(options.sandboxMode !== undefined && { sandboxMode: options.sandboxMode }),
    ...(options.toolLedger !== undefined && { toolLedger: options.toolLedger }),
    ...(options.globalBus !== undefined && { globalBus: options.globalBus }),
    ...(options.resumeAdapterSessionId !== undefined && { resumeAdapterSessionId: options.resumeAdapterSessionId }),
    ...(options.nativeFork !== undefined && { nativeFork: options.nativeFork }),
  });

  return { mockBus, mockJsonRpcClient, connector, tempCwd };
}

/**
 * Build the finalized connector delivery for provider-owned Codex API-key auth.
 * @param apiKey - Test-only API key value
 * @returns Connector-local auth snapshot
 */
export function createApiKeyAdapterAuth(apiKey = 'codex-test-api-key'): ResolvedAdapterAuth {
  return {
    processEnv: {},
    connectorDeliveries: [
      {
        target: 'codex.account-login.api-key',
        values: { type: 'apiKey', apiKey },
      },
    ],
    configInheritance: 'empty',
  };
}

/**
 * Cleans up test context resources
 * @param ctx - The test context to clean up
 */
export function cleanupConnectorTestContext(ctx: ConnectorTestContext): void {
  if (ctx.tempCwd) {
    rmSync(ctx.tempCwd, { recursive: true, force: true });
  }
}

/**
 * Starts the connector and waits for thread/started notification
 * @param ctx - The test context
 * @param message - The initial message to send
 */
export async function startConnectorWithThread(
  ctx: ConnectorTestContext,
  message: string = 'Test message',
): Promise<{ adapterSessionId: string }> {
  return startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, message);
}

/**
 * Start a connector, yield once, and emit a `thread/started` notification on the provided client.
 *
 * Lets tests drive custom JSON-RPC clients through the same bootstrap path without duplicating
 * the start → event loop yield → thread notification sequence.
 * @param connector - Connector under test
 * @param client - JSON-RPC client that should receive the synthetic notification
 * @param message - Initial user message text
 * @returns Start result once the thread-start flow completes
 */
export async function startConnectorAndEmitThreadStarted(
  connector: CodexAppServerConnector,
  client: ThreadStartedNotificationReceiver,
  message: string = 'Test message',
): Promise<{ adapterSessionId: string }> {
  const startPromise = connector.start({
    role: 'user',
    message,
    blocks: [{ type: 'text', content: message }],
  });

  // Yield to event loop to allow startThread() to set up deferred promise
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Simulate thread/started notification to complete the flow
  await client.receiveNotification('thread/started', {
    thread: createMockThread(),
  });

  return startPromise;
}

/**
 * Starts the connector, waits for thread/started, and simulates turn/started
 * @param ctx - The test context
 * @param message - The initial message to send
 */
export async function startConnectorWithTurn(
  ctx: ConnectorTestContext,
  message: string = 'Test message',
): Promise<void> {
  await startConnectorWithThread(ctx, message);

  // Simulate turn/started notification
  await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
    threadId: 'thread-123',
    turn: createMockTurn(),
  });
}
