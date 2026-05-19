import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { createTestableAgent, createAgentTestLifecycle } from './helpers/mock-agent.js';

describe('AIAgent CWD change handler', () => {
  const ctx = createAgentTestLifecycle();

  beforeEach(() => {
    ctx.reset();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it('cwd.change request triggers connector swap and emits cwd.changed', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-cwd',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model',
      initialCwd: '/test/cwd1',
    });
    await ctx.agent.init();

    const initialConnector = ctx.createdConnectors[0];
    expect(initialConnector.cwd).toBe('/test/cwd1');

    // Listen for cwd.changed event
    const changedEvents: Array<{ previousCwd: string; newCwd: string }> = [];
    const unsubChanged = MakaioBus.withFilter({ agentId: 'test-agent-cwd' }).on(AgentSubjects.cwd.changed, (evtCtx) => {
      changedEvents.push({ previousCwd: evtCtx.payload.previousCwd, newCwd: evtCtx.payload.newCwd });
    });
    ctx.cleanupFns.push(unsubChanged);

    // Request CWD change
    const response = await MakaioBus.request(AgentSubjects.cwd.change, {
      agentId: 'test-agent-cwd',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newCwd: '/test/cwd2',
    });

    expect(response.success).toBe(true);
    expect(response.previousCwd).toBe('/test/cwd1');
    expect(ctx.createdConnectors).toHaveLength(2);
    expect(initialConnector.closeCalled).toBe(true);
    expect(ctx.agent.currentConnector.cwd).toBe('/test/cwd2');
    expect(changedEvents).toHaveLength(1);
    expect(changedEvents[0]).toEqual({ previousCwd: '/test/cwd1', newCwd: '/test/cwd2' });
  });

  it('cwd.change during active turn returns success: false, reason: turn_active', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-cwd',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model',
      initialCwd: '/test/cwd1',
    });
    await ctx.agent.init();

    // Set connector to processing state
    ctx.agent.currentConnector.setProcessingState('processing_started');

    const response = await MakaioBus.request(AgentSubjects.cwd.change, {
      agentId: 'test-agent-cwd',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newCwd: '/test/cwd2',
    });

    expect(response.success).toBe(false);
    expect(response.reason).toBe('turn_active');
    expect(ctx.createdConnectors).toHaveLength(1);
    expect(ctx.agent.currentConnector.cwd).toBe('/test/cwd1');
  });

  it('cwd.change with same cwd is a no-op (success: true, no swap)', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'test-agent-cwd',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model',
      initialCwd: '/test/cwd1',
    });
    await ctx.agent.init();

    const initialConnector = ctx.createdConnectors[0];

    // Listen for cwd.changed event
    const changedEvents: Array<{ previousCwd: string; newCwd: string }> = [];
    const unsubChanged = MakaioBus.withFilter({ agentId: 'test-agent-cwd' }).on(AgentSubjects.cwd.changed, (evtCtx) => {
      changedEvents.push({ previousCwd: evtCtx.payload.previousCwd, newCwd: evtCtx.payload.newCwd });
    });
    ctx.cleanupFns.push(unsubChanged);

    // Request same CWD
    const response = await MakaioBus.request(AgentSubjects.cwd.change, {
      agentId: 'test-agent-cwd',
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newCwd: '/test/cwd1',
    });

    expect(response.success).toBe(true);
    expect(ctx.createdConnectors).toHaveLength(1);
    expect(initialConnector.closeCalled).toBe(false);
    expect(ctx.agent.currentConnector).toBe(initialConnector);
    expect(changedEvents).toHaveLength(0);
  });
});
