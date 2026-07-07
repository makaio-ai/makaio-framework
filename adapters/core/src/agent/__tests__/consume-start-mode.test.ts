import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type AgentStarted } from '@makaio/contracts';
import { createTestableAgent, createAgentTestLifecycle } from './helpers/mock-agent.js';

describe('AIAgent.emitStart() consume-on-read', () => {
  const ctx = createAgentTestLifecycle();
  const captured: AgentStarted[] = [];
  let unsub: () => void;

  beforeEach(() => {
    ctx.reset();
    captured.length = 0;
    unsub = MakaioBus.on(AgentSubjects.started, (eventCtx) => {
      captured.push(eventCtx.payload);
    });
  });

  afterEach(async () => {
    unsub();
    await ctx.teardown();
  });

  it('first emitStart carries the derived mode, second carries rotation', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'consume-sub-turn',
      mockConnectorFactory: ctx.mockFactory,
    });
    await ctx.agent.initialize();

    // initialize() set pendingStartMode to 'fresh' — first call consumes it
    await ctx.agent.testEmitStart();
    // second call in the same dispatch sees an empty slot → rotation
    await ctx.agent.testEmitStart();

    expect(captured).toHaveLength(2);
    expect(captured[0].startMode).toBe('fresh');
    expect(captured[1].startMode).toBe('rotation');
  });

  it('idle-initialize derived mode is consumed exactly once', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'consume-idle-init',
      mockConnectorFactory: ctx.mockFactory,
    });
    await ctx.agent.initialize({
      sessionContext: {
        isFirstTurn: true,
        nativeFork: {
          sourceSessionId: 'parent',
          sourceAdapterSessionId: 'parent-adapter',
        },
      },
    });

    // initialize() derived 'fork' — consumed by first emitStart
    await ctx.agent.testEmitStart();
    // subsequent calls fall back to rotation
    await ctx.agent.testEmitStart();
    await ctx.agent.testEmitStart();

    expect(captured).toHaveLength(3);
    expect(captured[0].startMode).toBe('fork');
    expect(captured[1].startMode).toBe('rotation');
    expect(captured[2].startMode).toBe('rotation');
  });

  it('emitStart without a preceding setPendingStartMode emits rotation', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'consume-no-pending',
      mockConnectorFactory: ctx.mockFactory,
    });
    await ctx.agent.initialize();

    // Consume the initial mode set by initialize()
    await ctx.agent.testEmitStart();

    // Now the slot is empty — next call should emit rotation
    await ctx.agent.testEmitStart();

    expect(captured).toHaveLength(2);
    expect(captured[1].startMode).toBe('rotation');
  });

  it('setPendingStartMode before each dispatch is consumed independently', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'consume-multi-dispatch',
      mockConnectorFactory: ctx.mockFactory,
    });
    await ctx.agent.initialize();

    // First dispatch: consume initial mode
    await ctx.agent.testEmitStart();
    expect(captured[0].startMode).toBe('fresh');

    // Simulate second dispatch: executor sets mode before dispatch
    ctx.agent.setPendingStartMode('rotation');
    await ctx.agent.testEmitStart();
    expect(captured[1].startMode).toBe('rotation');

    // Sub-turn within second dispatch: slot was consumed
    await ctx.agent.testEmitStart();
    expect(captured[2].startMode).toBe('rotation');
  });
});
