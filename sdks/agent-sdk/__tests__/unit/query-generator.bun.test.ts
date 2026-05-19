import { afterEach, describe, expect, it, mock } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, McpSubjects } from '@makaio/contracts';
import type { AgentStarted } from '@makaio/contracts';
import { createQueryGenerator } from '../../src/shared/query-generator.js';
import type { ResolvedQueryConfig } from '../../src/shared/options.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-test-1';
const AGENT_ID = 'agent-test-1';

/** Minimal resolved config required by createQueryGenerator. */
const FAKE_CONFIG: ResolvedQueryConfig = {
  parsedModel: { kind: 'bare', model: 'sonnet' },
  rawModel: 'sonnet',
  cwd: '/tmp',
  tools: [],
  persistSession: false,
  ephemeral: true,
};

/** Shared base fields present on every agent event. */
const BASE_FIELDS = {
  agentId: AGENT_ID,
  adapterId: 'adapter-1',
  adapterName: 'anthropic-sdk',
  adapterSessionId: 'as-1',
  sessionId: SESSION_ID,
  messageId: 'msg-1',
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createQueryGenerator', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  it('returns an object with AsyncGenerator protocol and control methods', () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });

    cleanups.push(() => query.close());

    expect(typeof query.next).toBe('function');
    expect(typeof query.return).toBe('function');
    expect(typeof query.throw).toBe('function');
    expect(typeof query[Symbol.asyncIterator]).toBe('function');
    expect(typeof query.interrupt).toBe('function');
    expect(typeof query.setModel).toBe('function');
    expect(typeof query.setMaxThinkingTokens).toBe('function');
    expect(typeof query.setMcpServers).toBe('function');
    expect(typeof query.supportedModels).toBe('function');
    expect(typeof query.supportedCommands).toBe('function');
    expect(typeof query.mcpServerStatus).toBe('function');
    expect(typeof query.accountInfo).toBe('function');
    expect(typeof query.close).toBe('function');
  });

  it('mcpServerStatus() resolves configured servers for the query session', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    let capturedSessionId: string | undefined;
    const unsubscribe = MakaioBus.on(McpSubjects.session.resolve, (ctx) => {
      capturedSessionId = ctx.payload.sessionId;
      ctx.setResult({
        sessionId: SESSION_ID,
        projectId: null,
        profileId: null,
        servers: [
          {
            name: 'local',
            transport: { type: 'stdio', command: 'mcp-local' },
            exposureMode: 'direct',
          },
        ],
        directTools: [],
        discoverableTools: [],
      });
    });
    cleanups.push(unsubscribe);

    await expect(query.mcpServerStatus()).resolves.toEqual([{ name: 'local', status: 'configured' }]);
    expect(capturedSessionId).toBe(SESSION_ID);
  });

  it('accountInfo() uses started adapter identity when available', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    await expect(query.accountInfo()).resolves.toEqual({ provider: 'unknown' });
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    await expect(query.accountInfo()).resolves.toEqual({ provider: 'anthropic-sdk' });
  });

  it('setMcpServers() delegates to the wired replacement handler with agent identity', async () => {
    const calls: unknown[] = [];
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
      onSetMcpServers: async (identity, servers) => {
        calls.push({ identity, servers });
        return { added: ['local'], removed: [], errors: {} };
      },
    });
    cleanups.push(() => query.close());

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    await expect(
      query.setMcpServers({
        local: { type: 'http', url: 'https://mcp.example.test/mcp' },
      }),
    ).resolves.toEqual({ added: ['local'], removed: [], errors: {} });

    expect(calls).toEqual([
      {
        identity: {
          agentId: AGENT_ID,
          adapterId: 'adapter-1',
          adapterName: 'anthropic-sdk',
          adapterSessionId: 'as-1',
        },
        servers: {
          local: { type: 'http', url: 'https://mcp.example.test/mcp' },
        },
      },
    ]);
  });

  it('yields SDKSystemMessage on agent.started event', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const nextPromise = query.next();
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'claude-sonnet',
      cwd: '/home',
    } satisfies AgentStarted);
    const result = await nextPromise;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet',
      cwd: '/home',
      session_id: SESSION_ID,
    });
  });

  it('yields SDKAssistantMessage on agent.message_delta event', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const nextPromise = query.next();
    await MakaioBus.emit(AgentSubjects.message_delta, { ...BASE_FIELDS, text: 'Hello world' });
    const result = await nextPromise;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      },
      session_id: SESSION_ID,
    });
  });

  it('yields SDKResultMessage on agent.complete event', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const nextPromise = query.next();
    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_FIELDS,
      message: 'Done.',
      outcome: 'completed',
    });
    const result = await nextPromise;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      session_id: SESSION_ID,
    });
  });

  it('completes the generator after agent.complete event', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    // First pull: await the result message.
    const firstPromise = query.next();
    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_FIELDS,
      message: 'Done.',
      outcome: 'completed',
    });
    const first = await firstPromise;
    expect(first.done).toBe(false);

    // Second pull: generator should be exhausted.
    const second = await query.next();
    expect(second.done).toBe(true);
    expect(second.value).toBeUndefined();
  });

  it('does not yield events for a different sessionId', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const nextPromise = query.next();

    // Emit for a different session — must be ignored by the filter.
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      sessionId: 'other-session',
      model: 'wrong-model',
      cwd: '/',
    } satisfies AgentStarted);

    // Now emit for the correct session.
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'target-model',
      cwd: '/',
    } satisfies AgentStarted);
    const result = await nextPromise;

    expect(result.value).toMatchObject({ model: 'target-model' });
  });

  it('close() stops the generator and unsubscribes handlers', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });

    query.close();

    const result = await query.next();
    expect(result.done).toBe(true);
  });

  it('yields multiple events in order', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    // Emit three events before pulling any.
    await MakaioBus.emit(AgentSubjects.started, { ...BASE_FIELDS, model: 'sonnet', cwd: '/tmp' });
    await MakaioBus.emit(AgentSubjects.message_delta, { ...BASE_FIELDS, text: 'chunk1' });
    await MakaioBus.emit(AgentSubjects.complete, { ...BASE_FIELDS, message: 'done', outcome: 'completed' });

    const first = await query.next();
    const second = await query.next();
    const third = await query.next();

    expect(first.value).toMatchObject({ type: 'system', subtype: 'init' });
    expect(second.value).toMatchObject({ type: 'assistant' });
    expect(third.value).toMatchObject({ type: 'result' });
  });

  it('setModel() sends the full adapter identity captured from agent.started', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    let captured: unknown;
    const unsubscribe = MakaioBus.on(AgentSubjects.model.change, (ctx) => {
      captured = ctx.payload;
      ctx.setResult({
        success: true,
        model: 'opus',
        swapped: true,
      });
    });
    cleanups.push(unsubscribe);

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    await query.setModel('opus');

    expect(captured).toMatchObject({
      agentId: AGENT_ID,
      adapterId: 'adapter-1',
      adapterName: 'anthropic-sdk',
      adapterSessionId: 'as-1',
      newModel: 'opus',
      turnActiveBehavior: 'stageForNextTurn',
    });
  });

  it('falls back to the initial agentId when agent.started reports a blank agentId', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    let captured: unknown;
    const unsubscribe = MakaioBus.on(AgentSubjects.model.change, (ctx) => {
      captured = ctx.payload;
      ctx.setResult({
        success: true,
        model: 'opus',
        swapped: true,
      });
    });
    cleanups.push(unsubscribe);

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      agentId: '   ',
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    await query.setModel('opus');

    expect(captured).toMatchObject({ agentId: AGENT_ID });
  });

  it('interrupt() sends the full adapter identity captured from agent.started', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    let captured: unknown;
    const unsubscribe = MakaioBus.on(AgentSubjects.interrupt, (ctx) => {
      captured = ctx.payload;
      ctx.setResult({ success: true });
    });
    cleanups.push(unsubscribe);

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    await query.interrupt();

    expect(captured).toMatchObject({
      agentId: AGENT_ID,
      adapterId: 'adapter-1',
      adapterName: 'anthropic-sdk',
      adapterSessionId: 'as-1',
    });
  });

  it('interrupt() rejects when the interrupt subject reports failure', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const unsubscribe = MakaioBus.on(AgentSubjects.interrupt, (ctx) => {
      ctx.setResult({ success: false, reason: 'not active' });
    });
    cleanups.push(unsubscribe);

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    await expect(query.interrupt()).rejects.toThrow('Failed to interrupt query: not active');
  });

  it('setModel() rejects when the model.change subject reports failure', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const unsubscribe = MakaioBus.on(AgentSubjects.model.change, (ctx) => {
      ctx.setResult({ success: false, reason: 'provider_mismatch' });
    });
    cleanups.push(unsubscribe);

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    await expect(query.setModel('opus')).rejects.toThrow('Failed to change model: provider_mismatch');
  });

  it('Symbol.asyncIterator returns the generator itself', () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    expect(query[Symbol.asyncIterator]()).toBe(query);
  });

  // ---------------------------------------------------------------------------
  // C4: FIFO queue for pending pulls
  // ---------------------------------------------------------------------------

  it('delivers messages to multiple concurrent next() calls in FIFO order', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    // Park two pulls before any events arrive.
    const pull1 = query.next();
    const pull2 = query.next();

    // Emit two events — the first should resolve pull1, the second pull2.
    await MakaioBus.emit(AgentSubjects.message_delta, { ...BASE_FIELDS, text: 'first' });
    await MakaioBus.emit(AgentSubjects.message_delta, { ...BASE_FIELDS, text: 'second' });

    const result1 = await pull1;
    const result2 = await pull2;

    expect(result1.value).toMatchObject({ message: { content: [{ text: 'first' }] } });
    expect(result2.value).toMatchObject({ message: { content: [{ text: 'second' }] } });
  });

  it('resolves all parked pulls as done when agent.complete fires', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    // Park two pulls — neither has a queued message yet.
    // The first will get the result message; the second will get done.
    const pull1 = query.next();
    const pull2 = query.next();

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_FIELDS,
      message: 'finished',
      outcome: 'completed',
    });

    const r1 = await pull1;
    const r2 = await pull2;

    expect(r1.done).toBe(false);
    expect(r1.value).toMatchObject({ type: 'result' });
    expect(r2.done).toBe(true);
    expect(r2.value).toBeUndefined();
  });

  it('resolves all parked pulls as done when close() is called', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });

    const pull1 = query.next();
    const pull2 = query.next();

    query.close();

    const r1 = await pull1;
    const r2 = await pull2;

    expect(r1.done).toBe(true);
    expect(r2.done).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // C6: onClose callback
  // ---------------------------------------------------------------------------

  it('calls onClose before unsubscribing when close() is invoked', async () => {
    const onClose = mock();

    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
      onClose,
    });

    query.close();

    expect(onClose).toHaveBeenCalledOnce();
    // Emitting after close should produce no message (confirms unsubscribe happened).
    await MakaioBus.emit(AgentSubjects.message_delta, { ...BASE_FIELDS, text: 'after-close' });
    const result = await query.next();
    expect(result.done).toBe(true);
  });

  it('calls onClose exactly once even if close() is called multiple times', () => {
    const onClose = mock();

    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
      onClose,
    });

    query.close();
    query.close();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when return() is used to close the generator', async () => {
    const onClose = mock();

    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
      onClose,
    });
    cleanups.push(() => query.close());

    await query.return();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when throw() is used to terminate the generator', async () => {
    const onClose = mock();

    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
      onClose,
    });

    await expect(query.throw(new Error('abort'))).rejects.toThrow('abort');

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when agent.complete naturally finishes the generator', async () => {
    const onClose = mock();

    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
      onClose,
    });
    cleanups.push(() => query.close());

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_FIELDS,
      message: 'Done.',
      outcome: 'completed',
    });
    await query.next();

    expect(onClose).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // I1: New bus event subscriptions
  // ---------------------------------------------------------------------------

  it('yields SDKAssistantMessage on agent.message event', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const pull = query.next();
    await MakaioBus.emit(AgentSubjects.message, { ...BASE_FIELDS, content: 'complete text' });
    const result = await pull;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'complete text' }] },
    });
  });

  it('yields SDKAssistantMessage on agent.reasoning event', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const pull = query.next();
    await MakaioBus.emit(AgentSubjects.reasoning, { ...BASE_FIELDS, content: 'full reasoning' });
    const result = await pull;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'full reasoning' }] },
    });
  });

  it('yields SDKAssistantMessage with tool_result on agent.tool.completed event', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const pull = query.next();
    await MakaioBus.emit(AgentSubjects.tool.completed, {
      ...BASE_FIELDS,
      toolName: 'read_file',
      toolCallId: 'tc-1',
      result: 'file contents',
      success: true,
    });
    const result = await pull;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_result', content: 'file contents', id: 'tc-1' }],
      },
    });
  });

  it('yields SDKAssistantMessage on agent.step.started event', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const pull = query.next();
    await MakaioBus.emit(AgentSubjects.step.started, {
      ...BASE_FIELDS,
      stepType: 'text',
      blockIndex: 0,
    });
    const result = await pull;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({ type: 'assistant' });
  });

  it('yields SDKAssistantMessage on agent.step.finished event', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    const pull = query.next();
    await MakaioBus.emit(AgentSubjects.step.finished, {
      ...BASE_FIELDS,
      stepType: 'text',
      blockIndex: 0,
      content: { type: 'text', content: 'done' },
    });
    const result = await pull;

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({ type: 'assistant' });
  });

  // ---------------------------------------------------------------------------
  // I4: Defer setModel until agentId known
  // ---------------------------------------------------------------------------

  it('setModel() rejects before agent.started fires', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => query.close());

    await expect(query.setModel('claude-opus')).rejects.toThrow('Cannot change model before agent has started');
  });

  // ---------------------------------------------------------------------------
  // I9: throwFn — no-error path resolves as done
  // ---------------------------------------------------------------------------

  it('throw() with no argument resolves as done rather than rejecting', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });

    const result = await query.throw(undefined);

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('throw() with an error value rejects with that error', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });

    await expect(query.throw(new Error('thrown error'))).rejects.toThrow('thrown error');
  });

  it('throw() calls cleanup so subsequent next() returns done', async () => {
    const query = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });

    await query.throw(undefined).catch(() => undefined);

    const result = await query.next();
    expect(result.done).toBe(true);
  });
});
