import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue } from '@makaio/ai-adapters-core';
import type { SDKMessage } from '@makaio/client-claude-code';
import type { CliStdioTransport } from '../utils/createStdioTransport.js';
import type { ClaudeCliSessionConfig } from '../types.js';

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
 * Create a CLI session configured with a start-time resume target.
 * @returns Session under test
 */
async function makeSession(): Promise<ClaudeCliSession> {
  const config: ClaudeCliSessionConfig = {
    bus: await ClaudeCodeCliConnectorNamespace.scopedBus(),
    adapterId: 'adapter-test',
    adapterName: 'claude-code-cli',
    agentId: 'agent-test',
    cwd: os.tmpdir(),
    model: 'claude-sonnet',
    env: {},
    emitSdkEvent: vi.fn(async () => undefined),
    resumeAdapterSessionId: RESUME_TARGET,
  };
  return new ClaudeCliSession(config);
}

/**
 * Read the argv of the Nth spawned CLI subprocess.
 * @param index - Spawn call index (0-based)
 * @returns CLI argument array passed to the transport factory
 */
function spawnedArgs(index: number): string[] {
  const call = transportHarness.createStdioTransport.mock.calls[index];
  if (!call) throw new Error(`No transport spawn recorded at index ${index}`);
  return call[0];
}

describe('ClaudeCliSession native resume suppression', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    transportHarness.createStdioTransport.mockClear();
    transportHarness.reset();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('suppresses --resume and mints a fresh --session-id when useNativeResume is false', async () => {
    const session = await makeSession();
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle(false));
    await session.processQueue(queue);

    const args = spawnedArgs(0);
    expect(args).not.toContain('--resume');
    expect(args).not.toContain(RESUME_TARGET);
    expect(args).toContain('--session-id');
    const pinnedId = args[args.indexOf('--session-id') + 1];
    expect(pinnedId).toBeDefined();
    expect(pinnedId).not.toBe(RESUME_TARGET);
    // The suppression is one-shot: the session's local identity moved off the
    // discarded resume target as well.
    expect(await session.getAdapterSessionId()).toBe(pinnedId);
  });

  it('resumes the stored target when useNativeResume is true', async () => {
    const session = await makeSession();
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle(true));
    await session.processQueue(queue);

    const args = spawnedArgs(0);
    expect(args).toContain('--resume');
    expect(args).toContain(RESUME_TARGET);
    expect(args).not.toContain('--session-id');
  });

  it('resumes the stored target when the decision is absent (legacy callers)', async () => {
    const session = await makeSession();
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle(undefined));
    await session.processQueue(queue);

    const args = spawnedArgs(0);
    expect(args).toContain('--resume');
    expect(args).toContain(RESUME_TARGET);
  });

  it('does not touch generation-owned continuity: a confirmed session resumes itself even with useNativeResume false', async () => {
    const session = await makeSession();

    // Turn 1: suppressed resume → fresh session.
    const handle1 = makeHandle(false);
    const queue1 = new UserMessageQueue();
    queue1.enqueue(handle1);
    await session.processQueue(queue1);
    const pinnedId = spawnedArgs(0)[spawnedArgs(0).indexOf('--session-id') + 1]!;

    // Provider confirms the fresh session and completes the turn.
    transportHarness.emitMessage(0, { type: 'system', subtype: 'init', session_id: pinnedId } as SDKMessage);
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
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0 },
        service_tier: 'standard',
      },
      modelUsage: {},
      permission_denials: [],
      uuid: 'result-1',
      session_id: pinnedId,
    } as SDKMessage);
    await handle1.waitForCompletion(2_000);

    // Turn 2 with useNativeResume false: intra-generation continuity must
    // still resume the generation's own confirmed session.
    const queue2 = new UserMessageQueue();
    queue2.enqueue(makeHandle(false));
    await session.processQueue(queue2);

    const args2 = spawnedArgs(1);
    expect(args2).toContain('--resume');
    expect(args2).toContain(pinnedId);
    expect(args2).not.toContain(RESUME_TARGET);

    await session.close();
  });
});
