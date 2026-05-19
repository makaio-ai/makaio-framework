/**
 * Unit tests for runtime query() and startup() in query.ts.
 *
 * The embedded runtime boot is mocked so these tests exercise only the
 * query-dispatch and generator-wiring logic.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { AgentComplete, AgentStarted } from '@makaio/contracts';
import { waitFor } from '@makaio/test-utils';

// ---------------------------------------------------------------------------
// Mock ensureRuntime so tests use the shared MakaioBus instead of booting
// ---------------------------------------------------------------------------

const runtimeMock = {
  ensureRuntime: mock(() => Promise.resolve(MakaioBus)),
  shutdownRuntime: mock(() => Promise.resolve()),
};

mock.module('../../../src/runtime/boot.js', () => runtimeMock);

// Import AFTER the mock is registered.
const { query, startup, registerRuntimeHooks } = await import('../../../src/runtime/query.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed session ID passed via options so the generator's filter matches. */
const SESSION_ID = 'rt-test-session-1';
const AGENT_ID = 'rt-agent-1';
const MSG_ID = 'msg-rt-1';

const BASE_AGENT_FIELDS = {
  agentId: AGENT_ID,
  adapterId: 'adapter-1',
  adapterName: 'anthropic-sdk',
  adapterSessionId: 'as-1',
  sessionId: SESSION_ID,
  messageId: MSG_ID,
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startup()', () => {
  beforeEach(() => {
    runtimeMock.ensureRuntime.mockClear();
  });

  it('resolves without error', async () => {
    await expect(startup()).resolves.toBeUndefined();
  });

  it('is idempotent — multiple calls resolve without error', async () => {
    await expect(Promise.all([startup(), startup(), startup()])).resolves.toBeDefined();
  });

  it('accepts startup options without changing runtime boot identity', async () => {
    await startup({ options: { model: 'sonnet', cwd: '/tmp/project' } });

    expect(runtimeMock.ensureRuntime).toHaveBeenCalledTimes(1);
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
    if (gen instanceof Promise) {
      void gen
        .then((resolved: unknown) => {
          if (typeof (resolved as { close?: unknown }).close === 'function') {
            (resolved as { close: () => void }).close();
          }
        })
        .catch(() => undefined);
    } else if (typeof (gen as { close?: unknown }).close === 'function') {
      cleanups.push(() => (gen as { close: () => void }).close());
    }

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
      },
    });
    cleanups.push(() => gen.close());

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
      },
    });
  });

  it('yields SDKSystemMessage when agent.started fires for the session', async () => {
    // Pass sessionId so the generator subscribes with the known ID.
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

  it('setMaxThinkingTokens() maps token budgets to staged reasoning changes', async () => {
    const gen = await query({ prompt: 'Ping', options: { model: 'sonnet', sessionId: SESSION_ID } });
    cleanups.push(() => gen.close());

    const modelChangePayloads: unknown[] = [];
    cleanups.push(
      MakaioBus.on(AgentSubjects.model.change, (ctx) => {
        modelChangePayloads.push(ctx.payload);
        ctx.setResult({ success: true, swapped: false, staged: true, appliedReasoningEffort: 'high' });
      }),
    );
    await waitFor(() => expect(sendMessagePayloads).toHaveLength(1));
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_AGENT_FIELDS,
      model: 'claude-sonnet-4',
      cwd: '/tmp',
    } satisfies AgentStarted);

    await expect(gen.setMaxThinkingTokens(12_000)).resolves.toBeUndefined();
    expect(modelChangePayloads[0]).toMatchObject({
      agentId: AGENT_ID,
      reasoningEffort: 'high',
      skipWarning: true,
      turnActiveBehavior: 'stageForNextTurn',
    });
  });

  it('does not accept unsupported control methods as successful no-ops', async () => {
    const gen = await query({ prompt: 'Ping', options: { model: 'sonnet', sessionId: SESSION_ID } });
    cleanups.push(() => gen.close());

    await expect(gen.setMcpServers({})).rejects.toThrow('Cannot change MCP servers before agent has started');
  });

  it('setMcpServers() replaces dynamic MCP servers through the agent mutation subject', async () => {
    const gen = await query({ prompt: 'Ping', options: { model: 'sonnet', sessionId: SESSION_ID } });
    cleanups.push(() => gen.close());

    const mcpPayloads: unknown[] = [];
    cleanups.push(
      MakaioBus.on(AgentSubjects.mcp.servers.set, (ctx) => {
        mcpPayloads.push(ctx.payload);
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
        docs: { type: 'http', url: 'https://docs.example.test/mcp' },
      }),
    ).resolves.toEqual({ added: ['docs'], removed: [], errors: {} });
    expect(mcpPayloads[0]).toMatchObject({
      agentId: AGENT_ID,
      mcpSessionContext: {
        sessionId: SESSION_ID,
        servers: [
          {
            name: 'docs',
            transport: { type: 'http', url: 'https://docs.example.test/mcp' },
            exposureMode: 'direct',
          },
        ],
      },
      turnActiveBehavior: 'stageForNextTurn',
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

describe('registerRuntimeHooks()', () => {
  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('returns a cleanup function', async () => {
    const cleanup = await registerRuntimeHooks('some-session', {
      SessionStart: () => {},
    });

    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('cleanup unsubscribes without error', async () => {
    const cleanup = await registerRuntimeHooks('test-session', {
      PreToolUse: () => {},
      PostToolUse: () => {},
    });

    expect(() => cleanup()).not.toThrow();
  });
});
