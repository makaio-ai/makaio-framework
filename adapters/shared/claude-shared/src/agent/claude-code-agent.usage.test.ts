/**
 * Tests for the terminal-result usage normalization shared by the
 * claude-agent-sdk and claude-code-cli adapters.
 *
 * Uses a minimal concrete ClaudeCodeAgent subclass wired to a stub connector
 * on a dedicated test namespace, so the assertion covers the real production
 * path: sdk.event (result) → handleResultEvent → trackUsage → agent.usage.
 * @packageDocumentation
 */

import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import {
  AIAgentConnector,
  type AgentStartResult,
  type BaseAgentConnectorConfig,
  type MessageHandle,
  type MessageResult,
} from '@makaio/ai-adapters-core';
import type { SDKResultMessage } from '@makaio/client-claude-code';
import {
  createClaudeConnectorNamespace,
  type ClaudeConnectorBus,
  type ClaudeConnectorNamespace,
} from '../namespace/index.js';
import { ClaudeCodeAgent } from './claude-code-agent.js';
import { normalizeTerminalResultUsage, type TerminalResultUsage } from './terminal-usage.js';

const TEST_NAMESPACE = 'adapter:claude-shared-usage-test' as const;
const TestNamespace = createClaudeConnectorNamespace(TEST_NAMESPACE);

const TEST_AGENT_ID = 'agent-claude-shared-usage';
const TEST_ADAPTER_ID = 'adapter-claude-shared-usage';
const TEST_ADAPTER_SESSION_ID = 'claude-shared-usage-session';

type TestBus = ClaudeConnectorBus<typeof TEST_NAMESPACE>;

/**
 * Raw success-result message as connectors hand it to `emit()`: the Makaio
 * enrichment field `agentId` is omitted because `AIAgentConnector.emit()`
 * forbids connector-managed metadata keys and injects them itself (same
 * shape the production connectors produce via `stripSdkMetadata`).
 */
type RawSdkResultMessage = Omit<Extract<SDKResultMessage, { subtype: 'success' }>, 'agentId'>;

/**
 * Stub connector: only the scoped-bus emission path is exercised, so all
 * lifecycle members that would touch a real Claude transport are inert.
 */
class TestClaudeConnector extends AIAgentConnector<TestBus> {
  /**
   * Create the stub connector.
   * @param config - Fully-resolved connector configuration from the config factory
   */
  public constructor(config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) {
    super(config);
  }

  /** No-op initialization; sets the adapter session id used for filtering. */
  public override async initialize(): Promise<void> {
    this.adapterSessionId = TEST_ADAPTER_SESSION_ID;
  }

  /** @returns Never — turns are not started in this test. */
  public override start(): Promise<AgentStartResult> {
    return Promise.reject(new Error('start() is not used in this test'));
  }

  /** @returns Never — messages are not sent in this test. */
  public override sendMessage(): Promise<MessageHandle> {
    return Promise.reject(new Error('sendMessage() is not used in this test'));
  }

  /** No-op abort. */
  public override abort(): void {}

  /** No-op close. */
  public override async close(): Promise<void> {}

  /** @returns The fixed adapter session id for this stub. */
  public override async getAdapterSessionId(): Promise<string> {
    return TEST_ADAPTER_SESSION_ID;
  }

  /** @returns Null — no message results are produced in this test. */
  public override async complete(): Promise<MessageResult | null> {
    return null;
  }

  /** No-op interrupt. */
  public override async interrupt(): Promise<void> {}

  /**
   * Emit a raw SDK message on the scoped sdk.event subject, exactly like the
   * production connectors do (metadata-stripped payload; `emit()` injects
   * the connector identity fields).
   * @param message - Raw Claude SDK result message to deliver to the agent
   */
  public emitSdkEvent(message: RawSdkResultMessage): Promise<void> {
    return this.emit(TestNamespace.subjects.sdk.event, message);
  }
}

/** Minimal concrete agent binding ClaudeCodeAgent to the test namespace. */
class TestClaudeAgent extends ClaudeCodeAgent<typeof TEST_NAMESPACE, TestClaudeConnector> {
  /** @returns Subjects of the dedicated test namespace. */
  protected getSubjects(): ClaudeConnectorNamespace<typeof TEST_NAMESPACE>['subjects'] {
    return TestNamespace.subjects;
  }
}

/**
 * Create a fully wired TestClaudeAgent backed by the stub connector.
 * @returns Agent under test and its connector
 */
async function makeAgent(): Promise<{ agent: TestClaudeAgent; connector: TestClaudeConnector }> {
  const adapterBus = await TestNamespace.scopedBus();
  let connector: TestClaudeConnector | undefined;
  const agent = new TestClaudeAgent({
    agentId: TEST_AGENT_ID,
    adapterId: TEST_ADAPTER_ID,
    adapterName: 'claude-shared-test',
    adapterBus,
    globalBus: MakaioBus,
    sessionId: 'framework-session-1',
    cwd: os.tmpdir(),
    model: 'claude-sonnet',
    capabilities: [],
    nativeTools: [],
    configFactory: async (input) => ({
      ...input,
      adapterId: TEST_ADAPTER_ID,
      model: input.model ?? 'claude-sonnet',
      cwd: input.cwd ?? os.tmpdir(),
    }),
    connectorFactory: (config) => {
      connector = new TestClaudeConnector(config);
      return connector;
    },
  });

  await agent.init();
  if (!connector) throw new Error('connectorFactory was not invoked during init()');
  return { agent, connector };
}

/**
 * Build a schema-valid terminal result message with provider usage and an optional cost.
 * @param totalCostUsd - Provider-reported query cost
 * @returns Raw SDK result message
 */
function makeResultMessage(totalCostUsd: number): RawSdkResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 2,
    total_cost_usd: totalCostUsd,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      server_tool_use: { web_search_requests: 0 },
      service_tier: 'standard',
    },
    modelUsage: {},
    permission_denials: [],
    uuid: 'result-1',
    session_id: TEST_ADAPTER_SESSION_ID,
  };
}

describe('ClaudeCodeAgent terminal result usage', () => {
  let agents: TestClaudeAgent[] = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    agents = [];
  });

  afterEach(async () => {
    await Promise.all(agents.map((agent) => agent.close()));
    MakaioBus.__resetHandlers?.();
  });

  it('emits a provider-reported query-aggregate usage event for the terminal result', async () => {
    const usageEvents: Array<Record<string, unknown>> = [];
    MakaioBus.on(AgentSubjects.usage, (ctx) => {
      usageEvents.push(ctx.payload as Record<string, unknown>);
    });

    const { agent, connector } = await makeAgent();
    agents.push(agent);

    await connector.emitSdkEvent(makeResultMessage(0.42));

    await vi.waitFor(() => expect(usageEvents).toHaveLength(1));
    expect(usageEvents[0]).toMatchObject({
      provider: 'anthropic',
      // Terminal result covers the whole query, possibly multiple model turns.
      granularity: 'query-aggregate',
      inputTokens: 10,
      inputCachedTokens: 3,
      cacheWriteTokens: 2,
      outputTokens: 5,
      totalTokens: 18,
      cost: 0.42,
      // Cost comes from the provider's own total_cost_usd on the result message.
      costProvenance: 'provider-reported',
      serviceTier: 'standard',
    });
  });

  it('omits cost fields when the terminal result does not report a cost', () => {
    const usage: TerminalResultUsage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      service_tier: 'standard',
    };

    const normalized = normalizeTerminalResultUsage(usage, undefined);

    expect(normalized).not.toHaveProperty('cost');
    expect(normalized).not.toHaveProperty('costProvenance');
  });
});
