import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { SDKMessage } from '@makaio/client-claude-code';

/**
 * Stub SDK query whose async iterator yields messages pushed by the test harness.
 * Allows driving the system.init / result flow without a real Claude Agent SDK.
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
     * Emit a message into the consumption loop.
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
      // Clear the top-level queryFn call count so tests can assert per-test call counts
      this.queryFn.mockClear();
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryHarness.queryFn,
}));

import { ClaudeCodeConnectorNamespace } from '../namespace/index.js';
import { ClaudeConnectorSession } from '../session.js';

describe('ClaudeConnectorSession native fork adapter session ID', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    queryHarness.reset();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('converges adapter session ID from local placeholder to provider-confirmed child ID', async () => {
    const childSessionId = 'confirmed-child-session';
    const sourceAdapterSessionId = 'provider-source';

    const session = new ClaudeConnectorSession({
      bus: await ClaudeCodeConnectorNamespace.scopedBus(),
      adapterId: 'adapter-test',
      adapterName: 'claude-code',
      agentId: 'agent-test',
      cwd: '/tmp',
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId,
      },
    });

    try {
      await session.initialize(() => vi.fn());

      // After initialize(), getAdapterSessionId() resolves eagerly with a local
      // placeholder UUID to avoid deadlocking idle fork sessions. This is a
      // non-confirmed ID that must NOT be persisted as the canonical session ID.
      const placeholderId = await session.getAdapterSessionId();
      expect(placeholderId).toBeDefined();
      expect(typeof placeholderId).toBe('string');
      // Confirmed session ID must be undefined before system.init
      expect(session.getConfirmedSessionId()).toBeUndefined();

      // Simulate system.init with the provider-generated child session ID
      queryHarness.emitMessage({
        type: 'system',
        subtype: 'init',
        session_id: childSessionId,
      } as SDKMessage);

      // Allow microtask queue to flush for the consumption loop
      await new Promise((resolve) => setTimeout(resolve, 20));

      // After system.init, getAdapterSessionId() must return the confirmed child ID
      const confirmedId = await session.getAdapterSessionId();
      expect(confirmedId).toBe(childSessionId);
      expect(confirmedId).not.toBe(placeholderId);
      expect(session.getConfirmedSessionId()).toBe(childSessionId);
    } finally {
      await session.abort();
    }
  });

  it('eagerly resolves adapter session ID for non-fork sessions', async () => {
    const session = new ClaudeConnectorSession({
      bus: await ClaudeCodeConnectorNamespace.scopedBus(),
      adapterId: 'adapter-test',
      adapterName: 'claude-code',
      agentId: 'agent-test',
      cwd: '/tmp',
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn());

      // Non-fork sessions should resolve immediately with the local ID
      const raceResult = await Promise.race([
        session.getAdapterSessionId().then((id) => ({ resolved: true, id })),
        new Promise<{ resolved: false }>((resolve) => setTimeout(() => resolve({ resolved: false }), 50)),
      ]);
      expect(raceResult.resolved).toBe(true);
    } finally {
      await session.abort();
    }
  });

  it('getConfirmedSessionId returns undefined before system.init and the confirmed ID after', async () => {
    const childSessionId = 'confirmed-child-session';

    const session = new ClaudeConnectorSession({
      bus: await ClaudeCodeConnectorNamespace.scopedBus(),
      adapterId: 'adapter-test',
      adapterName: 'claude-code',
      agentId: 'agent-test',
      cwd: '/tmp',
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId: 'provider-source',
      },
    });

    try {
      await session.initialize(() => vi.fn());

      // Before system.init, getConfirmedSessionId must return undefined
      expect(session.getConfirmedSessionId()).toBeUndefined();

      // Simulate system.init
      queryHarness.emitMessage({
        type: 'system',
        subtype: 'init',
        session_id: childSessionId,
      } as SDKMessage);

      // Allow microtask queue to flush
      await new Promise((resolve) => setTimeout(resolve, 20));

      // After system.init, getConfirmedSessionId must return the provider ID
      expect(session.getConfirmedSessionId()).toBe(childSessionId);
    } finally {
      await session.abort();
    }
  });

  it('emitSdkEvent does not deadlock when unknown SDK event arrives before system.init', async () => {
    const childSessionId = 'confirmed-child-session';
    const emitSdkEvent = vi.fn(async () => undefined);

    const session = new ClaudeConnectorSession({
      bus: await ClaudeCodeConnectorNamespace.scopedBus(),
      adapterId: 'adapter-test',
      adapterName: 'claude-code',
      agentId: 'agent-test',
      cwd: '/tmp',
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent,
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId: 'provider-source',
      },
    });

    try {
      await session.initialize(() => vi.fn());

      // Emit an unknown-type message BEFORE system.init.
      // This exercises the code path at handleSdkMessage line 460-462
      // where unknown messages are emitted via emitSdkEvent.
      // Before the fix, if emitSdkEvent awaited getAdapterSessionId(),
      // this would deadlock the consumption loop.
      queryHarness.emitMessage({ type: 'unknown_future_type' } as unknown as SDKMessage);

      // Allow microtask queue to flush — if the consumption loop is
      // deadlocked, system.init below will never be processed.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Now emit system.init — this must be processed despite the
      // earlier unknown event.
      queryHarness.emitMessage({
        type: 'system',
        subtype: 'init',
        session_id: childSessionId,
      } as SDKMessage);

      await new Promise((resolve) => setTimeout(resolve, 20));

      // The deferred should have resolved via system.init
      const resolvedId = await session.getAdapterSessionId();
      expect(resolvedId).toBe(childSessionId);

      // The unknown event should have been emitted
      expect(emitSdkEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'unknown_future_type' }));
    } finally {
      await session.abort();
    }
  });

  it('idle fork followed by responseSchema turn does not re-fork before system.init', async () => {
    const sourceAdapterSessionId = 'provider-source';

    // Share the config reference so we can verify nativeFork consumption
    // after the first createQuery (triggered by initialize).
    const sessionConfig = {
      bus: await ClaudeCodeConnectorNamespace.scopedBus(),
      adapterId: 'adapter-test',
      adapterName: 'claude-code',
      agentId: 'agent-test',
      cwd: '/tmp',
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId,
      } as { sourceSessionId: string; sourceAdapterSessionId: string } | undefined,
    };

    const session = new ClaudeConnectorSession(sessionConfig);

    try {
      await session.initialize(() => vi.fn());

      // First query (from initialize) must carry the fork directive
      expect(queryHarness.queryFn).toHaveBeenCalledTimes(1);
      const firstCallArgs = queryHarness.queryFn.mock.calls[0] as unknown as [{ options: Record<string, unknown> }];
      expect(firstCallArgs[0].options.resume).toBe(sourceAdapterSessionId);
      expect(firstCallArgs[0].options.forkSession).toBe(true);

      // The session-level one-shot consumption must have cleared nativeFork
      // from the config so any subsequent createQuery (e.g., triggered by
      // ensureQueryForResponseSchema when a responseSchema is first applied
      // before system.init) will not re-fork the source session.
      expect(sessionConfig.nativeFork).toBeUndefined();
    } finally {
      await session.abort();
    }
  });
});
