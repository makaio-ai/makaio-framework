import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandle, type NormalizedMessageInput } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import { TerminalManager } from '@makaio/ai-adapters-acp-client';
import type { AcpConnectionHandle } from '@makaio/ai-adapters-acp-client';
import { QwenAcpNamespace, QwenAcpSubjects } from '../namespaces/index.js';
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

interface ToolApprovalRequester {
  requestToolApprovalWithHandling: (subject: unknown, payload: unknown) => Promise<{ action: 'allow' | 'deny' }>;
}

/**
 * Create a connector configured for unit tests.
 */
async function makeConnector() {
  const bus = await QwenAcpNamespace.scopedBus();
  return new QwenAcpConnector({
    bus,
    adapterId: 'adapter-1',
    adapterName: 'qwen-acp',
    agentId: 'agent-1',
    sessionId: 'session-1',
    model: 'qwen3-coder',
    cwd: tmpdir(),
    env: {},
    allowedDirectories: ['/workspace/project'],
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
    await connector.initialize({ systemPrompt: 'Follow the repository policies strictly.' });

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
    const connector = await makeConnector();
    allowToolApproval(connector);
    const requestSpy = vi.spyOn(MakaioBus, 'request').mockResolvedValue({
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
      ToolSubjects.execute,
      expect.objectContaining({
        toolName: 'read_file',
        input: { path: 'notes.md', offset: undefined, limit: undefined },
      }),
    );
  });

  it('routes ACP write_text_file through tool.execute with createDirectories enabled', async () => {
    const connector = await makeConnector();
    allowToolApproval(connector);
    const requestSpy = vi.spyOn(MakaioBus, 'request').mockResolvedValue({
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
    const messageHandle = await connector.sendMessage(TEST_MESSAGE);

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
    const secondInitialize = connector.initialize({ systemPrompt: 'Apply this prompt after startup.' });

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

    await expect(connector.initialize({ systemPrompt: 'Fail once, then recover.' })).rejects.toThrow(
      'session creation failed',
    );

    expect(firstHandle.kill).toHaveBeenCalledTimes(1);
    const firstCallOptions = mockCreateAcpConnection.mock.calls[0][1] as { env: Record<string, string> };
    const promptFile = firstCallOptions.env['QWEN_SYSTEM_MD'];
    expect(promptFile).toBeTruthy();
    await expect(access(promptFile, fsConstants.F_OK)).rejects.toThrow();

    await connector.initialize({ systemPrompt: 'Fail once, then recover.' });

    expect(mockCreateAcpConnection).toHaveBeenCalledTimes(2);
    await expect(connector.getAdapterSessionId()).resolves.toBe('session-recovered');
  });

  it('returns to idle and marks handle error when connection.prompt rejects', async () => {
    const handle = makeAcpHandle('session-error');
    handle.connection.prompt = vi.fn().mockRejectedValueOnce(new Error('model timeout'));
    mockCreateAcpConnection.mockResolvedValueOnce(handle);

    const connector = await makeConnector();
    const messageHandle = await connector.sendMessage(TEST_MESSAGE);

    const result = await messageHandle.waitForCompletion();
    expect(result).toMatchObject({ outcome: 'error' });

    // The finally block must have run: connector returns to idle so complete() resolves promptly.
    await expect(connector.complete()).resolves.toBeDefined();
  });

  it('reopens a text step after a tool step completes', async () => {
    const bus = await QwenAcpNamespace.scopedBus();
    const connector = new QwenAcpConnector({
      bus,
      adapterId: 'adapter-1',
      adapterName: 'qwen-acp',
      agentId: 'agent-1',
      sessionId: 'session-1',
      model: 'qwen3-coder',
      cwd: tmpdir(),
      env: {},
      allowedDirectories: ['/workspace/project'],
    });
    const turn = new QwenAcpTurn(
      new MessageHandle('msg-test', TEST_MESSAGE, 'enqueue'),
      bus,
      'adapter-1',
      'qwen-acp',
      'agent-1',
    );
    connector['currentTurn'] = turn;
    await turn.start();

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
    const bus = await QwenAcpNamespace.scopedBus();
    const connector = new QwenAcpConnector({
      bus,
      adapterId: 'adapter-1',
      adapterName: 'qwen-acp',
      agentId: 'agent-1',
      sessionId: 'session-1',
      model: 'qwen3-coder',
      cwd: tmpdir(),
      env: {},
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
    const bus = await QwenAcpNamespace.scopedBus();
    const connector = new QwenAcpConnector({
      bus,
      adapterId: 'adapter-1',
      adapterName: 'qwen-acp',
      agentId: 'agent-1',
      sessionId: 'session-1',
      model: 'qwen3-coder',
      cwd: tmpdir(),
      env: {},
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

    await connector['flushAccumulatedUsage'](12345);

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
    const bus = await QwenAcpNamespace.scopedBus();
    const connector = new QwenAcpConnector({
      bus,
      adapterId: 'adapter-1',
      adapterName: 'qwen-acp',
      agentId: 'agent-1',
      sessionId: 'session-1',
      model: 'qwen3-coder',
      cwd: tmpdir(),
      env: {},
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

    await connector['flushAccumulatedUsage'](99999);

    expect(usageEvents).toHaveLength(0);
  });

  it('resets the accumulator after flush so a second flush emits nothing', async () => {
    const bus = await QwenAcpNamespace.scopedBus();
    const connector = new QwenAcpConnector({
      bus,
      adapterId: 'adapter-1',
      adapterName: 'qwen-acp',
      agentId: 'agent-1',
      sessionId: 'session-1',
      model: 'qwen3-coder',
      cwd: tmpdir(),
      env: {},
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

    await connector['flushAccumulatedUsage'](1000);
    await connector['flushAccumulatedUsage'](2000);

    // Only the first flush should produce an event
    expect(usageEvents).toHaveLength(1);
  });
});
