import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestableAgent, createAgentTestLifecycle } from './helpers/mock-agent.js';

describe('AIAgent.initialize() start mode derivation', () => {
  const ctx = createAgentTestLifecycle();

  beforeEach(() => {
    ctx.reset();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it('sets pendingStartMode to "fresh" for idle start without sessionContext', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'init-fresh',
      mockConnectorFactory: ctx.mockFactory,
    });

    const spy = vi.spyOn(ctx.agent, 'setPendingStartMode');
    await ctx.agent.initialize();

    expect(spy).toHaveBeenCalledWith('fresh');
  });

  it('sets pendingStartMode to "fork" when sessionContext carries nativeFork', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'init-fork-ctx',
      mockConnectorFactory: ctx.mockFactory,
    });

    const spy = vi.spyOn(ctx.agent, 'setPendingStartMode');
    await ctx.agent.initialize({
      sessionContext: {
        isFirstTurn: true,
        nativeFork: {
          sourceSessionId: 'parent-session',
          sourceAdapterSessionId: 'parent-adapter-session',
        },
      },
    });

    expect(spy).toHaveBeenCalledWith('fork');
  });

  it('sets pendingStartMode to "fork" from config.nativeFork when sessionContext lacks it', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'init-fork-cfg',
      mockConnectorFactory: ctx.mockFactory,
      nativeFork: {
        sourceSessionId: 'parent-session',
        sourceAdapterSessionId: 'parent-adapter-session',
      },
    });

    const spy = vi.spyOn(ctx.agent, 'setPendingStartMode');
    // Pass sessionContext without nativeFork — config.nativeFork should be used
    await ctx.agent.initialize({ sessionContext: { isFirstTurn: true } });

    expect(spy).toHaveBeenCalledWith('fork');
  });

  it('sets pendingStartMode to "fresh" for first-turn sessionContext without fork', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'init-first-turn',
      mockConnectorFactory: ctx.mockFactory,
    });

    const spy = vi.spyOn(ctx.agent, 'setPendingStartMode');
    await ctx.agent.initialize({
      sessionContext: { isFirstTurn: true },
    });

    expect(spy).toHaveBeenCalledWith('fresh');
  });

  it('sets pendingStartMode to "rotation" for continuation sessionContext', async () => {
    ctx.agent = createTestableAgent({
      agentId: 'init-rotation',
      mockConnectorFactory: ctx.mockFactory,
    });

    const spy = vi.spyOn(ctx.agent, 'setPendingStartMode');
    await ctx.agent.initialize({
      sessionContext: { isFirstTurn: false },
    });

    expect(spy).toHaveBeenCalledWith('rotation');
  });

  it('sets pendingStartMode to "resume" for native attach (resumeAdapterSessionId, no sessionContext)', async () => {
    // Native attach: the agent config carries a resume target but the
    // orchestrator does not supply sessionContext. Before this fix, the
    // absent-context rule returned "fresh" — causing initialization hooks
    // to fire on a resumed conversation.
    ctx.agent = createTestableAgent({
      agentId: 'init-resume-target',
      mockConnectorFactory: ctx.mockFactory,
      resumeAdapterSessionId: 'provider-session-to-resume',
    });

    const spy = vi.spyOn(ctx.agent, 'setPendingStartMode');
    await ctx.agent.initialize();

    expect(spy).toHaveBeenCalledWith('resume');
  });

  it('sets pendingStartMode to "fresh" for sessionless start without resume target (regression guard)', async () => {
    // Sessionless/ephemeral agent: no resume target, no sessionContext.
    // Must stay "fresh" — the earlier round's fix is preserved.
    ctx.agent = createTestableAgent({
      agentId: 'init-sessionless',
      mockConnectorFactory: ctx.mockFactory,
    });

    const spy = vi.spyOn(ctx.agent, 'setPendingStartMode');
    await ctx.agent.initialize();

    expect(spy).toHaveBeenCalledWith('fresh');
  });
});
