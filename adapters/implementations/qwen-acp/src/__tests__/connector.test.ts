import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandle, type MessageResult, type NormalizedMessageInput } from '@makaio/ai-adapters-core';
import { createBusInstance, type IMakaioBus, MakaioBus } from '@makaio/bus-core';
import { ToolSubjects, type Party } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { TerminalManager } from '@makaio/ai-adapters-acp-client';
import type { AcpConnectionHandle } from '@makaio/ai-adapters-acp-client';
import { QwenAcpNamespace, QwenAcpSubjects, type QwenAcpBus } from '../namespaces/index.js';
import { QwenAcpConnector } from '../connector.js';
import { QwenAcpTurn } from '../turn.js';

const mockCreateAcpConnection = vi.hoisted(() => vi.fn());

vi.mock('@makaio/ai-adapters-acp-client', async () => {
  const actual = await vi.importActual<typeof import('@makaio/ai-adapters-acp-client')>(
    '@makaio/ai-adapters-acp-client',
  );
  return {
    ...actual,
    createAcpConnection: mockCreateAcpConnection,
  };
});

/**
 * Create a mock ACP connection handle with a fixed session id.
 * @param sessionId - Session id returned by newSession()
 * @returns ACP handle used by connector initialization
 */
function makeAcpHandle(sessionId: string): AcpConnectionHandle {
  return {
    // @ts-expect-error -- partial platform shim; ClientSideConnection has private fields and many more members not needed here
    connection: {
      initialize: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn().mockResolvedValue({ sessionId }),
      cancel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue(undefined),
    },
    kill: vi.fn(),
    exited: Promise.resolve(0),
  };
}

const TEST_MESSAGE: NormalizedMessageInput = {
  role: 'user',
  message: 'Hello',
  blocks: [{ type: 'text', content: 'Hello' }],
};

const TEST_CALL = createTestCall();
const TURN_PRINCIPAL: Party = { kind: 'acme.person', id: 'person-turn' };

/**
 * Build a pending operation handle for a call.
 * @param call - Call context the handle serves
 * @param messageId - Message identifier of the handle
 * @returns Message handle for the call
 */
function makeHandle(call = TEST_CALL, messageId = 'msg-test'): MessageHandle {
  return new MessageHandle(call, messageId, TEST_MESSAGE, 'enqueue');
}

const NATIVE_AUTH = { processEnv: {}, connectorDeliveries: [], configInheritance: 'auth-only' as const };

interface ToolApprovalRequester {
  requestToolApprovalWithHandling: (subject: unknown, payload: unknown) => Promise<{ action: 'allow' | 'deny' }>;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

/**
 * Create a connector configured for unit tests.
 * @param options - Optional connector overrides.
 */
async function makeConnector(options: { globalBus?: IMakaioBus } = {}) {
  const bus = await QwenAcpNamespace.scopedBus(options.globalBus ?? MakaioBus);
  return new QwenAcpConnector({
    bus,
    adapterId: 'adapter-1',
    adapterName: 'qwen-acp',
    agentId: 'agent-1',
    sessionId: 'session-1',
    model: 'qwen3-coder',
    cwd: tmpdir(),
    env: {},
    adapterAuth: NATIVE_AUTH,
    allowedDirectories: ['/workspace/project'],
    globalBus: options.globalBus ?? MakaioBus,
  });
}

function allowToolApproval(connector: QwenAcpConnector) {
  const prototype = Object.getPrototypeOf(connector) as ToolApprovalRequester;
  return vi.spyOn(prototype, 'requestToolApprovalWithHandling').mockResolvedValue({
    action: 'allow',
  });
}

describe('QwenAcpConnector', () => {
  beforeEach(() => {
    mockCreateAcpConnection.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rebuilds an idle ACP session when a system prompt arrives after idle initialization', async () => {
    const firstHandle = makeAcpHandle('session-initial');
    const secondHandle = makeAcpHandle('session-with-prompt');
    mockCreateAcpConnection.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle);

    const connector = await makeConnector();

    await connector.initialize();
    await connector.initialize({ call: TEST_CALL, systemPrompt: 'Follow the repository policies strictly.' });

    expect(mockCreateAcpConnection).toHaveBeenCalledTimes(2);
    expect(firstHandle.kill).toHaveBeenCalledTimes(1);
    await expect(connector.getAdapterSessionId()).resolves.toBe('session-with-prompt');

    const secondCallOptions = mockCreateAcpConnection.mock.calls[1][1] as { env: Record<string, string> };
    expect(secondCallOptions.env['QWEN_SYSTEM_MD']).toBeTruthy();
    const promptFile = secondCallOptions.env['QWEN_SYSTEM_MD'];
    expect(await readFile(promptFile, 'utf-8')).toBe('Follow the repository policies strictly.');

    await connector.close();
    await expect(access(promptFile, fsConstants.F_OK)).rejects.toThrow();
  });

  it('routes ACP read_text_file through tool.execute with execution context', async () => {
    const hostBus = createBusInstance();
    const connector = await makeConnector({ globalBus: hostBus });
    allowToolApproval(connector);
    connector['pendingMessageHandle'] = makeHandle();
    const requestSpy = vi.spyOn(hostBus, 'request').mockResolvedValue({
      success: true,
      data: { content: 'file contents', path: '/workspace/project/notes.md', size: 13, truncated: false },
    });

    const response = await connector['onReadTextFile']({
      sessionId: 'adapter-session',
      path: join('notes.md'),
      line: 4,
      limit: 10,
    });

    expect(response).toEqual({ content: 'file contents' });
    expect(requestSpy).toHaveBeenCalledWith(
      TEST_CALL,
      ToolSubjects.execute,
      expect.objectContaining({
        toolName: 'read_file',
        input: { path: 'notes.md', offset: 4, limit: 10 },
        adapterId: 'adapter-1',
        adapterName: 'qwen-acp',
        contextOverrides: expect.objectContaining({
          cwd: tmpdir(),
          sessionId: 'session-1',
          agentId: 'agent-1',
          constraints: { allowedDirectories: ['/workspace/project'] },
        }),
      }),
    );
  });

  it('normalizes ACP null line and limit fields before tool execution', async () => {
    const connector = await makeConnector();
    allowToolApproval(connector);
    connector['pendingMessageHandle'] = makeHandle();
    const requestSpy = vi.spyOn(MakaioBus, 'request').mockResolvedValue({
      success: true,
      data: { content: 'file contents', path: '/workspace/project/notes.md', size: 13, truncated: false },
    });

    const response = await connector['onReadTextFile']({
      sessionId: 'adapter-session',
      path: 'notes.md',
      line: null,
      limit: null,
    });

    expect(response).toEqual({ content: 'file contents' });
    expect(requestSpy).toHaveBeenCalledWith(
      TEST_CALL,
      ToolSubjects.execute,
      expect.objectContaining({
        toolName: 'read_file',
        input: { path: 'notes.md', offset: undefined, limit: undefined },
      }),
    );
  });

  it('routes ACP write_text_file through tool.execute with createDirectories enabled', async () => {
    const hostBus = createBusInstance();
    const connector = await makeConnector({ globalBus: hostBus });
    allowToolApproval(connector);
    connector['pendingMessageHandle'] = makeHandle();
    const requestSpy = vi.spyOn(hostBus, 'request').mockResolvedValue({
      success: true,
      data: { path: '/workspace/project/out.txt', bytesWritten: 7, created: true },
    });

    const response = await connector['onWriteTextFile']({
      sessionId: 'adapter-session',
      path: 'out.txt',
      content: 'payload',
    });

    expect(response).toEqual({});
    expect(requestSpy).toHaveBeenCalledWith(
      TEST_CALL,
      ToolSubjects.execute,
      expect.objectContaining({
        toolName: 'write_file',
        input: { path: 'out.txt', content: 'payload', createDirectories: true },
        adapterId: 'adapter-1',
        adapterName: 'qwen-acp',
        contextOverrides: expect.objectContaining({
          cwd: tmpdir(),
          sessionId: 'session-1',
          agentId: 'agent-1',
          constraints: { allowedDirectories: ['/workspace/project'] },
        }),
      }),
    );
  });

  it('serializes concurrent initialization to a single ACP connection', async () => {
    const handle = makeAcpHandle('session-shared');
    let resolveHandle: ((value: AcpConnectionHandle) => void) | undefined;
    mockCreateAcpConnection.mockImplementationOnce(
      () =>
        new Promise<AcpConnectionHandle>((resolve) => {
          resolveHandle = resolve;
        }),
    );

    const connector = await makeConnector();
    const firstInitialize = connector.initialize();
    const secondInitialize = connector.initialize();

    // Yield enough microtasks for the async credential resolution step and the
    // optional client.resolveBinary requestOptional call in initializeConnection()
    // to complete and createAcpConnection() to be reached before asserting call count.
    await vi.waitFor(() => expect(resolveHandle).toBeDefined());
    expect(mockCreateAcpConnection).toHaveBeenCalledTimes(1);
    resolveHandle!(handle);

    await Promise.all([firstInitialize, secondInitialize]);
    await expect(connector.getAdapterSessionId()).resolves.toBe('session-shared');
  });

  it('initializes the ACP session before sendMessage on a fresh connector', async () => {
    const handle = makeAcpHandle('session-send');
    mockCreateAcpConnection.mockResolvedValueOnce(handle);

    const connector = await makeConnector();
    const messageHandle = await connector.sendMessage(TEST_MESSAGE, { call: TEST_CALL });

    await expect(connector.getAdapterSessionId()).resolves.toBe('session-send');
    expect(messageHandle.adapterSessionId).toBe('session-send');
    expect(mockCreateAcpConnection).toHaveBeenCalledTimes(1);
  });

  it('rejects getAdapterSessionId immediately after abort before initialization completes', async () => {
    const connector = await makeConnector();
    const releaseAllSpy = vi.spyOn(TerminalManager.prototype, 'releaseAll');

    connector.abort();

    expect(releaseAllSpy).toHaveBeenCalledTimes(1);
    await expect(connector.getAdapterSessionId()).rejects.toThrow(
      'Connector terminated before session ID was established',
    );
  });

  it('rebuilds after a late system prompt arrives during in-flight initialization', async () => {
    const firstHandle = makeAcpHandle('session-initial');
    const secondHandle = makeAcpHandle('session-with-prompt');
    let resolveHandle: ((value: AcpConnectionHandle) => void) | undefined;
    mockCreateAcpConnection.mockImplementationOnce(
      () =>
        new Promise<AcpConnectionHandle>((resolve) => {
          resolveHandle = resolve;
        }),
    );
    mockCreateAcpConnection.mockResolvedValueOnce(secondHandle);

    const connector = await makeConnector();
    const firstInitialize = connector.initialize();
    const secondInitialize = connector.initialize({
      call: TEST_CALL,
      systemPrompt: 'Apply this prompt after startup.',
    });

    // Yield enough microtasks for credential resolution and the optional
    // client.resolveBinary requestOptional to complete so that createAcpConnection()
    // is reached and resolveHandle is set before we invoke it.
    await vi.waitFor(() => expect(resolveHandle).toBeDefined());
    resolveHandle!(firstHandle);
    await Promise.all([firstInitialize, secondInitialize]);

    expect(mockCreateAcpConnection).toHaveBeenCalledTimes(2);
    expect(firstHandle.kill).toHaveBeenCalledTimes(1);
    await expect(connector.getAdapterSessionId()).resolves.toBe('session-with-prompt');
  });

  it('rejects pending session-id waiters when initialization fails', async () => {
    const startupError = new Error('spawn failed');
    mockCreateAcpConnection.mockRejectedValueOnce(startupError);

    const connector = await makeConnector();
    const sessionIdPromise = connector.getAdapterSessionId();

    await expect(connector.initialize()).rejects.toThrow('spawn failed');
    await expect(sessionIdPromise).rejects.toThrow('spawn failed');
  });

  it('kills partial startup state and removes the prompt temp file when session creation fails', async () => {
    const firstHandle = makeAcpHandle('session-failed');
    const secondHandle = makeAcpHandle('session-recovered');
    const startupError = new Error('session creation failed');
    firstHandle.connection.newSession = vi.fn().mockRejectedValue(startupError);
    mockCreateAcpConnection.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle);

    const connector = await makeConnector();

    await expect(connector.initialize({ call: TEST_CALL, systemPrompt: 'Fail once, then recover.' })).rejects.toThrow(
      'session creation failed',
    );

    expect(firstHandle.kill).toHaveBeenCalledTimes(1);
    const firstCallOptions = mockCreateAcpConnection.mock.calls[0][1] as { env: Record<string, string> };
    const promptFile = firstCallOptions.env['QWEN_SYSTEM_MD'];
    expect(promptFile).toBeTruthy();
    await expect(access(promptFile, fsConstants.F_OK)).rejects.toThrow();

    await connector.initialize({ call: TEST_CALL, systemPrompt: 'Fail once, then recover.' });

    expect(mockCreateAcpConnection).toHaveBeenCalledTimes(2);
    await expect(connector.getAdapterSessionId()).resolves.toBe('session-recovered');
  });

  it('returns to idle and marks handle error when connection.prompt rejects', async () => {
    const handle = makeAcpHandle('session-error');
    handle.connection.prompt = vi.fn().mockRejectedValueOnce(new Error('model timeout'));
    mockCreateAcpConnection.mockResolvedValueOnce(handle);

    const connector = await makeConnector();
    const messageHandle = await connector.sendMessage(TEST_MESSAGE, { call: TEST_CALL });

    const result = await messageHandle.waitForCompletion();
    expect(result).toMatchObject({ outcome: 'error' });

    // The finally block must have run: connector returns to idle so complete() resolves promptly.
    await expect(connector.complete()).resolves.toBeDefined();
  });

  it('returns transformed final result from complete after prompt completion', async () => {
    const handle = makeAcpHandle('session-final-result');
    const promptReleased = createDeferred<void>();
    handle.connection.prompt = vi.fn().mockReturnValue(promptReleased.promise);
    mockCreateAcpConnection.mockResolvedValueOnce(handle);

    const connector = await makeConnector();

    try {
      const messageHandle = await connector.sendMessage(TEST_MESSAGE, { call: TEST_CALL });
      await vi.waitFor(() => {
        expect(handle.connection.prompt).toHaveBeenCalledTimes(1);
      });

      const finalResult: MessageResult = {
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      };
      messageHandle.addCompletionTransform(() => finalResult);
      await connector['onSessionUpdate']({
        sessionId: 'session-final-result',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'raw provider text' },
        },
      });

      promptReleased.resolve();

      await expect(messageHandle.waitForCompletion()).resolves.toEqual(finalResult);
      await expect(connector.complete()).resolves.toEqual(finalResult);
    } finally {
      await connector.close();
    }
  });

  it('starts internal retry turns while the original completion transform is waiting', async () => {
    const handle = makeAcpHandle('session-retry-interlock');
    const firstPromptReleased = createDeferred<void>();
    const retryPromptReleased = createDeferred<void>();
    handle.connection.prompt = vi
      .fn()
      .mockReturnValueOnce(firstPromptReleased.promise)
      .mockReturnValueOnce(retryPromptReleased.promise);
    mockCreateAcpConnection.mockResolvedValueOnce(handle);

    const connector = await makeConnector();

    try {
      const messageHandle = await connector.sendMessage(TEST_MESSAGE, { call: TEST_CALL });
      await vi.waitFor(() => {
        expect(handle.connection.prompt).toHaveBeenCalledTimes(1);
      });

      let retryHandle: MessageHandle | undefined;
      messageHandle.addCompletionTransform(async () => {
        retryHandle = await connector.sendMessage(TEST_MESSAGE, {
          call: TEST_CALL,
          deliveryMode: 'enqueue',
          internalRetry: true,
          messageId: 'message-structured-output-retry',
        });
        const retryResult = await retryHandle.waitForCompletion();
        return {
          outcome: 'completed',
          result: { message: retryResult.result?.message ?? '' },
        };
      });
      await connector['onSessionUpdate']({
        sessionId: 'session-retry-interlock',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'invalid json' },
        },
      });

      firstPromptReleased.resolve();

      await vi.waitFor(() => {
        expect(handle.connection.prompt).toHaveBeenCalledTimes(2);
      });
      expect(retryHandle?.messageId).toBe('message-structured-output-retry');

      await connector['onSessionUpdate']({
        sessionId: 'session-retry-interlock',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '{"ok":true}' },
        },
      });
      retryPromptReleased.resolve();

      const finalResult: MessageResult = {
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      };
      await expect(messageHandle.waitForCompletion()).resolves.toEqual(finalResult);
      await expect(connector.complete()).resolves.toEqual(finalResult);
    } finally {
      await connector.close();
    }
  });

  it('reopens a text step after a tool step completes', async () => {
    const bus = await QwenAcpNamespace.scopedBus(MakaioBus);
    const connector = new QwenAcpConnector({
      bus,
      globalBus: MakaioBus,
      adapterId: 'adapter-1',
      adapterName: 'qwen-acp',
      agentId: 'agent-1',
      sessionId: 'session-1',
      model: 'qwen3-coder',
      cwd: tmpdir(),
      env: {},
      adapterAuth: NATIVE_AUTH,
      allowedDirectories: ['/workspace/project'],
    });
    const handle = makeHandle();
    const turn = new QwenAcpTurn(handle, bus, 'adapter-1', 'qwen-acp', 'agent-1');
    connector['currentTurn'] = turn;
    connector['pendingMessageHandle'] = handle;
    await turn.start(handle.call);

    const stepStarts: string[] = [];
    bus.on(QwenAcpSubjects.turn_step_started, (ctx) => {
      stepStarts.push(ctx.payload.stepType);
    });

    await connector['onSessionUpdate']({
      sessionId: 'adapter-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    });
    await connector['onSessionUpdate']({
      sessionId: 'adapter-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'read_file',
        kind: 'read',
        rawInput: {},
      },
    });
    await connector['onSessionUpdate']({
      sessionId: 'adapter-session',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: 'done',
      },
    });
    await connector['onSessionUpdate']({
      sessionId: 'adapter-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'world' },
      },
    });

    expect(stepStarts).toEqual(['text', 'tool_use', 'text']);
  });

  it('does not emit session_update_usage during streaming chunks', async () => {
    const bus = await QwenAcpNamespace.scopedBus(MakaioBus);
    const connector = new QwenAcpConnector({
      bus,
      globalBus: MakaioBus,
      adapterId: 'adapter-1',
      adapterName: 'qwen-acp',
      agentId: 'agent-1',
      sessionId: 'session-1',
      model: 'qwen3-coder',
      cwd: tmpdir(),
      env: {},
      adapterAuth: NATIVE_AUTH,
      allowedDirectories: [],
    });
    connector['turnUsageAccumulator'] = {};

    const usageEvents: unknown[] = [];
    bus.on(QwenAcpSubjects.session_update_usage, (ctx) => {
      usageEvents.push(ctx.payload);
    });

    await connector['onSessionUpdate']({
      sessionId: 'adapter-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'part one' },
        _meta: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      },
    });
    await connector['onSessionUpdate']({
      sessionId: 'adapter-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'part two' },
        _meta: { usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 } },
      },
    });

    // No usage events should have been emitted during streaming
    expect(usageEvents).toHaveLength(0);
  });

  it('emits a single consolidated session_update_usage event on flush', async () => {
    const bus = await QwenAcpNamespace.scopedBus(MakaioBus);
    const connector = new QwenAcpConnector({
      bus,
      globalBus: MakaioBus,
      adapterId: 'adapter-1',
      adapterName: 'qwen-acp',
      agentId: 'agent-1',
      sessionId: 'session-1',
      model: 'qwen3-coder',
      cwd: tmpdir(),
      env: {},
      adapterAuth: NATIVE_AUTH,
      allowedDirectories: [],
    });
    connector['turnUsageAccumulator'] = {};

    const usageEvents: unknown[] = [];
    bus.on(QwenAcpSubjects.session_update_usage, (ctx) => {
      usageEvents.push(ctx.payload);
    });

    await connector['onSessionUpdate']({
      sessionId: 'adapter-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'first' },
        _meta: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      },
    });
    await connector['onSessionUpdate']({
      sessionId: 'adapter-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'second' },
        _meta: { usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, thoughtTokens: 8 } },
      },
    });

    await connector['flushAccumulatedUsage'](TEST_CALL, 12345);

    // Exactly one consolidated event, using the last-seen value for each field
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      thoughtTokens: 8,
      timestamp: 12345,
    });
  });

  it('does not emit usage when no usage data was seen in any chunk', async () => {
    const bus = await QwenAcpNamespace.scopedBus(MakaioBus);
    const connector = new QwenAcpConnector({
      bus,
      globalBus: MakaioBus,
      adapterId: 'adapter-1',
      adapterName: 'qwen-acp',
      agentId: 'agent-1',
      sessionId: 'session-1',
      model: 'qwen3-coder',
      cwd: tmpdir(),
      env: {},
      adapterAuth: NATIVE_AUTH,
      allowedDirectories: [],
    });
    connector['turnUsageAccumulator'] = {};

    const usageEvents: unknown[] = [];
    bus.on(QwenAcpSubjects.session_update_usage, (ctx) => {
      usageEvents.push(ctx.payload);
    });

    await connector['onSessionUpdate']({
      sessionId: 'adapter-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'no usage here' },
      },
    });

    await connector['flushAccumulatedUsage'](TEST_CALL, 99999);

    expect(usageEvents).toHaveLength(0);
  });

  it('resets the accumulator after flush so a second flush emits nothing', async () => {
    const bus = await QwenAcpNamespace.scopedBus(MakaioBus);
    const connector = new QwenAcpConnector({
      bus,
      globalBus: MakaioBus,
      adapterId: 'adapter-1',
      adapterName: 'qwen-acp',
      agentId: 'agent-1',
      sessionId: 'session-1',
      model: 'qwen3-coder',
      cwd: tmpdir(),
      env: {},
      adapterAuth: NATIVE_AUTH,
      allowedDirectories: [],
    });
    connector['turnUsageAccumulator'] = {};

    const usageEvents: unknown[] = [];
    bus.on(QwenAcpSubjects.session_update_usage, (ctx) => {
      usageEvents.push(ctx.payload);
    });

    await connector['onSessionUpdate']({
      sessionId: 'adapter-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'data' },
        _meta: { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
      },
    });

    await connector['flushAccumulatedUsage'](TEST_CALL, 1000);
    await connector['flushAccumulatedUsage'](TEST_CALL, 2000);

    // Only the first flush should produce an event
    expect(usageEvents).toHaveLength(1);
  });

  describe('call attribution of connector callbacks', () => {
    /**
     * Collect the principal each delivery of a subject was sent under.
     * @param bus - Scoped bus to listen on
     * @param subject - Subject to record
     * @returns Recorded deliveries (principal and payload)
     */
    function recordPrincipals(
      bus: QwenAcpBus,
      subject: typeof QwenAcpSubjects.session_update_message_chunk,
    ): Array<{ principal: Party; payload: unknown }> {
      const seen: Array<{ principal: Party; payload: unknown }> = [];
      bus.on(subject, (ctx) => {
        seen.push({ principal: ctx.call.principal, payload: ctx.payload });
      });
      return seen;
    }

    it('R1: usage flush, chunk emissions and turn_text_completed go out under the turn call', async () => {
      const handle = makeAcpHandle('session-r1');
      const promptReleased = createDeferred<void>();
      handle.connection.prompt = vi.fn().mockReturnValue(promptReleased.promise);
      mockCreateAcpConnection.mockResolvedValueOnce(handle);
      const connector = await makeConnector();
      const bus = connector['config'].bus;
      const chunks = recordPrincipals(bus, QwenAcpSubjects.session_update_message_chunk);
      const thoughts: Party[] = [];
      bus.on(QwenAcpSubjects.session_update_thought_chunk, (ctx) => void thoughts.push(ctx.call.principal));
      const texts: Party[] = [];
      bus.on(QwenAcpSubjects.turn_text_completed, (ctx) => void texts.push(ctx.call.principal));
      const usages: Party[] = [];
      bus.on(QwenAcpSubjects.session_update_usage, (ctx) => void usages.push(ctx.call.principal));

      try {
        const messageHandle = await connector.sendMessage(TEST_MESSAGE, {
          call: createTestCall({ principal: TURN_PRINCIPAL }),
        });
        await vi.waitFor(() => expect(handle.connection.prompt).toHaveBeenCalledTimes(1));
        await connector['onSessionUpdate']({
          sessionId: 'session-r1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'answer' },
            _meta: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
          },
        });
        await connector['onSessionUpdate']({
          sessionId: 'session-r1',
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
        });
        promptReleased.resolve();
        await messageHandle.waitForCompletion();

        expect(chunks.map((entry) => entry.principal)).toEqual([TURN_PRINCIPAL]);
        expect(thoughts).toEqual([TURN_PRINCIPAL]);
        expect(texts).toEqual([TURN_PRINCIPAL]);
        expect(usages).toEqual([TURN_PRINCIPAL]);
      } finally {
        await connector.close();
      }
    });

    it('R2: a notification without a pending handle is emitted observed, not under a turn call', async () => {
      const connector = await makeConnector();
      const chunks = recordPrincipals(connector['config'].bus, QwenAcpSubjects.session_update_message_chunk);

      await connector['onSessionUpdate']({
        sessionId: 'adapter-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'orphan' } },
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.principal).not.toEqual(TURN_PRINCIPAL);
      expect(chunks[0]?.payload).toMatchObject({ delta: 'orphan' });
    });

    it('attributes a tool update to the handle its tool call was announced under', async () => {
      const connector = await makeConnector();
      const bus = connector['config'].bus;
      const updates: Array<{ principal: Party; messageId: string }> = [];
      bus.on(QwenAcpSubjects.session_update_tool_call_update, (ctx) => {
        updates.push({ principal: ctx.call.principal, messageId: ctx.payload.messageId });
      });
      connector['pendingMessageHandle'] = makeHandle(createTestCall({ principal: TURN_PRINCIPAL }), 'msg-announce');
      await connector['onSessionUpdate']({
        sessionId: 'adapter-session',
        update: { sessionUpdate: 'tool_call', toolCallId: 'tool-9', title: 'read_file', kind: 'read', rawInput: {} },
      });
      // A later turn becomes pending; the update still belongs to the announcing operation.
      connector['pendingMessageHandle'] = makeHandle(createTestCall(), 'msg-later');

      await connector['onSessionUpdate']({
        sessionId: 'adapter-session',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-9', status: 'in_progress' },
      });

      expect(updates).toEqual([{ principal: TURN_PRINCIPAL, messageId: 'msg-announce' }]);
    });

    it('does not emit or attribute a tool update without a mapped handle and logs the dropped tool id', async () => {
      const connector = await makeConnector();
      const bus = connector['config'].bus;
      const emitted: unknown[] = [];
      bus.on(QwenAcpSubjects.session_update_tool_call_update, (ctx) => void emitted.push(ctx.payload));
      bus.on(QwenAcpSubjects.session_update_tool_call, (ctx) => void emitted.push(ctx.payload));
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      vi.stubEnv('MAKAIO_DEBUG', 'true');

      try {
        await connector['onSessionUpdate']({
          sessionId: 'adapter-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-orphan-call',
            title: 't',
            kind: 'read',
            rawInput: {},
          },
        });
        await connector['onSessionUpdate']({
          sessionId: 'adapter-session',
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-orphan-update', status: 'completed' },
        });
      } finally {
        vi.unstubAllEnvs();
      }

      expect(emitted).toEqual([]);
      const logged = debugSpy.mock.calls.map((args) => String(args[0]));
      expect(logged.some((line) => line.includes('tool-orphan-call'))).toBe(true);
      expect(logged.some((line) => line.includes('tool-orphan-update'))).toBe(true);
    });
  });
});
