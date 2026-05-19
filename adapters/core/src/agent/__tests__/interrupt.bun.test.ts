import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { createAgentTestLifecycle, createTestableAgent } from './helpers/mock-agent.js';

describe('AIAgent interrupt handler', () => {
  const ctx = createAgentTestLifecycle();

  beforeEach(() => ctx.reset());
  afterEach(async () => await ctx.teardown());

  it('delegates agent.interrupt to the active connector', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-interrupt',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();

    const response = await MakaioBus.request(AgentSubjects.interrupt, {
      agentId: 'test-agent-interrupt',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
    });

    expect(response).toEqual({ success: true });
    // Core AIAgent owns only the bus-to-connector seam; provider-specific
    // interrupt transport is covered by implementation connector tests.
    expect(ctx.agent.currentConnector.interruptCalled).toBe(true);
  });

  it('returns the connector failure reason from the real agent.interrupt handler path', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-interrupt-failure',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();
    ctx.agent.currentConnector.interrupt = async () => {
      throw new Error('provider interrupt unavailable');
    };

    const response = await MakaioBus.request(AgentSubjects.interrupt, {
      agentId: 'test-agent-interrupt-failure',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
    });

    expect(response).toEqual({ success: false, reason: 'provider interrupt unavailable' });
  });
});
