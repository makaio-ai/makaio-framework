import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { createTestableAgent, createAgentTestLifecycle } from './helpers/mock-agent.js';

describe('AIAgent idle event emission', () => {
  const ctx = createAgentTestLifecycle();

  beforeEach(() => {
    ctx.reset();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it('emits agent.idle when connector processing state transitions to idle', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-idle',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model',
      initialCwd: '/test/cwd',
    });

    // Listen for idle events
    const idleEvents: unknown[] = [];
    const unsubIdle = MakaioBus.withFilter({ agentId: 'test-agent-idle' }).on(AgentSubjects.idle, (evtCtx) => {
      idleEvents.push(evtCtx.payload);
    });
    ctx.cleanupFns.push(unsubIdle);

    await ctx.agent.init();

    // Initially no idle events (connector starts in idle state)
    expect(idleEvents).toHaveLength(0);

    // Trigger processing state change to active
    ctx.agent.currentConnector.setProcessingState('processing_started');

    // Then transition to idle
    ctx.agent.currentConnector.setProcessingState('idle');

    // Wait a tick for async emission
    await new Promise((resolve) => process.nextTick(resolve));

    // Should have emitted agent.idle
    expect(idleEvents).toHaveLength(1);
    expect(idleEvents[0]).toMatchObject({
      agentId: 'test-agent-idle',
      adapterId: 'test-adapter',
      adapterName: 'test',
    });
  });

  it('does not emit agent.idle for non-idle state transitions', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-idle-2',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model',
      initialCwd: '/test/cwd',
    });

    // Listen for idle events
    const idleEvents: unknown[] = [];
    const unsubIdle = MakaioBus.withFilter({ agentId: 'test-agent-idle-2' }).on(AgentSubjects.idle, (evtCtx) => {
      idleEvents.push(evtCtx.payload);
    });
    ctx.cleanupFns.push(unsubIdle);

    await ctx.agent.init();

    // Trigger various state transitions (not idle)
    ctx.agent.currentConnector.setProcessingState('processing_started');
    ctx.agent.currentConnector.setProcessingState('turn_started');
    ctx.agent.currentConnector.setProcessingState('step_started');

    // Wait a tick
    await new Promise((resolve) => process.nextTick(resolve));

    // Should not have emitted agent.idle
    expect(idleEvents).toHaveLength(0);
  });

  it('emits agent.idle after connector swap when new connector reaches idle', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-idle-3',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model',
      initialCwd: '/test/cwd1',
    });

    // Listen for idle events
    const idleEvents: unknown[] = [];
    const unsubIdle = MakaioBus.withFilter({ agentId: 'test-agent-idle-3' }).on(AgentSubjects.idle, (evtCtx) => {
      idleEvents.push(evtCtx.payload);
    });
    ctx.cleanupFns.push(unsubIdle);

    await ctx.agent.init();

    // Swap connector (cwd change)
    const response = await MakaioBus.request(AgentSubjects.cwd.change, {
      agentId: 'test-agent-idle-3',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newCwd: '/test/cwd2',
    });

    expect(response.success).toBe(true);
    expect(ctx.createdConnectors).toHaveLength(2);

    // New connector transitions to idle
    ctx.agent.currentConnector.setProcessingState('processing_started');
    ctx.agent.currentConnector.setProcessingState('idle');

    // Wait a tick
    await new Promise((resolve) => process.nextTick(resolve));

    // Should have emitted agent.idle
    expect(idleEvents).toHaveLength(1);
  });
});
