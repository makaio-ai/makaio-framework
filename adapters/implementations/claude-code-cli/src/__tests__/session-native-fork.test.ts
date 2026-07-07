import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue } from '@makaio/ai-adapters-core';
import { McpSubjects } from '@makaio/contracts';
import type { SDKMessage } from '@makaio/client-claude-code';
import type { CliStdioTransport } from '../utils/createStdioTransport.js';

const transportHarness = vi.hoisted(() => {
  type MessageCallback = (message: SDKMessage) => void;
  type ErrorCallback = (error: Error) => void;

  /** Per-transport callback registry keyed by transport instance index. */
  const transports: Array<{
    transport: CliStdioTransport;
    messageCallback?: MessageCallback;
    errorCallback?: ErrorCallback;
  }> = [];

  function createTransport(
    _args: string[],
    _cwd: string,
    _env: Record<string, string>,
    _binaryPath?: string,
    _firstOutputTimeoutMs?: number,
  ): CliStdioTransport {
    const entry: (typeof transports)[number] = {
      transport: {
        onMessage: vi.fn((cb: MessageCallback) => {
          entry.messageCallback = cb;
        }),
        onError: vi.fn((cb: ErrorCallback) => {
          entry.errorCallback = cb;
        }),
        close: vi.fn(),
      },
    };
    transports.push(entry);
    return entry.transport;
  }

  return {
    createStdioTransport: vi.fn(createTransport),
    transports,
    /**
     * Emit a message on the Nth transport (0-indexed).
     * @param index - Transport instance index
     * @param message - SDK message to emit
     */
    emitMessage(index: number, message: SDKMessage): void {
      const entry = transports[index];
      if (!entry?.messageCallback) {
        throw new Error(`Transport ${index} message callback not registered`);
      }
      entry.messageCallback(message);
    },
    reset(): void {
      transports.length = 0;
    },
  };
});

vi.mock('../utils/createStdioTransport.js', () => ({
  createStdioTransport: transportHarness.createStdioTransport,
}));

import { ClaudeCodeCliConnectorNamespace } from '../namespace/index.js';
import { ClaudeCliSession } from '../session.js';

/**
 * Create a minimal message handle for CLI session turn tests.
 * @returns Message handle containing a text prompt.
 */
function makeHandle(): MessageHandle {
  return new MessageHandle(
    'message-native-fork',
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'hello' }],
      message: 'hello',
    },
    'enqueue',
  );
}

describe('ClaudeCliSession native fork validation', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    transportHarness.createStdioTransport.mockClear();
    transportHarness.reset();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('rejects unsupported mid-history native fork before MCP registration or spawn', async () => {
    const registerHandler = vi.fn((ctx: { setResult: (result: { port: number }) => void }) => {
      ctx.setResult({ port: 12345 });
    });
    MakaioBus.on(McpSubjects.session.register, registerHandler);

    const session = new ClaudeCliSession({
      bus: await ClaudeCodeCliConnectorNamespace.scopedBus(),
      adapterId: 'adapter-test',
      adapterName: 'claude-code-cli',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet',
      env: {},
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId: 'provider-source',
        forkPointMessageId: 'msg-checkpoint',
      },
    });
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle());

    await expect(session.processQueue(queue)).rejects.toThrow(
      '[claude-code-cli] Native mid-history fork is not supported by the CLI adapter',
    );

    expect(registerHandler).not.toHaveBeenCalled();
    expect(transportHarness.createStdioTransport).not.toHaveBeenCalled();
  });

  it('consumes nativeFork directive after system.init confirms child session', async () => {
    const childSessionId = 'confirmed-child-session';
    const sourceAdapterSessionId = 'provider-source';

    const session = new ClaudeCliSession({
      bus: await ClaudeCodeCliConnectorNamespace.scopedBus(),
      adapterId: 'adapter-test',
      adapterName: 'claude-code-cli',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId,
      },
    });

    try {
      // Turn 1: initial fork turn
      const handle1 = makeHandle();
      const queue1 = new UserMessageQueue();
      queue1.enqueue(handle1);
      await session.processQueue(queue1);

      // Verify turn 1 spawned with --fork-session
      expect(transportHarness.createStdioTransport).toHaveBeenCalledTimes(1);
      const turn1Args = transportHarness.createStdioTransport.mock.calls[0]![0];
      expect(turn1Args).toContain('--fork-session');
      expect(turn1Args).toContain(sourceAdapterSessionId);

      // Simulate system.init confirming the child session
      transportHarness.emitMessage(0, {
        type: 'system',
        subtype: 'init',
        session_id: childSessionId,
      } as SDKMessage);

      // Simulate result to complete turn 1
      transportHarness.emitMessage(0, {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
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
        session_id: childSessionId,
      } as SDKMessage);

      // Wait for turn 1 completion
      await handle1.waitForCompletion(2_000);

      // Turn 2: normal follow-up after fork turn completed.
      // Before the fix, config.nativeFork persisted and any path where
      // resumeId === undefined would re-fork the source instead of
      // resuming the confirmed child.
      const handle2 = new MessageHandle(
        'message-follow-up',
        {
          role: 'user',
          blocks: [{ type: 'text', content: 'follow-up' }],
          message: 'follow-up',
        },
        'enqueue',
      );
      const queue2 = new UserMessageQueue();
      queue2.enqueue(handle2);
      await session.processQueue(queue2);

      // Verify turn 2 resumes the child, does NOT re-fork the source
      expect(transportHarness.createStdioTransport).toHaveBeenCalledTimes(2);
      const turn2Args = transportHarness.createStdioTransport.mock.calls[1]![0];
      expect(turn2Args).not.toContain('--fork-session');
      expect(turn2Args).not.toContain(sourceAdapterSessionId);
      // Should resume the confirmed child session
      expect(turn2Args).toContain('--resume');
      expect(turn2Args).toContain(childSessionId);
    } finally {
      await session.close();
    }
  });
});
