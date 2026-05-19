/**
 * Tests for ClaudeCodeAgent-owned `client.session.*` observed-semantics emissions.
 *
 * The connector/session layer exposes Claude SDK events on its scoped adapter
 * namespace. The concrete agent owns the bridge from those scoped events and
 * core `agent.*` lifecycle events to the global `client.session.*` surface.
 */

/// <reference types="bun-types" />
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { waitFor } from '@makaio/test-utils';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type { NormalizedMessageInput } from '@makaio/ai-adapters-core';
import type { OptionalResult } from '@makaio/core';

// ---------------------------------------------------------------------------
// SDK mock — controllable push-based query
// ---------------------------------------------------------------------------

let pushToQuery: (msg: unknown) => void = () => undefined;
let completeQuery: () => void = () => undefined;

const query = mock(() => {
  const pending: unknown[] = [];
  const waiters: Array<(msg: unknown) => void> = [];
  let done = false;

  pushToQuery = (msg: unknown) => {
    if (waiters.length > 0) {
      waiters.shift()!(msg);
    } else {
      pending.push(msg);
    }
  };

  completeQuery = () => {
    done = true;
    for (const waiter of waiters) {
      waiter(Symbol.for('done'));
    }
    waiters.length = 0;
  };

  return {
    interrupt: mock(async () => undefined),
    close: mock(() => undefined),
    setMcpServers: mock(async () => ({ added: [], removed: [], errors: {} })),
    setMaxThinkingTokens: mock(async () => undefined),
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (pending.length > 0) {
          const msg = pending.shift()!;
          if (msg === Symbol.for('done')) return;
          yield msg;
        } else if (done) {
          return;
        } else {
          const msg = await new Promise<unknown>((resolve) => {
            waiters.push(resolve);
          });
          if (msg === Symbol.for('done')) return;
          yield msg;
        }
      }
    },
  };
});

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  Options: class Options {},
  query,
}));

import { ClaudeCodeAgent } from '../agent.js';
import { ClaudeSdkConnector } from '../connector.js';
import { ClaudeCodeConnectorNamespace, type ClaudeCodeConnectorBus } from '../namespace/index.js';
import type { ClaudeAgentConfig } from '../types/index.js';

const USER_MESSAGE: NormalizedMessageInput = {
  role: 'user',
  blocks: [{ type: 'text', content: 'Hello from the user' }],
  message: 'Hello from the user',
};

/**
 * Build SDK metadata common to mocked Claude events.
 * @param sessionId - Adapter session ID carried by the SDK event.
 * @returns Base SDK event metadata.
 */
function sdkBase(sessionId: string) {
  return {
    uuid: randomUUID(),
    session_id: sessionId,
    agentId: 'agent-test',
  };
}

/**
 * Build a schema-valid `system.init` SDK event.
 * @param sessionId - Adapter session ID to confirm.
 * @returns SDK system init event.
 */
function systemInit(sessionId: string) {
  return {
    ...sdkBase(sessionId),
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    cwd: os.tmpdir(),
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
  };
}

/**
 * Build a schema-valid replayed user SDK event for acknowledgement.
 * @param sessionId - Adapter session ID for the active turn.
 * @returns SDK user replay event.
 */
function userReplay(sessionId: string) {
  return {
    ...sdkBase(sessionId),
    type: 'user',
    isReplay: true,
    message: {
      role: 'user',
      content: 'Hello from the user',
    },
  };
}

/**
 * Build a schema-valid successful result SDK event.
 * @param sessionId - Adapter session ID for the active turn.
 * @returns SDK result event.
 */
function successResult(sessionId: string) {
  return {
    ...sdkBase(sessionId),
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done',
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
  };
}

/**
 * Create a Claude agent with the real connector and a mocked SDK query.
 * @param opts - Optional identity overrides.
 * @returns Agent ready for initialize/start calls.
 */
async function makeAgent(opts: { sessionId?: string; clientId?: string } = {}): Promise<ClaudeCodeAgent> {
  const adapterBus = await ClaudeCodeConnectorNamespace.scopedBus();

  return new ClaudeCodeAgent({
    adapterBus,
    globalBus: MakaioBus,
    adapterId: 'adapter-test',
    adapterName: 'claude-agent-sdk',
    agentId: 'agent-test',
    cwd: os.tmpdir(),
    model: 'claude-sonnet-4-20250514',
    env: {},
    capabilities: [],
    nativeTools: [],
    configFactory: async (input) => ({
      ...input,
      bus: input.bus as ClaudeCodeConnectorBus,
      cwd: input.cwd ?? os.tmpdir(),
      model: input.model ?? 'claude-sonnet-4-20250514',
      env: input.env ?? {},
    }),
    connectorFactory: (config) =>
      new ClaudeSdkConnector({
        ...(config as ClaudeAgentConfig),
        clientId: config.clientId ?? 'claude-code',
        requestSessionAccountObservation: async (): Promise<OptionalResult<never>> => ({ handled: false }),
      }),
    ...opts,
  });
}

describe('ClaudeCodeAgent client.session observed-semantics', () => {
  let agents: ClaudeCodeAgent[];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    query.mockClear();
    agents = [];
  });

  afterEach(async () => {
    completeQuery();
    await Promise.all(agents.map((agent) => agent.close()));
    agents = [];
    MakaioBus.__resetHandlers?.();
  });

  it('emits client.session.started when the SDK confirms system.init', async () => {
    const agent = await makeAgent({ clientId: 'claude-code', sessionId: 'fw-session-1' });
    agents.push(agent);
    await agent.initialize();

    const received: unknown[] = [];
    const cleanup = MakaioBus.on(ClientSubjects.session.started, ({ payload }) => {
      received.push(payload);
    });

    pushToQuery(systemInit('sdk-session-started'));

    await waitFor(() => expect(received).toHaveLength(1));
    cleanup();

    expect(received[0]).toMatchObject({
      clientId: 'claude-code',
      source: 'adapter-derived',
      sessionId: 'fw-session-1',
      adapterSessionId: 'sdk-session-started',
      observedAt: expect.any(Number),
    });
  });

  it('emits client.session.userPrompt.submitted from the agent user-message lifecycle', async () => {
    const agent = await makeAgent({ clientId: 'claude-code', sessionId: 'fw-session-prompt' });
    agents.push(agent);

    const received: unknown[] = [];
    const cleanup = MakaioBus.on(ClientSubjects.session.userPrompt.submitted, ({ payload }) => {
      received.push(payload);
    });

    await agent.start(USER_MESSAGE);

    await waitFor(() => expect(received).toHaveLength(1));
    cleanup();

    expect(received[0]).toMatchObject({
      clientId: 'claude-code',
      source: 'adapter-derived',
      sessionId: 'fw-session-prompt',
      prompt: 'Hello from the user',
      observedAt: expect.any(Number),
    });
  });

  it('emits client.session.turn.started when the message handle is acknowledged', async () => {
    const agent = await makeAgent({ clientId: 'claude-code', sessionId: 'fw-session-turn' });
    agents.push(agent);

    const received: unknown[] = [];
    const cleanup = MakaioBus.on(ClientSubjects.session.turn.started, ({ payload }) => {
      received.push(payload);
    });

    const startResult = await agent.start(USER_MESSAGE);
    pushToQuery(userReplay(startResult.adapterSessionId));

    await waitFor(() => expect(received).toHaveLength(1));
    cleanup();

    expect(received[0]).toMatchObject({
      clientId: 'claude-code',
      source: 'adapter-derived',
      sessionId: 'fw-session-turn',
      adapterSessionId: startResult.adapterSessionId,
      observedAt: expect.any(Number),
    });
  });

  it('emits client.session.turn.completed when the message handle completes', async () => {
    const agent = await makeAgent({ clientId: 'claude-code', sessionId: 'fw-session-completed' });
    agents.push(agent);

    const startResult = await agent.start(USER_MESSAGE);
    pushToQuery(userReplay(startResult.adapterSessionId));

    const received: unknown[] = [];
    const cleanup = MakaioBus.on(ClientSubjects.session.turn.completed, ({ payload }) => {
      received.push(payload);
    });

    pushToQuery(successResult(startResult.adapterSessionId));

    await waitFor(() => expect(received).toHaveLength(1));
    cleanup();

    expect(received[0]).toMatchObject({
      clientId: 'claude-code',
      source: 'adapter-derived',
      sessionId: 'fw-session-completed',
      adapterSessionId: startResult.adapterSessionId,
      observedAt: expect.any(Number),
    });
  });
});
