import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue } from '@makaio/ai-adapters-core';
import type { SDKMessage } from '@makaio/client-claude-code';

/**
 * Stub SDK query whose async iterator yields messages pushed by the test harness.
 * Allows driving the system.init flow without a real Claude Agent SDK.
 */
type MessageCallback = (msg: SDKMessage) => void;

const queryHarness = vi.hoisted(() => {
  let messageCallback: MessageCallback | undefined;
  let closeCallback: (() => void) | undefined;

  const queryInstance = {
    /** Async iterator that yields messages pushed via emitMessage. */
    [Symbol.asyncIterator]() {
      const pending: SDKMessage[] = [];
      let waiting: ((value: IteratorResult<SDKMessage>) => void) | undefined;
      let done = false;

      messageCallback = (msg: SDKMessage) => {
        if (waiting) {
          const resolve = waiting;
          waiting = undefined;
          resolve({ value: msg, done: false });
        } else {
          pending.push(msg);
        }
      };

      closeCallback = () => {
        done = true;
        if (waiting) {
          const resolve = waiting;
          waiting = undefined;
          resolve({ value: undefined as unknown as SDKMessage, done: true });
        }
      };

      return {
        next(): Promise<IteratorResult<SDKMessage>> {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({
              value: undefined as unknown as SDKMessage,
              done: true,
            });
          }
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
        return(): Promise<IteratorResult<SDKMessage>> {
          done = true;
          return Promise.resolve({
            value: undefined as unknown as SDKMessage,
            done: true,
          });
        },
      };
    },
    close: vi.fn(() => {
      closeCallback?.();
    }),
    setMcpServers: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
  };

  return {
    queryFn: vi.fn(() => queryInstance),
    queryInstance,
    /**
     * Emit a message into the active consumption loop.
     * @param msg - SDK message to emit
     */
    emitMessage(msg: SDKMessage): void {
      if (!messageCallback) {
        throw new Error('Query consumption not started');
      }
      messageCallback(msg);
    },
    reset(): void {
      messageCallback = undefined;
      closeCallback = undefined;
      queryInstance.close.mockClear();
      queryInstance.setMcpServers.mockClear();
      queryInstance.interrupt.mockClear();
      this.queryFn.mockClear();
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryHarness.queryFn,
}));

import { ClaudeCodeConnectorNamespace } from '../namespace/index.js';
import { ClaudeConnectorSession } from '../session.js';
import type { ClaudeSessionConfig } from '../types/index.js';

const RESUME_TARGET = 'stored-provider-session';

/**
 * Create a message handle carrying an explicit native-resume decision.
 * @param useNativeResume - Caller decision on native resume, or undefined for legacy callers
 * @returns Message handle containing a text prompt
 */
function makeHandle(useNativeResume?: boolean): MessageHandle {
  return new MessageHandle(
    `message-${String(useNativeResume)}`,
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'hello' }],
      message: 'hello',
    },
    'enqueue',
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    useNativeResume,
  );
}

/**
 * Create an initialized SDK session whose config carries a start-time resume target.
 * @returns Session under test and its shared (mutable) config
 */
async function makeInitializedSession(): Promise<{ session: ClaudeConnectorSession; config: ClaudeSessionConfig }> {
  const config: ClaudeSessionConfig = {
    bus: await ClaudeCodeConnectorNamespace.scopedBus(),
    adapterId: 'adapter-test',
    adapterName: 'claude-code',
    agentId: 'agent-test',
    cwd: '/tmp',
    model: 'claude-sonnet',
    env: {},
    emitSdkEvent: vi.fn(async () => undefined),
    resumeAdapterSessionId: RESUME_TARGET,
  };
  const session = new ClaudeConnectorSession(config);
  await session.initialize(() => vi.fn());
  return { session, config };
}

/**
 * Read the SDK query options of the Nth `query()` call.
 * @param index - Call index (0-based)
 * @returns Options object passed to the SDK query factory
 */
function queryOptions(index: number): Record<string, unknown> {
  const call = queryHarness.queryFn.mock.calls[index] as unknown as [{ options: Record<string, unknown> }] | undefined;
  if (!call) throw new Error(`No query() call recorded at index ${index}`);
  return call[0].options;
}

describe('ClaudeConnectorSession native resume suppression', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    queryHarness.reset();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('rotates the resume-armed query to a fresh one when useNativeResume is false', async () => {
    const { session, config } = await makeInitializedSession();
    try {
      // initialize() eagerly armed the start-time resume target.
      expect(queryHarness.queryFn).toHaveBeenCalledTimes(1);
      expect(queryOptions(0).resume).toBe(RESUME_TARGET);

      const queue = new UserMessageQueue();
      queue.enqueue(makeHandle(false));
      await session.processQueue(queue);

      // The armed query was rotated: a second query without provider resume.
      expect(queryHarness.queryFn).toHaveBeenCalledTimes(2);
      expect(queryOptions(1).resume).toBeUndefined();
      expect(queryHarness.queryInstance.close).toHaveBeenCalledTimes(1);

      // One-shot: the discarded target cannot re-arm a later query creation,
      // and the fresh generation does not claim the resumed identity.
      expect(config.resumeAdapterSessionId).toBeUndefined();
      expect(session.getConfirmedSessionId()).not.toBe(RESUME_TARGET);
    } finally {
      await session.abort();
    }
  });

  it('keeps the resume-armed query when useNativeResume is true', async () => {
    const { session, config } = await makeInitializedSession();
    try {
      const queue = new UserMessageQueue();
      queue.enqueue(makeHandle(true));
      await session.processQueue(queue);

      expect(queryHarness.queryFn).toHaveBeenCalledTimes(1);
      expect(queryOptions(0).resume).toBe(RESUME_TARGET);
      expect(config.resumeAdapterSessionId).toBe(RESUME_TARGET);
    } finally {
      await session.abort();
    }
  });

  it('keeps the resume-armed query when the decision is absent (legacy callers)', async () => {
    const { session } = await makeInitializedSession();
    try {
      const queue = new UserMessageQueue();
      queue.enqueue(makeHandle(undefined));
      await session.processQueue(queue);

      expect(queryHarness.queryFn).toHaveBeenCalledTimes(1);
      expect(queryOptions(0).resume).toBe(RESUME_TARGET);
    } finally {
      await session.abort();
    }
  });

  it('does not touch generation-owned continuity once system.init confirmed the session', async () => {
    const { session, config } = await makeInitializedSession();
    try {
      // Provider confirms the resumed session before the next dispatch.
      queryHarness.emitMessage({
        type: 'system',
        subtype: 'init',
        session_id: RESUME_TARGET,
      } as SDKMessage);
      await vi.waitFor(() => {
        expect(session.getConfirmedSessionId()).toBe(RESUME_TARGET);
      });

      const queue = new UserMessageQueue();
      queue.enqueue(makeHandle(false));
      await session.processQueue(queue);

      // Confirmed generation: no rotation, no discarded resume target.
      expect(queryHarness.queryFn).toHaveBeenCalledTimes(1);
      expect(config.resumeAdapterSessionId).toBe(RESUME_TARGET);
    } finally {
      await session.abort();
    }
  });
});
