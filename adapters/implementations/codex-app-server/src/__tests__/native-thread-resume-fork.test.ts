/**
 * Tests for CodexAppServerConnector — native thread resume and fork.
 *
 * Verifies that the connector sends the correct JSON-RPC method
 * (`thread/resume` or `thread/fork`) when configured with the
 * corresponding directive, and that only stable `threadId` params
 * are used (never `path` or `history`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeForkDirective } from '@makaio/contracts';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  createMockThread,
  startConnectorAndEmitThreadStarted,
  type ConnectorTestContext,
} from './shared.js';
import { CodexAppServerNamespace } from '../namespaces/index.js';

type ConnectorStartResult = Awaited<ReturnType<ConnectorTestContext['connector']['start']>>;

/**
 * Run a promise with a short timeout so notification-only startup failures do not hang tests.
 * @param promise - Promise under test
 * @param message - Error message used when the promise does not settle
 * @returns The settled promise value
 */
async function withStartupTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), 250);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

/**
 * Starts the connector without injecting a `thread/started` notification.
 * @param ctx - Connector test context
 * @param message - Initial user message text
 * @returns Connector start result when startup consumes the thread response ID
 */
function startConnectorWithoutThreadStartedNotification(
  ctx: ConnectorTestContext,
  message = 'Hello',
): Promise<ConnectorStartResult> {
  return withStartupTimeout(
    ctx.connector.start({
      role: 'user',
      message,
      blocks: [{ type: 'text', content: message }],
    }),
    'connector.start timed out waiting for thread identity',
  );
}

/**
 * Configure the JSON-RPC mock to return a custom thread ID from thread lifecycle requests.
 * @param ctx - Connector test context
 * @param threadId - Thread ID to place in thread/start, thread/resume, and thread/fork responses
 */
function mockThreadLifecycleResponses(ctx: ConnectorTestContext, threadId: string): void {
  vi.spyOn(ctx.mockJsonRpcClient, 'request').mockImplementation(
    async <T>(method: string, params: unknown): Promise<T> => {
      ctx.mockJsonRpcClient.sentRequests.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
        return { thread: createMockThread({ id: threadId }) } as T;
      }
      return {} as T;
    },
  );
}

describe('CodexAppServerConnector - Thread Response IDs', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
    vi.restoreAllMocks();
  });

  it('sets adapterSessionId from thread/start response before thread/started notification', async () => {
    mockThreadLifecycleResponses(ctx, 'thread-from-start-response');

    const result = await startConnectorWithoutThreadStartedNotification(ctx);

    expect(result.adapterSessionId).toBe('thread-from-start-response');
    expect(ctx.mockJsonRpcClient.sentRequests).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({ threadId: 'thread-from-start-response' }),
      }),
    );
  });

  it('treats a matching thread/started notification after the response as idempotent confirmation', async () => {
    const threadStartedEvents: unknown[] = [];
    ctx.mockBus.on(CodexAppServerNamespace.subjects.thread_started, (busCtx) => {
      threadStartedEvents.push(busCtx.payload);
    });
    mockThreadLifecycleResponses(ctx, 'thread-from-start-response');

    const result = await startConnectorWithoutThreadStartedNotification(ctx);
    await ctx.mockJsonRpcClient.receiveNotification('thread/started', {
      thread: createMockThread({ id: 'thread-from-start-response' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.adapterSessionId).toBe('thread-from-start-response');
    expect(threadStartedEvents).toHaveLength(1);
    expect(threadStartedEvents[0]).toMatchObject({ threadId: 'thread-from-start-response' });
  });
});

describe('CodexAppServerConnector - Native Thread Resume', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext({ resumeAdapterSessionId: 'source-thread' });
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
    vi.restoreAllMocks();
  });

  it('sends thread/resume instead of thread/start when resumeAdapterSessionId is set', async () => {
    await startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, 'Hello');

    expect(ctx.mockJsonRpcClient.sentRequests).toContainEqual(
      expect.objectContaining({
        method: 'thread/resume',
        params: expect.objectContaining({ threadId: 'source-thread' }),
      }),
    );
  });

  it('does not send thread/start when resumeAdapterSessionId is set', async () => {
    await startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, 'Hello');

    const threadStartRequest = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'thread/start');
    expect(threadStartRequest).toBeUndefined();
  });

  it('does not include unstable path or history params in thread/resume', async () => {
    await startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, 'Hello');

    const resumeRequest = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'thread/resume');
    expect(resumeRequest).toBeDefined();
    expect(resumeRequest!.params).not.toHaveProperty('path');
    expect(resumeRequest!.params).not.toHaveProperty('history');
  });

  it('sets adapterSessionId after resume startup', async () => {
    const result = await startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, 'Hello');

    expect(result.adapterSessionId).toBe('thread-123');
  });

  it('sets adapterSessionId from thread/resume response before thread/started notification', async () => {
    mockThreadLifecycleResponses(ctx, 'thread-from-resume-response');

    const result = await startConnectorWithoutThreadStartedNotification(ctx);

    expect(result.adapterSessionId).toBe('thread-from-resume-response');
    expect(ctx.mockJsonRpcClient.sentRequests).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({ threadId: 'thread-from-resume-response' }),
      }),
    );
  });
});

describe('CodexAppServerConnector - Native Thread Fork', () => {
  let ctx: ConnectorTestContext;

  const nativeFork: NativeForkDirective = {
    sourceSessionId: 'makaio-session-abc',
    sourceAdapterSessionId: 'source-thread',
    targetWorkingDirectory: '/new/worktree',
  };

  beforeEach(async () => {
    ctx = await createConnectorTestContext({ nativeFork });
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
    vi.restoreAllMocks();
  });

  it('sends thread/fork instead of thread/start when nativeFork directive is set', async () => {
    await startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, 'Hello');

    expect(ctx.mockJsonRpcClient.sentRequests).toContainEqual(
      expect.objectContaining({
        method: 'thread/fork',
        params: expect.objectContaining({
          threadId: 'source-thread',
          cwd: '/new/worktree',
        }),
      }),
    );
  });

  it('does not send thread/start when nativeFork directive is set', async () => {
    await startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, 'Hello');

    const threadStartRequest = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'thread/start');
    expect(threadStartRequest).toBeUndefined();
  });

  it('does not include unstable path or history params in thread/fork', async () => {
    await startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, 'Hello');

    const forkRequest = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'thread/fork');
    expect(forkRequest).toBeDefined();
    expect(forkRequest!.params).not.toHaveProperty('path');
    expect(forkRequest!.params).not.toHaveProperty('history');
  });

  it('sets adapterSessionId after fork startup', async () => {
    const result = await startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, 'Hello');

    expect(result.adapterSessionId).toBe('thread-123');
  });

  it('sets adapterSessionId from thread/fork response before thread/started notification', async () => {
    mockThreadLifecycleResponses(ctx, 'thread-from-fork-response');

    const result = await startConnectorWithoutThreadStartedNotification(ctx);

    expect(result.adapterSessionId).toBe('thread-from-fork-response');
    expect(ctx.mockJsonRpcClient.sentRequests).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({ threadId: 'thread-from-fork-response' }),
      }),
    );
  });

  it('omits cwd from thread/fork when targetWorkingDirectory is not set', async () => {
    cleanupConnectorTestContext(ctx);
    const forkWithoutCwd: NativeForkDirective = {
      sourceSessionId: 'makaio-session-abc',
      sourceAdapterSessionId: 'source-thread',
    };
    ctx = await createConnectorTestContext({ nativeFork: forkWithoutCwd });

    await startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, 'Hello');

    const forkRequest = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'thread/fork');
    expect(forkRequest).toBeDefined();
    expect(forkRequest!.params).not.toHaveProperty('cwd');
  });

  it('nativeFork takes precedence over resumeAdapterSessionId', async () => {
    cleanupConnectorTestContext(ctx);
    ctx = await createConnectorTestContext({ nativeFork, resumeAdapterSessionId: 'some-resume-id' });

    await startConnectorAndEmitThreadStarted(ctx.connector, ctx.mockJsonRpcClient, 'Hello');

    expect(ctx.mockJsonRpcClient.sentRequests).toContainEqual(expect.objectContaining({ method: 'thread/fork' }));
    const resumeRequest = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'thread/resume');
    expect(resumeRequest).toBeUndefined();
  });

  it('rejects mid-history native forks before sending thread/fork', async () => {
    cleanupConnectorTestContext(ctx);
    ctx = await createConnectorTestContext({
      nativeFork: {
        ...nativeFork,
        forkPointMessageId: 'message-checkpoint',
      },
    });

    await expect(startConnectorWithoutThreadStartedNotification(ctx)).rejects.toThrow(
      'Codex app-server native fork only supports tip forks',
    );
    const forkRequest = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'thread/fork');
    expect(forkRequest).toBeUndefined();
  });
});

describe('CodexAppServerConnector - useNativeResume: false suppresses thread/resume', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext({ resumeAdapterSessionId: 'source-thread' });
    mockThreadLifecycleResponses(ctx, 'thread-123');
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
    vi.restoreAllMocks();
  });

  it('sends thread/start instead of thread/resume when useNativeResume is false', async () => {
    await withStartupTimeout(
      ctx.connector.start(
        { role: 'user', message: 'Hello', blocks: [{ type: 'text', content: 'Hello' }] },
        { useNativeResume: false },
      ),
      'connector.start timed out',
    );

    expect(ctx.mockJsonRpcClient.sentRequests).toContainEqual(expect.objectContaining({ method: 'thread/start' }));
    const resumeRequest = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'thread/resume');
    expect(resumeRequest).toBeUndefined();
  });

  it('sends thread/resume when useNativeResume is not set (resumeAdapterSessionId honoured by default)', async () => {
    await withStartupTimeout(
      ctx.connector.start({ role: 'user', message: 'Hello', blocks: [{ type: 'text', content: 'Hello' }] }),
      'connector.start timed out',
    );

    expect(ctx.mockJsonRpcClient.sentRequests).toContainEqual(
      expect.objectContaining({
        method: 'thread/resume',
        params: expect.objectContaining({ threadId: 'source-thread' }),
      }),
    );
    const startRequest = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'thread/start');
    expect(startRequest).toBeUndefined();
  });

  it('reports a pending provider-session move while the resume target is armed and unconfirmed', async () => {
    // Before dispatch: an armed target that a suppressed resume would abandon.
    // The executor reads this hook pre-dispatch to announce the movement, so
    // the session row stops advertising the doomed thread before thread/start.
    expect(ctx.connector.movesProviderSessionOnSuppressedResume()).toBe(true);

    await withStartupTimeout(
      ctx.connector.start(
        { role: 'user', message: 'Hello', blocks: [{ type: 'text', content: 'Hello' }] },
        { useNativeResume: false },
      ),
      'connector.start timed out',
    );

    // After the fresh thread exists the provider has committed an identity —
    // nothing is pending anymore.
    expect(ctx.connector.movesProviderSessionOnSuppressedResume()).toBe(false);
  });

  it('reports no pending move without an armed resume target', async () => {
    const freshCtx = await createConnectorTestContext({});
    try {
      mockThreadLifecycleResponses(freshCtx, 'thread-456');
      expect(freshCtx.connector.movesProviderSessionOnSuppressedResume()).toBe(false);
    } finally {
      cleanupConnectorTestContext(freshCtx);
    }
  });
});
