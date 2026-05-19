/**
 * Unit tests for core query() and startup() in query.ts.
 *
 * The BusClient connection is mocked to use the shared MakaioBus instance so
 * tests exercise the query-dispatch and generator-wiring logic without a live
 * WebSocket server.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { AgentComplete, AgentStarted } from '@makaio/contracts';
import type { TransportAuth } from '@makaio/bus-transport-websocket';
import { waitFor } from '@makaio/test-utils';
import type { SDKUserMessage } from '../../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Module-level mock state
// ---------------------------------------------------------------------------

const ensureConnectionMock = mock(() => Promise.resolve(MakaioBus));
const closeConnectionMock = mock(() => undefined);

mock.module('../../../src/core/connection.js', () => ({
  ensureConnection: ensureConnectionMock,
  closeConnection: closeConnectionMock,
}));

// Import AFTER the mock is registered.
const { query, startup, registerCoreHooks, createSdkMcpServer } = await import('../../../src/core/query.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed session ID so the generator's filter matches test events. */
const SESSION_ID = 'core-test-session-1';
const AGENT_ID = 'core-agent-1';
const MSG_ID = 'msg-core-1';

const BASE_AGENT_FIELDS = {
  agentId: AGENT_ID,
  adapterId: 'adapter-1',
  adapterName: 'anthropic-sdk',
  adapterSessionId: 'as-1',
  sessionId: SESSION_ID,
  messageId: MSG_ID,
} as const;

const closeWhenReady = (value: unknown, cleanups: Array<() => void>): void => {
  if (value instanceof Promise) {
    void value
      .then((resolved: unknown) => {
        if (typeof (resolved as { close?: unknown }).close === 'function') {
          (resolved as { close: () => void }).close();
        }
      })
      .catch(() => undefined);
  } else if (typeof (value as { close?: unknown }).close === 'function') {
    cleanups.push(() => (value as { close: () => void }).close());
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startup()', () => {
  beforeEach(() => {
    ensureConnectionMock.mockClear();
  });

  it('resolves without error', async () => {
    await expect(startup()).resolves.toBeUndefined();
  });

  it('is idempotent — multiple calls resolve without error', async () => {
    await expect(Promise.all([startup(), startup(), startup()])).resolves.toBeDefined();
  });

  it('passes websocket options through to ensureConnection', async () => {
    const websocketAuth: TransportAuth = {
      authenticateClient: async () => {},
      authenticateServer: async () => {},
      handleAuthMessage: () => false,
      cleanupSocket: () => {},
      cleanup: () => {},
    };

    await startup({ options: { websocketUrl: 'ws://localhost:9999/bus', websocketAuth } });

    expect(ensureConnectionMock).toHaveBeenCalledWith({
      websocketUrl: 'ws://localhost:9999/bus',
      websocketAuth,
    });
  });
});

describe('query()', () => {
  const cleanups: Array<() => void> = [];
  let sendMessagePayloads: unknown[] = [];

  beforeEach(() => {
    sendMessagePayloads = [];
    // Register a sendMessage handler so bus.request resolves synchronously.
    const unsub = MakaioBus.on(SessionSubjects.sendMessage, (ctx) => {
      sendMessagePayloads.push(ctx.payload);
      ctx.setResult({
        messageId: MSG_ID,
        turnId: 'turn-1',
        sessionId: SESSION_ID,
      });
    });
    cleanups.push(unsub);
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  it('returns a MakaioQuery with AsyncGenerator protocol synchronously', () => {
    const gen: unknown = query({ prompt: 'Hello', options: { model: 'sonnet', sessionId: SESSION_ID } });
    closeWhenReady(gen, cleanups);

    expect(gen).not.toBeInstanceOf(Promise);
    expect(typeof (gen as { next?: unknown }).next).toBe('function');
    expect(typeof (gen as { return?: unknown }).return).toBe('function');
    expect(typeof (gen as { throw?: unknown }).throw).toBe('function');
    expect(typeof (gen as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]).toBe('function');
    expect(typeof (gen as { close?: unknown }).close).toBe('function');
  });

  it('forwards SDK query options that have session/agent contracts', async () => {
    const gen = query({
      prompt: 'Hello',
      options: {
        model: 'sonnet',
        sessionId: SESSION_ID,
        cwd: '/tmp/project',
        systemPrompt: 'Be concise',
        allowedTools: ['Read'],
        disallowedTools: ['Write'],
        effort: 'high',
        env: { FOO: 'bar' },
        outputFormat: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } } } },
        mcpServers: {
          local: { command: 'mcp-local', args: ['--debug'] },
        },
      },
    });
    closeWhenReady(gen, cleanups);

    await waitFor(() => expect(sendMessagePayloads).toHaveLength(1));

    expect(sendMessagePayloads[0]).toMatchObject({
      sessionId: SESSION_ID,
      message: 'Hello',
      responseSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      agent: {
        kind: 'canonical-model',
        model: 'sonnet',
        cwd: '/tmp/project',
        systemPrompt: 'Be concise',
        allowedTools: ['Read'],
        disallowedTools: ['Write'],
        reasoningEffort: 'high',
        env: { FOO: 'bar' },
        mcpSessionContext: {
          servers: [
            {
              name: 'local',
              transport: { type: 'stdio', command: 'mcp-local', args: ['--debug'] },
              exposureMode: 'direct',
            },
          ],
        },
      },
    });
  });

  it('converts SDK MCP server instances to HTTP transports before dispatch', async () => {
    const gen = query({
      prompt: 'Hello',
      options: {
        model: 'sonnet',
        sessionId: SESSION_ID,
        mcpServers: {
          local: createSdkMcpServer({ name: 'local' }),
        },
      },
    });
    closeWhenReady(gen, cleanups);

    await waitFor(() => expect(sendMessagePayloads).toHaveLength(1));

    expect(sendMessagePayloads[0]).toMatchObject({
      agent: {
        mcpSessionContext: {
          servers: [
            {
              name: 'local',
              transport: {
                type: 'http',
                url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
              },
              exposureMode: 'direct',
            },
          ],
        },
      },
    });
  });

  it('dispatches async iterable follow-up messages to the same session', async () => {
    async function* prompt(): AsyncIterable<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: 'First' }, parent_tool_use_id: null };
      yield { type: 'user', message: { role: 'user', content: 'Second' }, parent_tool_use_id: null };
    }

    const gen = query({ prompt: prompt(), options: { model: 'sonnet', sessionId: SESSION_ID } });
    closeWhenReady(gen, cleanups);

    await waitFor(() => expect(sendMessagePayloads).toHaveLength(1));
    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_AGENT_FIELDS,
      message: 'First done.',
      outcome: 'completed',
    } satisfies AgentComplete);
    await waitFor(() => expect(sendMessagePayloads).toHaveLength(2));

    expect(sendMessagePayloads.map((payload) => (payload as { message: string }).message)).toEqual(['First', 'Second']);
    expect(sendMessagePayloads.map((payload) => (payload as { sessionId: string }).sessionId)).toEqual([
      SESSION_ID,
      SESSION_ID,
    ]);
  });

  it('honors maxTurns for async iterable prompts', async () => {
    async function* prompt(): AsyncIterable<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: 'First' }, parent_tool_use_id: null };
      yield { type: 'user', message: { role: 'user', content: 'Second' }, parent_tool_use_id: null };
    }

    const gen = query({ prompt: prompt(), options: { model: 'sonnet', sessionId: SESSION_ID, maxTurns: 1 } });
    cleanups.push(() => gen.close());

    await waitFor(() => expect(sendMessagePayloads).toHaveLength(1));
    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_AGENT_FIELDS,
      message: 'First done.',
      outcome: 'completed',
    } satisfies AgentComplete);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessagePayloads).toHaveLength(1);
  });

  it('closes the SDK session when abortController aborts', async () => {
    const abortController = new AbortController();
    const closedEvents: Array<{ sessionId: string; reason?: string }> = [];
    cleanups.push(
      MakaioBus.on(SessionSubjects.closed, (ctx) => {
        closedEvents.push(ctx.payload);
      }),
    );

    const gen = query({ prompt: 'Hello', options: { model: 'sonnet', sessionId: SESSION_ID, abortController } });
    cleanups.push(() => gen.close());

    await waitFor(() => expect(sendMessagePayloads).toHaveLength(1));
    const next = gen.next();
    abortController.abort();

    await expect(next).resolves.toEqual({ value: undefined, done: true });
    expect(closedEvents).toEqual([{ sessionId: SESSION_ID, reason: 'aborted' }]);
  });

  it('yields SDKSystemMessage when agent.started fires for the session', async () => {
    const gen = await query({ prompt: 'Ping', options: { model: 'sonnet', sessionId: SESSION_ID } });
    cleanups.push(() => gen.close());

    await waitFor(() => expect(sendMessagePayloads).toHaveLength(1));
    const nextPromise = gen.next();
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_AGENT_FIELDS,
      model: 'claude-sonnet-4',
      cwd: '/tmp',
    } satisfies AgentStarted);
    const result = await nextPromise;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({ type: 'system', subtype: 'init', model: 'claude-sonnet-4' });
  });

  it('completes the generator after agent.complete fires', async () => {
    const gen = await query({ prompt: 'Ping', options: { model: 'sonnet', sessionId: SESSION_ID } });
    cleanups.push(() => gen.close());

    await waitFor(() => expect(sendMessagePayloads).toHaveLength(1));
    const firstPromise = gen.next();
    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_AGENT_FIELDS,
      message: 'All done.',
      outcome: 'completed',
    } satisfies AgentComplete);
    const first = await firstPromise;
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: 'result', subtype: 'success' });

    const second = await gen.next();
    expect(second.done).toBe(true);
  });

  it('close() terminates the generator', async () => {
    const gen = await query({ prompt: 'Ping', options: { model: 'sonnet', sessionId: SESSION_ID } });

    gen.close();

    const result = await gen.next();
    expect(result.done).toBe(true);
  });

  it('setMcpServers() prepares SDK MCP servers and requests staged replacement', async () => {
    const gen = await query({ prompt: 'Ping', options: { model: 'sonnet', sessionId: SESSION_ID } });
    cleanups.push(() => gen.close());

    const payloads: unknown[] = [];
    cleanups.push(
      MakaioBus.on(AgentSubjects.mcp.servers.set, (ctx) => {
        payloads.push(ctx.payload);
        ctx.setResult({ success: true, swapped: false, staged: true });
      }),
    );
    await waitFor(() => expect(sendMessagePayloads).toHaveLength(1));
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_AGENT_FIELDS,
      model: 'claude-sonnet-4',
      cwd: '/tmp',
    } satisfies AgentStarted);

    await expect(
      gen.setMcpServers({
        local: createSdkMcpServer({ name: 'local' }),
      }),
    ).resolves.toEqual({ added: ['local'], removed: [], errors: {} });

    expect(payloads[0]).toMatchObject({
      agentId: AGENT_ID,
      turnActiveBehavior: 'stageForNextTurn',
      mcpSessionContext: {
        sessionId: SESSION_ID,
        servers: [
          {
            name: 'local',
            transport: {
              type: 'http',
              url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
            },
            exposureMode: 'direct',
          },
        ],
      },
    });
  });

  it('interrupt() rejects before agent.started identifies the agent', async () => {
    const gen = await query({ prompt: 'Ping', options: { model: 'sonnet', sessionId: SESSION_ID } });
    cleanups.push(() => gen.close());

    await expect(gen.interrupt()).rejects.toThrow('Cannot interrupt before agent has started');
  });

  it('ignores agent events for a different session', async () => {
    const gen = await query({ prompt: 'Ping', options: { model: 'sonnet', sessionId: SESSION_ID } });
    cleanups.push(() => gen.close());

    await waitFor(() => expect(sendMessagePayloads).toHaveLength(1));
    const nextPromise = gen.next();

    // Emit for a different session — must be ignored.
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_AGENT_FIELDS,
      sessionId: 'other-session',
      model: 'wrong-model',
      cwd: '/',
    });

    // Emit for the correct session.
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_AGENT_FIELDS,
      model: 'correct-model',
      cwd: '/',
    } satisfies AgentStarted);
    const result = await nextPromise;

    expect(result.value).toMatchObject({ model: 'correct-model' });
  });
});

describe('registerCoreHooks()', () => {
  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('returns a cleanup function', async () => {
    const cleanup = await registerCoreHooks('some-session', {
      SessionStart: () => {},
    });

    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('cleanup unsubscribes without error', async () => {
    const cleanup = await registerCoreHooks('test-session', {
      PreToolUse: () => {},
      PostToolUse: () => {},
    });

    expect(() => cleanup()).not.toThrow();
  });
});
