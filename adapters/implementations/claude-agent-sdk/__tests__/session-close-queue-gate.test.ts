import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue } from '@makaio/ai-adapters-core';

const queryHarness = vi.hoisted(() => {
  const sdkBase = (sessionId: string) => ({
    uuid: crypto.randomUUID(),
    session_id: sessionId,
    agentId: 'agent-test',
  });
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0 },
    service_tier: 'standard',
  };
  const query = vi.fn(
    ({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<unknown>;
      options: {
        sessionId?: string;
        resume?: string;
      };
    }) => {
      const effectiveSessionId = options.resume ?? options.sessionId ?? crypto.randomUUID();
      return {
        interrupt: vi.fn(async () => undefined),
        close: vi.fn(() => undefined),
        setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
        setMaxThinkingTokens: vi.fn(async () => undefined),
        async *[Symbol.asyncIterator]() {
          for await (const _message of prompt) {
            yield {
              ...sdkBase(effectiveSessionId),
              type: 'system',
              subtype: 'init',
              apiKeySource: 'user',
              cwd: os.tmpdir(),
              tools: [],
              mcp_servers: [],
              model: 'claude-sonnet-4-20250514',
              permissionMode: 'default',
              slash_commands: [],
              output_style: 'default',
            };
            yield {
              ...sdkBase(effectiveSessionId),
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: 'session completed',
              duration_ms: 1,
              duration_api_ms: 1,
              num_turns: 1,
              total_cost_usd: 0,
              usage,
              modelUsage: {},
              permission_denials: [],
            };
          }
        },
      };
    },
  );

  return {
    query,
    reset: () => {
      query.mockClear();
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  Options: class Options {},
  query: queryHarness.query,
}));

import { ClaudeCodeConnectorNamespace } from '../src/namespace/index.js';
import { ClaudeConnectorSession } from '../src/session.js';

function createMessageHandle(
  messageId = 'message-1',
  deliveryMode: 'enqueue' | 'replace' | 'immediate' = 'enqueue',
): MessageHandle {
  return new MessageHandle(
    messageId,
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'hello' }],
      message: 'hello',
    },
    deliveryMode,
  );
}

describe('ClaudeConnectorSession shutdown vs queue processing', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    queryHarness.reset();
  });

  it('rejects queued handles after close() begins instead of starting new turns', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      // Complete a first turn so the session is in a valid state
      const firstQueue = new UserMessageQueue();
      const firstHandle = createMessageHandle('message-first');
      firstQueue.enqueue(firstHandle);
      await session.processQueue(firstQueue);
      await expect(firstHandle.waitForCompletion(1_000)).resolves.toMatchObject({ outcome: 'completed' });

      const initialQueryCount = queryHarness.query.mock.calls.length;

      // Close the session — this sets the closing flag
      await session.close();

      // Now try to process a queued message — it should be rejected, not start a new query
      const queue = new UserMessageQueue();
      const queuedHandle = createMessageHandle('message-queued-after-close');
      queue.enqueue(queuedHandle);

      await session.processQueue(queue);

      // The queued handle must complete with an error, not hang
      const result = await queuedHandle.waitForCompletion(1_000);
      expect(result.outcome).toBe('error');

      // No new query should have been created
      expect(queryHarness.query.mock.calls.length).toBe(initialQueryCount);
    } finally {
      // close() already called above; safe to call again (idempotent drain)
      await session.close();
    }
  });

  it('rejects queued follow-ups during close() drain window', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      // Start a first turn
      const firstQueue = new UserMessageQueue();
      const activeHandle = createMessageHandle('message-active');
      firstQueue.enqueue(activeHandle);
      await session.processQueue(firstQueue);
      await expect(activeHandle.waitForCompletion(1_000)).resolves.toMatchObject({ outcome: 'completed' });

      // Enqueue a follow-up BEFORE closing so it's sitting in the queue
      const followUpQueue = new UserMessageQueue();
      const followUpHandle = createMessageHandle('message-follow-up');
      followUpQueue.enqueue(followUpHandle);

      // Close the session — sets closing flag before drain
      await session.close();

      // processQueue should reject the follow-up
      await session.processQueue(followUpQueue);

      const result = await followUpHandle.waitForCompletion(1_000);
      expect(result.outcome).toBe('error');
      expect((result as { error: Error }).error.message).toContain('Session closed');
    } finally {
      await session.close();
    }
  });
});
