/**
 * Tests for PiAgent usage normalization.
 *
 * Drives the real PiAgent wiring with a stub PiConnector whose lifecycle is
 * inert, so the assertion covers the production path:
 * scoped `usage` subject → wireUsageTracking → trackUsage → agent.usage.
 * @packageDocumentation
 */

import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { PiAgent } from '../agent.js';
import { PiConnector } from '../connector.js';
import { PiSdkNamespace, PiSdkSubjects } from '../namespaces/index.js';

const TEST_AGENT_ID = 'agent-pi-usage-test';
const TEST_ADAPTER_ID = 'adapter-pi-usage-test';
const TEST_MODEL = 'claude-sonnet-4-20250514';

/** Stub connector: no Pi SDK session is created; only bus emission is used. */
class TestPiConnector extends PiConnector {
  /** No-op initialization — the Pi SDK session is never created in this test. */
  public override async initialize(): Promise<void> {}

  /** No-op close. */
  public override async close(): Promise<void> {}

  /**
   * Emit a raw usage payload on the scoped `usage` subject, exactly like the
   * production session layer does after a completed assistant message.
   * @param usage - Raw Pi SDK usage object
   */
  public emitUsage(usage: unknown): Promise<void> {
    return this.emit(PiSdkSubjects.usage, { eventType: 'usage', usage });
  }
}

/**
 * Create a fully wired PiAgent backed by the stub connector.
 * @returns Agent under test and its connector
 */
async function makeAgent(): Promise<{ agent: PiAgent; connector: TestPiConnector }> {
  const adapterBus = await PiSdkNamespace.scopedBus();
  let connector: TestPiConnector | undefined;
  const agent = new PiAgent({
    agentId: TEST_AGENT_ID,
    adapterId: TEST_ADAPTER_ID,
    adapterName: 'pi-sdk',
    adapterBus,
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
    }),
    connectorFactory: (config) => {
      connector = new TestPiConnector({ ...config, adapterId: TEST_ADAPTER_ID });
      return connector;
    },
  });

  await agent.init();
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

    const { agent, connector } = await makeAgent();
    agents.push(agent);

    await connector.emitUsage({
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
      const { agent, connector } = await makeAgent();
      agents.push(agent);

      await connector.emitUsage({ input: 'not-a-number' });

      await vi.waitFor(() =>
        expect(consoleWarn).toHaveBeenCalledWith('[PiAgent] Received usage event with unexpected shape; skipping.'),
      );
      expect(usageEvents).toHaveLength(0);
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
