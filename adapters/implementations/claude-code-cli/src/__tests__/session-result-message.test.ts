import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue, type MessageResult } from '@makaio/ai-adapters-core';
import type { SDKMessage } from '@makaio/client-claude-code';
import type { CliStdioTransport } from '../utils/createStdioTransport.js';

const transportHarness = vi.hoisted(() => {
  type MessageCallback = (message: SDKMessage) => void;
  type ErrorCallback = (error: Error) => void;

  let messageCallback: MessageCallback | undefined;
  let errorCallback: ErrorCallback | undefined;

  const transport: CliStdioTransport = {
    onMessage: vi.fn((callback: MessageCallback) => {
      messageCallback = callback;
    }),
    onError: vi.fn((callback: ErrorCallback) => {
      errorCallback = callback;
    }),
    close: vi.fn(),
  };

  return {
    transport,
    emitMessage(message: SDKMessage): void {
      if (!messageCallback) {
        throw new Error('Transport message callback was not registered');
      }
      messageCallback(message);
    },
    emitError(error: Error): void {
      if (!errorCallback) {
        throw new Error('Transport error callback was not registered');
      }
      errorCallback(error);
    },
    reset(): void {
      messageCallback = undefined;
      errorCallback = undefined;
      vi.mocked(transport.onMessage).mockClear();
      vi.mocked(transport.onError).mockClear();
      vi.mocked(transport.close).mockClear();
    },
  };
});

vi.mock('../utils/createStdioTransport.js', () => ({
  createStdioTransport: vi.fn(() => transportHarness.transport),
}));

import { ClaudeCliSession } from '../session.js';
import { ClaudeCodeCliConnectorNamespace } from '../namespace/index.js';

function makeHandle(): MessageHandle {
  return new MessageHandle(
    'message-structured-output',
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'Return JSON' }],
      message: 'Return JSON',
    },
    'enqueue',
  );
}

function structuredOutputResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: { ok: true },
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
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
    },
    modelUsage: {},
    permission_denials: [],
    uuid: 'result-1',
    session_id: 'session-1',
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveDeferred: (() => void) | undefined;
  const promise = new Promise<void>((promiseResolve) => {
    resolveDeferred = promiseResolve;
  });
  return {
    promise,
    resolve(): void {
      if (!resolveDeferred) {
        throw new Error('Deferred resolver was not initialized');
      }
      resolveDeferred();
    },
  };
}

describe('ClaudeCliSession result message handling', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    transportHarness.reset();
  });

  it('serializes native structured_output into the terminal message', async () => {
    const bus = await ClaudeCodeCliConnectorNamespace.scopedBus();
    const handle = makeHandle();
    const onTurnComplete = vi.fn();
    const session = new ClaudeCliSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-code-cli',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
      onTurnComplete,
    });

    try {
      const queue = new UserMessageQueue();
      queue.enqueue(handle);

      await expect(session.processQueue(queue)).resolves.toBe(true);
      expect(transportHarness.transport.onMessage).toHaveBeenCalledTimes(1);
      expect(transportHarness.transport.onError).toHaveBeenCalledTimes(1);

      transportHarness.emitMessage(structuredOutputResult());

      const expectedResult: MessageResult = {
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      };
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual(expectedResult);
      expect(onTurnComplete).toHaveBeenCalledWith(handle, expectedResult);
    } finally {
      await session.close();
    }
  });

  it('ignores late transport errors once result completion has started', async () => {
    const bus = await ClaudeCodeCliConnectorNamespace.scopedBus();
    const turnFinishedPayloads: unknown[] = [];
    const unsubscribeTurnFinished = bus.on(ClaudeCodeCliConnectorNamespace.subjects.turn.turn_finished, (payload) => {
      turnFinishedPayloads.push(payload);
    });
    const handle = makeHandle();
    const onTurnCompleteGate = createDeferred();
    const onTurnComplete = vi.fn(async () => {
      await onTurnCompleteGate.promise;
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const session = new ClaudeCliSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-code-cli',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
      onTurnComplete,
    });

    try {
      const queue = new UserMessageQueue();
      queue.enqueue(handle);

      await expect(session.processQueue(queue)).resolves.toBe(true);

      transportHarness.emitMessage(structuredOutputResult());
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual({
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      });

      transportHarness.emitError(new Error('late transport close'));
      onTurnCompleteGate.resolve();

      await vi.waitFor(() => {
        expect(turnFinishedPayloads).toHaveLength(1);
      });
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(consoleWarn).not.toHaveBeenCalledWith(
        expect.stringContaining('markCompleted called for messageId: message-structured-output but already completed.'),
      );
    } finally {
      consoleWarn.mockRestore();
      unsubscribeTurnFinished();
      await session.close();
    }
  });
});
