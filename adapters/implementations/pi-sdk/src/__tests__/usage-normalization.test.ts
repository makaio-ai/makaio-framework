/**
 * Tests for PiAgent usage normalization.
 *
 * Drives the real PiAgent wiring with a stub PiConnector whose lifecycle is
 * inert, so the assertion covers the production path:
 * scoped `usage` subject → wireUsageTracking → trackUsage → agent.usage.
 * @packageDocumentation
 */

import { AgentTeardownArbiter } from '@makaio/ai-adapters-core';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type CallContext, type ConnectorTeardownResult } from '@makaio/contracts';
import { createNoAuthTestProviderContext } from '@makaio/ai-adapters-core';
import { createTestCall } from '@makaio/test-utils';
import { PiAgent } from '../agent.js';
import { PiConnector } from '../connector.js';
import { PiSdkNamespace, PiSdkSubjects } from '../namespaces/index.js';
import { PI_PROVIDER_AUTH_TARGET } from '../provider-auth.js';

const TEST_AGENT_ID = 'agent-pi-usage-test';
const TEST_ADAPTER_ID = 'adapter-pi-usage-test';
const TEST_MODEL = 'claude-sonnet-4-20250514';

/** Stub connector: no Pi SDK session is created; only bus emission is used. */
class TestPiConnector extends PiConnector {
  /** No-op initialization — the Pi SDK session is never created in this test. */
  public override async initialize(): Promise<void> {}

  /**
   * Report a teardown of nothing.
   *
   * This double holds no process, connection or subscription, so `released` is
   * literally true of it: every handle is dropped and no callback can arrive.
   * @returns The `released` class.
   */
  public override async close(): Promise<ConnectorTeardownResult> {
    return { evidence: 'released' };
  }

  /**
   * Emit a raw usage payload on the scoped `usage` subject, exactly like the
   * production session layer does after a completed assistant message.
   * @param call - Call context of the message that produced the usage
   * @param usage - Raw Pi SDK usage object
   */
  public emitUsage(call: CallContext, usage: unknown): Promise<void> {
    return this.emit(call, PiSdkSubjects.usage, { eventType: 'usage', usage });
  }
}

/**
 * Create a fully wired PiAgent backed by the stub connector.
 * @param call - Call context that initializes the agent
 * @returns Agent under test and its connector
 */
async function makeAgent(call: CallContext): Promise<{ agent: PiAgent; connector: TestPiConnector }> {
  MakaioBus.registerNamespaces([PiSdkNamespace.definition]);
  const adapterBus = await PiSdkNamespace.scopedBus(MakaioBus);
  let connector: TestPiConnector | undefined;
  const agent = new PiAgent({
    agentId: TEST_AGENT_ID,
    adapterId: TEST_ADAPTER_ID,
    adapterName: 'pi-sdk',
    machineId: 'test-machine',
    ownerInstanceId: 'test-owner-instance',
    adapterBus,
    teardownArbiter: new AgentTeardownArbiter(),
    globalBus: MakaioBus,
    sessionId: 'framework-session-1',
    cwd: tmpdir(),
    model: TEST_MODEL,
    capabilities: [],
    nativeTools: [],
    configFactory: async (input) => ({
      ...input,
      adapterId: TEST_ADAPTER_ID,
      model: input.model ?? TEST_MODEL,
      cwd: input.cwd ?? tmpdir(),
      adapterAuth: {
        processEnv: {},
        connectorDeliveries: [{ target: PI_PROVIDER_AUTH_TARGET, values: { apiKey: 'test-key' } }],
        configInheritance: 'empty' as const,
      },
      providerContext: createNoAuthTestProviderContext('pi-test-config', 'anthropic'),
      providerProtocol: 'anthropic' as const,
    }),
    connectorFactory: (config) => {
      connector = new TestPiConnector({ ...config, adapterId: TEST_ADAPTER_ID });
      return connector;
    },
  });

  await agent.init(call);
  if (!connector) throw new Error('connectorFactory was not invoked during init()');
  return { agent, connector };
}

describe('PiAgent usage normalization', () => {
  let agents: PiAgent[] = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    agents = [];
  });

  afterEach(async () => {
    await Promise.all(agents.map((agent) => agent.close()));
    MakaioBus.__resetHandlers?.();
  });

  it('emits a provider-reported turn-aggregate usage event', async () => {
    const usageEvents: Array<Record<string, unknown>> = [];
    MakaioBus.on(AgentSubjects.usage, (ctx) => {
      usageEvents.push(ctx.payload as Record<string, unknown>);
    });

    const { agent, connector } = await makeAgent(createTestCall());
    agents.push(agent);

    await connector.emitUsage(createTestCall(), {
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 10,
      totalTokens: 160,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
    });

    await vi.waitFor(() => expect(usageEvents).toHaveLength(1));
    expect(usageEvents[0]).toMatchObject({
      provider: 'pi-sdk',
      granularity: 'turn-aggregate',
      inputTokens: 100,
      inputCachedTokens: 30,
      cacheWriteTokens: 10,
      outputTokens: 20,
      totalTokens: 160,
      cost: 0.037,
      // Cost is the provider's own usage.cost.total.
      costProvenance: 'provider-reported',
    });
  });

  it('skips usage payloads with unexpected shapes', async () => {
    const usageEvents: Array<Record<string, unknown>> = [];
    MakaioBus.on(AgentSubjects.usage, (ctx) => {
      usageEvents.push(ctx.payload as Record<string, unknown>);
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const { agent, connector } = await makeAgent(createTestCall());
      agents.push(agent);

      await connector.emitUsage(createTestCall(), { input: 'not-a-number' });

      await vi.waitFor(() =>
        expect(consoleWarn).toHaveBeenCalledWith('[PiAgent] Received usage event with unexpected shape; skipping.'),
      );
      expect(usageEvents).toHaveLength(0);
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
