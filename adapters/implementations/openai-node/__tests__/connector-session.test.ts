import os from 'node:os';
import fs from 'node:fs';
import OpenAI from 'openai';
import type { Message } from '@makaio/contracts/shared';
import type { AgentToolApproveResponse } from '@makaio/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnceAbortError } from '@makaio/bus-core';
import { MessageHandle, normalizeMessageInput } from '@makaio/ai-adapters-core';
import { OpenAINodeConnector } from '../src/connector.js';
import * as streamBridge from '../src/stream-bridge.js';
import {
  OpenAINodeConnectorNamespace,
  OpenAINodeConnectorSubjects,
  type OpenAINodeConnectorBus,
  type MessageCompleteEvent,
  type SdkEvent,
} from '../src/namespaces/index.js';
import { OpenAIConnectorSession } from '../src/session.js';
import type { OpenAISessionConfig } from '../src/types/index.js';

const originalOpenAiApiKey = process.env['OPENAI_API_KEY'];

afterEach(() => {
  if (originalOpenAiApiKey === undefined) {
    delete process.env['OPENAI_API_KEY'];
  } else {
    process.env['OPENAI_API_KEY'] = originalOpenAiApiKey;
  }
});

/**
 * Create a connector session with shared defaults for session-focused tests.
 * @param bus - Scoped connector bus used by the session.
 * @param overrides - Per-test config fields that differ from the defaults.
 * @returns A configured OpenAI connector session.
 */
function createSession(
  bus: OpenAINodeConnectorBus,
  overrides: Partial<OpenAISessionConfig> = {},
): OpenAIConnectorSession {
  return new OpenAIConnectorSession({
    bus,
    adapterId: 'adapter-test',
    adapterName: 'openai-node',
    agentId: 'agent-test',
    sessionId: 'session-test',
    cwd: os.tmpdir(),
    model: 'gpt-4o-mini',
    env: {},
    client: new OpenAI({ apiKey: 'test-api-key' }),
    openAITools: [],
    supportsResponseFormatWithTools: true,
    supportsStructuredOutputStrict: true,
    emitSdkEvent: async () => {},
    handleError: () => {},
    requestToolApproval: async () => ({ action: 'allow' }) as AgentToolApproveResponse,
    ...overrides,
  });
}

describe('openai-node connector/session', () => {
  it('does not mutate connector cwd when changeCwdInPlace runs before session init', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const initialCwd = os.tmpdir();
    const connector = new OpenAINodeConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'openai-node',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: initialCwd,
      env: {},
      providerConfig: {},
    });

    const updatedCwd = process.cwd();
    await connector.changeCwdInPlace(updatedCwd);

    // Mutation contract: connector fields are updated by AIAgent caller after success.
    expect(connector.cwd).toBe(initialCwd);
  });

  it('does not mutate connector model when changeModelInPlace runs before session init', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const initialModel = 'gpt-4o-mini';
    const connector = new OpenAINodeConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'openai-node',
      agentId: 'agent-test',
      model: initialModel,
      cwd: os.tmpdir(),
      env: {},
      providerConfig: {},
    });

    const updatedModel = 'gpt-4o';
    await connector.changeModelInPlace(updatedModel);

    // Mutation contract: connector fields are updated by AIAgent caller after success.
    expect(connector.model).toBe(initialModel);
  });

  it('aborts message_complete wait when signal is already aborted', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const session = createSession(bus);

    const createMessageCompletePromise = Reflect.get(session, 'createMessageCompletePromise') as
      | ((abortSignal: AbortSignal, adapterSessionId: string) => Promise<{ payload: SdkEvent }>)
      | undefined;
    const controller = new AbortController();
    controller.abort();

    expect(createMessageCompletePromise).toBeTypeOf('function');
    await expect(
      createMessageCompletePromise?.call(session, controller.signal, 'adapter-session-test'),
    ).rejects.toThrow(OnceAbortError);
  });

  it('filters message_complete wait by event type and connector identity', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const session = createSession(bus);

    const onceSpy = vi.spyOn(bus, 'once');
    const createMessageCompletePromise = Reflect.get(session, 'createMessageCompletePromise') as
      | ((abortSignal: AbortSignal, adapterSessionId: string) => Promise<{ payload: SdkEvent }>)
      | undefined;

    expect(createMessageCompletePromise).toBeTypeOf('function');

    const controller = new AbortController();
    const promise = createMessageCompletePromise?.call(session, controller.signal, 'adapter-session-test');
    controller.abort();
    await expect(promise).rejects.toThrow();

    expect(onceSpy).toHaveBeenCalledTimes(1);
    expect(onceSpy).toHaveBeenCalledWith(
      OpenAINodeConnectorSubjects.sdk.event,
      expect.objectContaining({
        filter: {
          'event.eventType': 'message_complete',
          agentId: 'agent-test',
          adapterId: 'adapter-test',
          adapterSessionId: 'adapter-session-test',
        },
      }),
    );
  });

  it('syncs session cwd without mutating connector cwd directly', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const tempRoot = fs.mkdtempSync(`${os.tmpdir()}/openai-node-connector-session-`);
    const initialCwd = `${tempRoot}/initial`;
    const updatedCwd = `${tempRoot}/updated`;
    fs.mkdirSync(initialCwd, { recursive: true });
    fs.mkdirSync(updatedCwd, { recursive: true });
    const connector = new OpenAINodeConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'openai-node',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: initialCwd,
      env: {},
      providerConfig: {},
    });
    const session = createSession(bus, { cwd: initialCwd });

    Reflect.set(connector, 'session', session);
    await connector.changeCwdInPlace(updatedCwd);

    expect(connector.cwd).toBe(initialCwd);
    expect(Reflect.get(session, 'currentCwd')).toBe(updatedCwd);
  });

  it('captures systemPrompt from initialize options', async () => {
    process.env['OPENAI_API_KEY'] = 'test-api-key';
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const connector = new OpenAINodeConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'openai-node',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: os.tmpdir(),
      env: {},
      providerConfig: {},
    });

    await connector.initialize({ systemPrompt: 'You are a test assistant.' });

    const systemPrompt = Reflect.get(connector, 'systemPrompt');
    expect(systemPrompt).toBe('You are a test assistant.');
  });

  it('captures empty-string systemPrompt without treating it as unset', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const connector = new OpenAINodeConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'openai-node',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: os.tmpdir(),
      env: {},
      providerConfig: {},
    });

    const captureSystemPrompt = Reflect.get(connector, 'captureSystemPrompt') as
      | ((prompt: string | undefined) => void)
      | undefined;
    expect(captureSystemPrompt).toBeTypeOf('function');

    captureSystemPrompt?.call(connector, '');
    expect(Reflect.get(connector, 'systemPrompt')).toBe('');
  });

  it('captures systemPrompt from start options', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const connector = new OpenAINodeConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'openai-node',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: os.tmpdir(),
      env: {},
      providerConfig: {},
    });

    const systemPromptBefore = Reflect.get(connector, 'systemPrompt');
    expect(systemPromptBefore).toBeUndefined();

    // Note: This will fail to send a message because we don't have a real API key,
    // but we can verify systemPrompt was captured before the error
    await connector
      .start(normalizeMessageInput('Hello'), { systemPrompt: { mode: 'append', content: 'Additional context.' } })
      .catch(() => {
        // Ignore network errors
      });

    const systemPrompt = Reflect.get(connector, 'systemPrompt');
    expect(systemPrompt).toEqual({ mode: 'append', content: 'Additional context.' });
  });

  it('prepends system message to messages array when systemPrompt is set', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const session = createSession(bus, { systemPrompt: 'You are a helpful assistant.' });

    const buildMessages = Reflect.get(session, 'buildMessages') as
      | ((handle: MessageHandle, mergedContent?: string[]) => void)
      | undefined;

    expect(buildMessages).toBeTypeOf('function');

    // Create a message handle
    const handle = new MessageHandle(crypto.randomUUID(), normalizeMessageInput('Hello'), 'enqueue');

    buildMessages?.call(session, handle);

    const messages = Reflect.get(session, 'messages') as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('prepends empty-string system message when explicitly configured', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const session = createSession(bus, { systemPrompt: '' });

    const buildMessages = Reflect.get(session, 'buildMessages') as
      | ((handle: MessageHandle, mergedContent?: string[]) => void)
      | undefined;
    expect(buildMessages).toBeTypeOf('function');

    const handle = new MessageHandle(crypto.randomUUID(), normalizeMessageInput('Hello'), 'enqueue');
    buildMessages?.call(session, handle);

    const messages = Reflect.get(session, 'messages') as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: '' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('moves history system message to index 0, updates it, and preserves non-system order', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const session = createSession(bus, { systemPrompt: 'Configured system prompt' });

    const buildMessages = Reflect.get(session, 'buildMessages') as
      | ((handle: MessageHandle, mergedContent?: string[]) => void)
      | undefined;
    expect(buildMessages).toBeTypeOf('function');

    const history: Message[] = [
      { role: 'user', blocks: { type: 'text', content: 'Earlier user' } },
      { role: 'system', blocks: { type: 'text', content: 'History system' } },
      { role: 'assistant', blocks: { type: 'text', content: 'Earlier assistant' } },
    ];
    const handle = new MessageHandle(crypto.randomUUID(), normalizeMessageInput('Current user'), 'enqueue', history);

    buildMessages?.call(session, handle);

    const messages = Reflect.get(session, 'messages') as Array<{ role: string; content: string | null }>;
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'system', content: 'Configured system prompt' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Earlier user' });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Earlier assistant' });
    expect(messages[3]).toEqual({ role: 'user', content: 'Current user' });
  });

  it('updates existing system message at index 0 without adding a duplicate', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const session = createSession(bus, { systemPrompt: 'Configured system prompt' });

    const buildMessages = Reflect.get(session, 'buildMessages') as
      | ((handle: MessageHandle, mergedContent?: string[]) => void)
      | undefined;
    expect(buildMessages).toBeTypeOf('function');

    const history: Message[] = [
      { role: 'system', blocks: { type: 'text', content: 'Old system' } },
      { role: 'user', blocks: { type: 'text', content: 'Earlier user' } },
    ];
    const handle = new MessageHandle(crypto.randomUUID(), normalizeMessageInput('Current user'), 'enqueue', history);

    buildMessages?.call(session, handle);

    const messages = Reflect.get(session, 'messages') as Array<{ role: string; content: string | null }>;
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'system', content: 'Configured system prompt' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Earlier user' });
    expect(messages[2]).toEqual({ role: 'user', content: 'Current user' });
  });

  it('does not feed reasoning-only completion back as assistant content', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const session = createSession(bus);

    const handle = new MessageHandle(crypto.randomUUID(), normalizeMessageInput('Hello'), 'enqueue');
    const buildMessages = Reflect.get(session, 'buildMessages') as ((handle: MessageHandle) => void) | undefined;
    const createTurn = Reflect.get(session, 'createTurn') as ((handle: MessageHandle) => unknown) | undefined;
    const applyMessageComplete = Reflect.get(session, 'applyMessageComplete') as
      | ((
          result: MessageCompleteEvent,
          handle: MessageHandle,
          toolCallIteration: number,
          turn: unknown,
        ) => Promise<void>)
      | undefined;
    expect(buildMessages).toBeTypeOf('function');
    expect(createTurn).toBeTypeOf('function');
    expect(applyMessageComplete).toBeTypeOf('function');

    buildMessages?.call(session, handle);
    const turn = createTurn?.call(session, handle);
    Reflect.set(session, 'currentTurn', turn);
    await applyMessageComplete?.call(
      session,
      {
        eventType: 'message_complete',
        content: null,
        reasoning: 'This is private chain-of-thought',
        finish_reason: 'stop',
      },
      handle,
      0,
      turn,
    );

    const messages = Reflect.get(session, 'messages') as Array<{ role: string; content: string | null }>;
    expect(messages[1]).toEqual({ role: 'assistant', content: null });
    expect(Reflect.get(session, 'lastAssistantMessage')).toBe('');
  });

  it('accepts block-only user input when content contains non-text parts', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const session = createSession(bus);

    const buildMessages = Reflect.get(session, 'buildMessages') as ((handle: MessageHandle) => void) | undefined;
    expect(buildMessages).toBeTypeOf('function');

    const handle = new MessageHandle(
      crypto.randomUUID(),
      normalizeMessageInput({
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'diagram.png',
            filePath: '/tmp/diagram.png',
            source: { type: 'base64', data: 'Zm9v', mimeType: 'image/png' },
            attachmentType: 'file',
          },
        ],
      }),
      'enqueue',
    );

    expect(() => buildMessages?.call(session, handle)).not.toThrow();

    const messages = Reflect.get(session, 'messages') as Array<{ role: string; content: unknown }>;
    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'image_url' }],
    });
  });

  it('passes the real agentId (not adapterId) to stream metadata', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const createSpy = vi.fn().mockResolvedValue({});
    const processStreamSpy = vi.spyOn(streamBridge, 'processStream').mockResolvedValue(undefined);

    // @ts-expect-error -- partial platform shim; OpenAI has private fields and many more members not needed here
    const mockClient: OpenAI = { chat: { completions: { create: createSpy } } };

    const session = createSession(bus, {
      agentId: 'agent-real',
      client: mockClient,
    });

    const executeApiCall = Reflect.get(session, 'executeApiCall') as
      | ((
          turn: { markStepStarted: () => Promise<void>; markStepFinished: () => Promise<void> },
          signal: AbortSignal,
          adapterSessionId: string,
        ) => Promise<void>)
      | undefined;
    expect(executeApiCall).toBeTypeOf('function');

    try {
      await executeApiCall?.call(
        session,
        {
          markStepStarted: async () => {},
          markStepFinished: async () => {},
        },
        new AbortController().signal,
        'adapter-session-1',
      );

      expect(createSpy).toHaveBeenCalledOnce();
      expect(processStreamSpy).toHaveBeenCalledOnce();
      const metadata = processStreamSpy.mock.calls[0]?.[1];
      expect(metadata).toMatchObject({
        agentId: 'agent-real',
        adapterId: 'adapter-test',
      });
    } finally {
      processStreamSpy.mockRestore();
    }
  });
});
