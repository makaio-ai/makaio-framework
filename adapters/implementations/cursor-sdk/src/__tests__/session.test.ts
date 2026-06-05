import {
  MessageHandle,
  UserMessageQueue,
  type MessageResult,
  type NormalizedMessageInput,
} from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorSdkNamespace } from '../namespaces/index.js';
import type { CursorSdkProviderConfig } from '../schemas.js';
import { CursorSdkSession } from '../session.js';

interface TestRun {
  id: string;
  wait(): Promise<{ id: string; status: string; result?: string; error?: unknown }>;
  conversation(): Promise<
    Array<{
      type: string;
      turn?: { steps?: Array<{ type: string; message?: { text?: string } }> };
    }>
  >;
  cancel(): Promise<void>;
}

const sdkControls = vi.hoisted(() => ({
  failCreate: false,
  createCalls: [] as Array<Record<string, unknown>>,
  runResults: new Map<string, { id: string; status: string; result?: string; error?: unknown }>(),
  conversations: new Map<
    string,
    Array<{
      type: string;
      turn?: { steps?: Array<{ type: string; message?: { text?: string } }> };
    }>
  >(),
  deltaUpdates: new Map<string, Array<{ type: string; [key: string]: unknown }>>(),
  sendCalls: [] as Array<{ text: string; options: Record<string, unknown> }>,
  cancelledRunIds: [] as string[],
  asyncDisposeCalls: 0,
  closeCalls: 0,
  deferredSendIds: new Set<string>(),
  deferredWaitIds: new Set<string>(),
  sendResolvers: new Map<string, (run: TestRun) => void>(),
  waitResolvers: new Map<string, (result: { id: string; status: string; result?: string; error?: unknown }) => void>(),
}));

vi.mock('@cursor/sdk', () => {
  const createRun = (id: string): TestRun => ({
    id,
    wait: async () => {
      if (sdkControls.deferredWaitIds.has(id)) {
        return await new Promise<{ id: string; status: string; result?: string; error?: unknown }>((resolve) => {
          sdkControls.waitResolvers.set(id, resolve);
        });
      }
      return sdkControls.runResults.get(id) ?? { id, status: 'completed', result: 'ok' };
    },
    conversation: async () => sdkControls.conversations.get(id) ?? [],
    cancel: async () => {
      sdkControls.cancelledRunIds.push(id);
    },
  });

  return {
    Agent: {
      create: async (options: Record<string, unknown>) => {
        sdkControls.createCalls.push(options);
        if (sdkControls.failCreate) throw new Error('cursor init failed');
        return {
          send: async (text: string, options: Record<string, unknown>) => {
            const id = `run-${sdkControls.sendCalls.length + 1}`;
            sdkControls.sendCalls.push({ text, options });
            const onDelta = options['onDelta'];
            if (typeof onDelta === 'function') {
              for (const update of sdkControls.deltaUpdates.get(id) ?? []) {
                onDelta({ update });
              }
            }
            if (sdkControls.deferredSendIds.has(id)) {
              return await new Promise<TestRun>((resolve) => {
                sdkControls.sendResolvers.set(id, resolve);
              });
            }
            return createRun(id);
          },
          [Symbol.asyncDispose]: async () => {
            sdkControls.asyncDisposeCalls += 1;
          },
          close: async () => {
            sdkControls.closeCalls += 1;
          },
        };
      },
    },
  };
});

const TEST_MESSAGE: NormalizedMessageInput = {
  role: 'user',
  message: 'hello',
  blocks: [{ type: 'text', content: 'hello' }],
};

/**
 * Create a Cursor SDK session configured for unit tests.
 * @param providerConfig - Optional Cursor SDK provider configuration.
 * @returns Session instance.
 */
async function createSession(providerConfig?: CursorSdkProviderConfig): Promise<CursorSdkSession> {
  const session = new CursorSdkSession({
    bus: await CursorSdkNamespace.scopedBus(),
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'cursor-sdk',
    cwd: process.cwd(),
    model: 'composer-2',
    apiKey: 'test-key',
    providerConfig,
  });
  await session.initialize();
  return session;
}

/**
 * Create a queue with one user message handle.
 * @returns Queue and handle pair for session processing.
 */
function createQueuedMessage(): { queue: UserMessageQueue; handle: MessageHandle } {
  const queue = new UserMessageQueue();
  const handle = new MessageHandle('message-1', TEST_MESSAGE, 'enqueue');
  queue.enqueue(handle);
  return { queue, handle };
}

/**
 * Process one message through the real session queue.
 * @param session - Session under test.
 * @returns Completion result from the message handle.
 */
async function processOneMessage(session: CursorSdkSession): Promise<MessageResult> {
  const { queue, handle } = createQueuedMessage();
  await session.processQueue(queue);
  return await handle.waitForCompletion(1_000);
}

/**
 * Wait until a predicate becomes true.
 * @param predicate - Condition to wait for.
 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for test condition');
}

describe('CursorSdkSession', () => {
  beforeEach(() => {
    sdkControls.failCreate = false;
    sdkControls.createCalls.length = 0;
    sdkControls.runResults.clear();
    sdkControls.conversations.clear();
    sdkControls.deltaUpdates.clear();
    sdkControls.sendCalls.length = 0;
    sdkControls.cancelledRunIds.length = 0;
    sdkControls.asyncDisposeCalls = 0;
    sdkControls.closeCalls = 0;
    sdkControls.deferredSendIds.clear();
    sdkControls.deferredWaitIds.clear();
    sdkControls.sendResolvers.clear();
    sdkControls.waitResolvers.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps Cursor run error status to an error outcome through real queue processing', async () => {
    sdkControls.runResults.set('run-1', { id: 'run-1', status: 'error', error: { message: 'tool failed' } });
    const session = await createSession();

    try {
      const result = await processOneMessage(session);

      expect(result.outcome).toBe('error');
      expect(result.error instanceof Error ? result.error.message : result.error).toBe(
        'Cursor SDK run run-1 failed: tool failed',
      );
      await waitUntil(() => session.getCurrentTurn() === undefined);
      expect(session.getCurrentTurn()).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('applies provider mode to Cursor agent creation and sends', async () => {
    const session = await createSession({ mode: 'plan' });

    try {
      const result = await processOneMessage(session);

      expect(result.outcome).toBe('completed');
      expect(sdkControls.createCalls[0]).toMatchObject({ mode: 'plan' });
      expect(sdkControls.sendCalls[0].options).toMatchObject({ mode: 'plan' });
    } finally {
      await session.close();
    }
  });

  it('prefers terminal run result over replayed streaming deltas', async () => {
    sdkControls.deltaUpdates.set('run-1', [{ type: 'text-delta', text: '<user_query>old prompt</user_query>' }]);
    sdkControls.runResults.set('run-1', { id: 'run-1', status: 'completed', result: 'ok' });
    const session = await createSession();

    try {
      const result = await processOneMessage(session);

      expect(result).toMatchObject({
        outcome: 'completed',
        result: { message: 'ok' },
      });
    } finally {
      await session.close();
    }
  });

  it('falls back to Cursor conversation text when the terminal run result omits text', async () => {
    sdkControls.runResults.set('run-1', { id: 'run-1', status: 'completed' });
    sdkControls.conversations.set('run-1', [
      {
        type: 'agentConversationTurn',
        turn: {
          steps: [{ type: 'assistantMessage', message: { text: 'ok' } }],
        },
      },
    ]);
    const session = await createSession();

    try {
      const result = await processOneMessage(session);

      expect(result).toMatchObject({
        outcome: 'completed',
        result: { message: 'ok' },
      });
    } finally {
      await session.close();
    }
  });

  it('does not use replayed streaming deltas as semantic completion text', async () => {
    sdkControls.deltaUpdates.set('run-1', [{ type: 'text-delta', text: '<user_query>old prompt</user_query>' }]);
    sdkControls.runResults.set('run-1', { id: 'run-1', status: 'completed' });
    const session = await createSession();

    try {
      const result = await processOneMessage(session);

      expect(result).toMatchObject({ outcome: 'completed' });
      expect(result.result?.message).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('rejects immediate messages that arrive during turn-finished drain', async () => {
    const session = await createSession();
    const queue = new UserMessageQueue();
    const firstHandle = new MessageHandle('message-1', TEST_MESSAGE, 'enqueue');
    const immediateHandle = new MessageHandle('message-2', TEST_MESSAGE, 'immediate');
    queue.enqueue(firstHandle);

    const bus = await CursorSdkNamespace.scopedBus();
    const unsubscribe = bus.on(CursorSdkNamespace.subjects.turn.turn_finished, async () => {
      queue.enqueue(immediateHandle);
      await session.processQueue(queue);
    });

    try {
      await session.processQueue(queue);

      await expect(firstHandle.waitForCompletion(1_000)).resolves.toMatchObject({ outcome: 'completed' });
      await expect(immediateHandle.waitForCompletion(1_000)).resolves.toMatchObject({ outcome: 'rejected' });
      expect(sdkControls.sendCalls).toHaveLength(1);
    } finally {
      unsubscribe();
      await session.close();
    }
  });

  it('drains aborts that arrive before agent.send resolves', async () => {
    sdkControls.deferredSendIds.add('run-1');
    const session = await createSession();
    const { queue, handle } = createQueuedMessage();

    try {
      const processPromise = session.processQueue(queue);
      await processPromise;
      session.abort();
      await waitUntil(() => sdkControls.sendResolvers.has('run-1'));

      sdkControls.sendResolvers.get('run-1')?.({
        id: 'run-1',
        wait: async () => sdkControls.runResults.get('run-1') ?? { id: 'run-1', status: 'completed', result: 'ok' },
        conversation: async () => sdkControls.conversations.get('run-1') ?? [],
        cancel: async () => {
          sdkControls.cancelledRunIds.push('run-1');
        },
      });

      await expect(handle.waitForCompletion(1_000)).resolves.toMatchObject({ outcome: 'completed' });
      expect(sdkControls.cancelledRunIds).toEqual(['run-1']);
    } finally {
      await session.close();
    }
  });

  it('cancels a delayed old run without clearing the replacement run', async () => {
    sdkControls.deferredSendIds.add('run-1');
    sdkControls.deferredWaitIds.add('run-2');
    const session = await createSession();
    const queue = new UserMessageQueue();
    const firstHandle = new MessageHandle('message-1', TEST_MESSAGE, 'enqueue');
    const immediateHandle = new MessageHandle('message-2', TEST_MESSAGE, 'immediate');
    queue.enqueue(firstHandle);

    try {
      await session.processQueue(queue);
      await waitUntil(() => sdkControls.sendResolvers.has('run-1'));

      queue.enqueue(immediateHandle);
      await session.processQueue(queue);
      await waitUntil(() => sdkControls.waitResolvers.has('run-2'));

      sdkControls.sendResolvers.get('run-1')?.({
        id: 'run-1',
        wait: async () => ({ id: 'run-1', status: 'completed', result: 'stale' }),
        conversation: async () => sdkControls.conversations.get('run-1') ?? [],
        cancel: async () => {
          sdkControls.cancelledRunIds.push('run-1');
        },
      });
      await waitUntil(() => sdkControls.cancelledRunIds.includes('run-1'));

      await session.interrupt();
      expect(sdkControls.cancelledRunIds).toEqual(['run-1', 'run-2']);
      expect(firstHandle.supersededBy).toBe(immediateHandle.messageId);

      sdkControls.waitResolvers.get('run-2')?.({ id: 'run-2', status: 'cancelled' });
      await expect(immediateHandle.waitForCompletion(1_000)).resolves.toMatchObject({
        outcome: 'cancelled',
      });
    } finally {
      await session.close();
    }
  });

  it('unregisters MCP when Cursor agent creation fails after registration', async () => {
    sdkControls.failCreate = true;
    const requestOptionalSpy = vi.spyOn(MakaioBus, 'requestOptional').mockResolvedValue({
      handled: true,
      data: { port: 12_345 },
    } as never);

    const session = new CursorSdkSession({
      bus: await CursorSdkNamespace.scopedBus(),
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'cursor-sdk',
      cwd: process.cwd(),
      model: 'composer-2',
      apiKey: 'test-key',
    });

    await expect(session.initialize()).rejects.toThrow('cursor init failed');

    expect(requestOptionalSpy).toHaveBeenCalledWith(
      McpSubjects.session.unregister,
      expect.objectContaining({ adapterSessionId: expect.stringMatching(/^cursor-/) }),
    );
  });

  it('prefers async disposal when closing the real initialized Cursor agent', async () => {
    const session = await createSession();

    await session.close();

    expect(sdkControls.asyncDisposeCalls).toBe(1);
    expect(sdkControls.closeCalls).toBe(0);
  });
});
