import { describe, expect, it } from 'vitest';
import type { SpanDraft } from '../contracts/types.js';
import { SpanCollector, type AgentUsagePayload } from '../collector/span-collector.js';

describe('SpanCollector', () => {
  it('buffers agent usage until frame.sessionLinked arrives', async () => {
    const exported: SpanDraft[][] = [];
    const collector = new SpanCollector({
      now: () => 10_000,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-1', workflowId: 'wf-1' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-1',
        frameId: 'frame-analyze',
        nodeId: 'analyze',
        nodeType: 'station',
        path: ['frame-analyze'],
      },
      1100,
    );
    collector.onAgentUsage({
      agentId: 'review-agent',
      adapterId: 'adapter-instance-1',
      adapterName: 'claude-code',
      sessionId: 'sess-child',
      adapterSessionId: 'native-session-1',
      messageId: 'message-1',
      turnId: 'turn-1',
      clientId: 'claude-code',
      providerConfigId: 'anthropic-oauth',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 10,
      inputCachedTokens: 0,
      cacheWriteTokens: 4,
      outputTokens: 20,
      reasoningTokens: 3,
      totalTokens: 33,
      costUnits: 33,
      costUnitType: 'tokens',
      cost: 0.0123,
      currency: 'USD',
      costProvenance: 'estimated',
      duration: 250,
    });
    collector.onFrameSessionLinked({
      executionId: 'wfx-1',
      frameId: 'frame-analyze',
      sessionId: 'sess-child',
    });
    await collector.onExecutionCompleted({ executionId: 'wfx-1', totalDuration: 1000 }, 2000);

    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'LLM call gpt-5.4',
          parentSpanId: 'frame:wfx-1:frame-analyze',
          attributes: expect.objectContaining({
            'llm.model': 'gpt-5.4',
            'llm.provider': 'openai',
            'llm.tokens.input': 10,
            'llm.tokens.cached_input': 0,
            'llm.tokens.cache_write': 4,
            'llm.tokens.output': 20,
            'llm.tokens.reasoning': 3,
            'llm.cost.estimated': 0.0123,
            'llm.cost.currency': 'USD',
            'llm.cost.provenance': 'estimated',
            'llm.cost.units': 33,
            'llm.cost.unit_type': 'tokens',
            'llm.duration_ms': 250,
            'makaio.agent.id': 'review-agent',
            'makaio.adapter.id': 'adapter-instance-1',
            'makaio.adapter.name': 'claude-code',
            'makaio.adapter.session_id': 'native-session-1',
            'makaio.message.id': 'message-1',
            'makaio.turn.id': 'turn-1',
            'makaio.client.id': 'claude-code',
            'makaio.provider.config_id': 'anthropic-oauth',
          }),
        }),
      ]),
    );
  });

  it('buffers agent usage by session until a later frame link when multiple executions are open', async () => {
    const exported: SpanDraft[][] = [];
    const nowMs = 1200;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-a', workflowId: 'wf-a' }, 1000);
    await collector.onExecutionStarted({ executionId: 'wfx-b', workflowId: 'wf-b' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-a',
        frameId: 'frame-a',
        nodeId: 'node-a',
        nodeType: 'station',
        path: ['frame-a'],
      },
      1100,
    );
    collector.onFrameStarted(
      {
        executionId: 'wfx-b',
        frameId: 'frame-b',
        nodeId: 'node-b',
        nodeType: 'station',
        path: ['frame-b'],
      },
      1100,
    );

    collector.onAgentUsage({
      sessionId: 'sess-a',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 10,
      inputCachedTokens: 1,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 31,
      costUnits: 31,
      costUnitType: 'tokens',
    });

    collector.onFrameSessionLinked({ executionId: 'wfx-a', frameId: 'frame-a', sessionId: 'sess-a' });
    await collector.onExecutionCompleted({ executionId: 'wfx-a', totalDuration: 1000 }, 2000);
    await collector.onExecutionCompleted({ executionId: 'wfx-b', totalDuration: 1000 }, 2000);

    const wfxA = exported.find((drafts) => drafts.some((draft) => draft.spanId === 'execution:wfx-a'));
    const wfxB = exported.find((drafts) => drafts.some((draft) => draft.spanId === 'execution:wfx-b'));
    expect(wfxA).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: 'llm:wfx-a:sess-a:0',
          parentSpanId: 'frame:wfx-a:frame-a',
        }),
      ]),
    );
    expect(wfxB?.some((draft) => draft.name === 'LLM call gpt-5.4')).toBe(false);
  });

  it('uses explicit request correlation without waiting for frame.sessionLinked', async () => {
    const exported: SpanDraft[][] = [];
    let now = 1500;
    const collector = new SpanCollector({
      now: () => now,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-direct', workflowId: 'wf-1' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-direct',
        frameId: 'frame-direct',
        nodeId: 'review',
        nodeType: 'station',
        path: ['frame-direct'],
      },
      1100,
    );
    collector.onAgentUsage({
      llmCallId: 'call-direct',
      executionId: 'wfx-direct',
      frameId: 'frame-direct',
      sessionId: 'session-direct',
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 10,
      inputCachedTokens: 2,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 15,
      costUnits: 15,
      costUnitType: 'tokens',
    });
    now = 40_000;
    await collector.sweepOrphans();
    expect(exported).toHaveLength(0);
    await collector.onExecutionCompleted({ executionId: 'wfx-direct', totalDuration: 1000 }, 2000);

    const usage = exported[0]?.find((draft) => draft.subject === 'usage');
    expect(usage).toMatchObject({
      parentSpanId: 'frame:wfx-direct:frame-direct',
      attributes: expect.objectContaining({ 'makaio.llm_call.id': 'call-direct' }),
    });
  });

  it('uses agent usage occurredAt as the LLM span end time', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 2100;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-usage-time', workflowId: 'wf-usage-time' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-usage-time',
        frameId: 'frame-usage-time',
        nodeId: 'node-usage-time',
        nodeType: 'station',
        path: ['frame-usage-time'],
      },
      1000,
    );
    collector.onFrameSessionLinked({
      executionId: 'wfx-usage-time',
      frameId: 'frame-usage-time',
      sessionId: 'sess-usage-time',
    });
    collector.onAgentUsage({
      sessionId: 'sess-usage-time',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 10,
      inputCachedTokens: 1,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 31,
      costUnits: 31,
      costUnitType: 'tokens',
      duration: 1000,
      occurredAt: 2000,
    });

    nowMs = 2100;
    await collector.onExecutionCompleted({ executionId: 'wfx-usage-time', totalDuration: 1100 }, 2100);

    const llmSpan = exported[0]?.find((draft) => draft.spanId === 'llm:wfx-usage-time:sess-usage-time:0');
    expect(llmSpan).toEqual(
      expect.objectContaining({
        startedAt: 1000,
        endedAt: 2000,
      }),
    );
  });

  it('keeps sessioned usage until a delayed frame link can replay it within the timeout', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1200;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-delayed-link', workflowId: 'wf-delayed-link' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-delayed-link',
        frameId: 'frame-delayed-link',
        nodeId: 'node-delayed-link',
        nodeType: 'delegate-role',
        path: ['frame-delayed-link'],
      },
      1100,
    );
    collector.onAgentUsage({
      sessionId: 'sess-delayed',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 10,
      inputCachedTokens: 1,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 31,
      costUnits: 31,
      costUnitType: 'tokens',
      duration: 1000,
      occurredAt: 2000,
    });

    nowMs = 4000;
    await collector.sweepOrphans();
    collector.onFrameSessionLinked({
      executionId: 'wfx-delayed-link',
      frameId: 'frame-delayed-link',
      sessionId: 'sess-delayed',
    });
    await collector.onExecutionCompleted({ executionId: 'wfx-delayed-link', totalDuration: 3000 }, 4000);

    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: 'llm:wfx-delayed-link:sess-delayed:0',
          parentSpanId: 'frame:wfx-delayed-link:frame-delayed-link',
        }),
      ]),
    );
  });

  it('exports stale unlinked session events once and does not re-parent them after the timeout', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1200;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-stale-session', workflowId: 'wf-stale-session' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-stale-session',
        frameId: 'frame-stale-session',
        nodeId: 'node-stale-session',
        nodeType: 'delegate-role',
        path: ['frame-stale-session'],
      },
      1100,
    );
    collector.onAgentUsage({
      sessionId: 'sess-stale',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 10,
      inputCachedTokens: 1,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 31,
      costUnits: 31,
      costUnitType: 'tokens',
    });
    collector.onAgentToolStarted({ sessionId: 'sess-stale', toolName: 'read', toolCallId: 'call-stale' });

    nowMs = 7000;
    await collector.sweepOrphans();
    collector.onFrameSessionLinked({
      executionId: 'wfx-stale-session',
      frameId: 'frame-stale-session',
      sessionId: 'sess-stale',
    });
    await collector.onExecutionCompleted({ executionId: 'wfx-stale-session', totalDuration: 6000 }, 7000);

    expect(exported).toHaveLength(2);
    expect(exported[0]?.some((draft) => draft.subject === 'usage')).toBe(true);
    expect(exported[0]?.some((draft) => draft.subject === 'tool')).toBe(true);
    expect(exported[1]?.some((draft) => draft.spanId.startsWith('llm:wfx-stale-session'))).toBe(false);
    expect(exported[1]?.some((draft) => draft.spanId.startsWith('tool:wfx-stale-session'))).toBe(false);
  });

  it('expires unresolved session events individually while preserving fresh events for a late link', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1000;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-partial-expiry', workflowId: 'wf-partial-expiry' }, 500);
    collector.onFrameStarted(
      {
        executionId: 'wfx-partial-expiry',
        frameId: 'frame-partial-expiry',
        nodeId: 'review',
        nodeType: 'station',
        path: ['frame-partial-expiry'],
      },
      600,
    );
    collector.onAgentUsage({
      sessionId: 'sess-partial-expiry',
      provider: 'openai',
      model: 'old-model',
      inputTokens: 10,
      inputCachedTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 15,
      costUnits: 15,
      costUnitType: 'tokens',
    });
    nowMs = 4000;
    collector.onAgentUsage({
      sessionId: 'sess-partial-expiry',
      provider: 'openai',
      model: 'fresh-model',
      inputTokens: 20,
      inputCachedTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
      totalTokens: 30,
      costUnits: 30,
      costUnitType: 'tokens',
    });

    nowMs = 7000;
    await collector.sweepOrphans();
    collector.onFrameSessionLinked({
      executionId: 'wfx-partial-expiry',
      frameId: 'frame-partial-expiry',
      sessionId: 'sess-partial-expiry',
    });
    await collector.onExecutionCompleted({ executionId: 'wfx-partial-expiry', totalDuration: 6500 }, 7000);

    expect(exported).toHaveLength(2);
    expect(exported[0]?.some((draft) => draft.name === 'LLM call old-model')).toBe(true);
    expect(exported[0]?.some((draft) => draft.name === 'LLM call fresh-model')).toBe(false);
    expect(exported[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'LLM call fresh-model',
          parentSpanId: 'frame:wfx-partial-expiry:frame-partial-expiry',
        }),
      ]),
    );
    expect(exported[1]?.some((draft) => draft.name === 'LLM call old-model')).toBe(false);
  });

  it('defers usage to its explicit execution instead of a session-linked execution', async () => {
    const exported: SpanDraft[][] = [];
    const collector = new SpanCollector({
      now: () => 1500,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-session-owner', workflowId: 'wf-session-owner' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-session-owner',
        frameId: 'frame-session-owner',
        nodeId: 'owner',
        nodeType: 'station',
        path: ['frame-session-owner'],
      },
      1100,
    );
    collector.onFrameSessionLinked({
      executionId: 'wfx-session-owner',
      frameId: 'frame-session-owner',
      sessionId: 'sess-shared',
    });
    collector.onAgentUsage({
      llmCallId: 'call-explicit',
      executionId: 'wfx-explicit-owner',
      frameId: 'frame-explicit-owner',
      sessionId: 'sess-shared',
      provider: 'anthropic',
      model: 'claude-explicit',
      inputTokens: 10,
      inputCachedTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 15,
      costUnits: 15,
      costUnitType: 'tokens',
    });
    await collector.onExecutionCompleted({ executionId: 'wfx-session-owner', totalDuration: 1000 }, 2000);

    await collector.onExecutionStarted({ executionId: 'wfx-explicit-owner', workflowId: 'wf-explicit-owner' }, 2100);
    collector.onFrameStarted(
      {
        executionId: 'wfx-explicit-owner',
        frameId: 'frame-explicit-owner',
        nodeId: 'explicit',
        nodeType: 'station',
        path: ['frame-explicit-owner'],
      },
      2200,
    );
    await collector.onExecutionCompleted({ executionId: 'wfx-explicit-owner', totalDuration: 1000 }, 3100);

    expect(exported).toHaveLength(2);
    expect(exported[0]?.some((draft) => draft.subject === 'usage')).toBe(false);
    expect(exported[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'LLM call claude-explicit',
          parentSpanId: 'frame:wfx-explicit-owner:frame-explicit-owner',
          attributes: expect.objectContaining({
            'makaio.execution.id': 'wfx-explicit-owner',
            'makaio.llm_call.id': 'call-explicit',
          }),
        }),
      ]),
    );
  });

  it('does not attach an unknown session to the only open execution', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1200;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-single', workflowId: 'wf-single' }, 1000);
    collector.onAgentUsage({
      sessionId: 'sess-foreign',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 10,
      inputCachedTokens: 1,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 31,
      costUnits: 31,
      costUnitType: 'tokens',
    });

    nowMs = 7000;
    await collector.sweepOrphans();
    await collector.onExecutionCompleted({ executionId: 'wfx-single', totalDuration: 6000 }, 7000);

    expect(exported).toHaveLength(2);
    expect(exported[0]?.some((draft) => draft.name === 'LLM call gpt-5.4')).toBe(true);
    expect(exported[1]?.some((draft) => draft.name === 'LLM call gpt-5.4')).toBe(false);
  });

  it('correlates agent tool spans by session and tool call id', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1200;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-tool', workflowId: 'wf-tool' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-tool',
        frameId: 'frame-tool',
        nodeId: 'node-tool',
        nodeType: 'station',
        path: ['frame-tool'],
      },
      1100,
    );
    collector.onFrameSessionLinked({ executionId: 'wfx-tool', frameId: 'frame-tool', sessionId: 'sess-tool' });
    collector.onAgentToolStarted({ sessionId: 'sess-tool', toolName: 'read', toolCallId: 'call-1' });
    nowMs = 1400;
    collector.onAgentToolCompleted({
      sessionId: 'sess-tool',
      toolName: 'read',
      toolCallId: 'call-1',
      success: true,
    });
    await collector.onExecutionCompleted({ executionId: 'wfx-tool', totalDuration: 1000 }, 2000);

    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: 'tool:wfx-tool:sess-tool:call-1',
          parentSpanId: 'frame:wfx-tool:frame-tool',
          attributes: expect.objectContaining({
            'tool.name': 'read',
            'tool.call_id': 'call-1',
            'tool.success': true,
          }),
        }),
      ]),
    );
  });

  it('uses tool event occurredAt timestamps when replaying a delayed frame link', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 5000;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-tool-time', workflowId: 'wf-tool-time' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-tool-time',
        frameId: 'frame-tool-time',
        nodeId: 'node-tool-time',
        nodeType: 'station',
        path: ['frame-tool-time'],
      },
      1100,
    );
    collector.onAgentToolStarted({
      sessionId: 'sess-tool-time',
      toolName: 'read',
      toolCallId: 'call-time',
      occurredAt: 1200,
    });
    nowMs = 6000;
    collector.onAgentToolCompleted({
      sessionId: 'sess-tool-time',
      toolName: 'read',
      toolCallId: 'call-time',
      success: true,
      occurredAt: 1500,
    });
    collector.onFrameSessionLinked({
      executionId: 'wfx-tool-time',
      frameId: 'frame-tool-time',
      sessionId: 'sess-tool-time',
    });
    await collector.onExecutionCompleted({ executionId: 'wfx-tool-time', totalDuration: 6000 }, 7000);

    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: 'tool:wfx-tool-time:sess-tool-time:call-time',
          startedAt: 1200,
          endedAt: 1500,
        }),
      ]),
    );
  });

  it('preserves completed tool state when the start event arrives late', async () => {
    const exported: SpanDraft[][] = [];
    const collector = new SpanCollector({
      now: () => 5000,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-tool-late-start', workflowId: 'wf-tool-late-start' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-tool-late-start',
        frameId: 'frame-tool-late-start',
        nodeId: 'node-tool-late-start',
        nodeType: 'station',
        path: ['frame-tool-late-start'],
      },
      1100,
    );
    collector.onFrameSessionLinked({
      executionId: 'wfx-tool-late-start',
      frameId: 'frame-tool-late-start',
      sessionId: 'sess-tool-late-start',
    });
    collector.onAgentToolCompleted({
      sessionId: 'sess-tool-late-start',
      toolName: 'read',
      toolCallId: 'call-late-start',
      success: true,
      occurredAt: 1500,
    });
    collector.onAgentToolStarted({
      sessionId: 'sess-tool-late-start',
      toolName: 'read',
      toolCallId: 'call-late-start',
      occurredAt: 1200,
    });

    await collector.onExecutionCompleted({ executionId: 'wfx-tool-late-start', totalDuration: 6000 }, 7000);

    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: 'tool:wfx-tool-late-start:sess-tool-late-start:call-late-start',
          startedAt: 1200,
          endedAt: 1500,
          attributes: expect.objectContaining({
            'tool.success': true,
          }),
        }),
      ]),
    );
  });

  it('preserves unresolved completed tool state when the start event arrives before session link', async () => {
    const exported: SpanDraft[][] = [];
    const collector = new SpanCollector({
      now: () => 5000,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted(
      { executionId: 'wfx-tool-unresolved-late-start', workflowId: 'wf-tool-unresolved-late-start' },
      1000,
    );
    collector.onFrameStarted(
      {
        executionId: 'wfx-tool-unresolved-late-start',
        frameId: 'frame-tool-unresolved-late-start',
        nodeId: 'node-tool-unresolved-late-start',
        nodeType: 'station',
        path: ['frame-tool-unresolved-late-start'],
      },
      1100,
    );
    collector.onAgentToolCompleted({
      sessionId: 'sess-tool-unresolved-late-start',
      toolName: 'read',
      toolCallId: 'call-unresolved-late-start',
      success: true,
      occurredAt: 1500,
    });
    collector.onAgentToolStarted({
      sessionId: 'sess-tool-unresolved-late-start',
      toolName: 'read',
      toolCallId: 'call-unresolved-late-start',
      occurredAt: 1200,
    });
    collector.onFrameSessionLinked({
      executionId: 'wfx-tool-unresolved-late-start',
      frameId: 'frame-tool-unresolved-late-start',
      sessionId: 'sess-tool-unresolved-late-start',
    });

    await collector.onExecutionCompleted({ executionId: 'wfx-tool-unresolved-late-start', totalDuration: 6000 }, 7000);

    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: 'tool:wfx-tool-unresolved-late-start:sess-tool-unresolved-late-start:call-unresolved-late-start',
          startedAt: 1200,
          endedAt: 1500,
          attributes: expect.objectContaining({
            'tool.success': true,
          }),
        }),
      ]),
    );
  });

  it('flushes on execution.failed', async () => {
    const exported: SpanDraft[][] = [];
    const collector = new SpanCollector({
      now: () => 5_000,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-fail', workflowId: 'wf-2' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-fail',
        frameId: 'frame-1',
        nodeId: 'node-1',
        nodeType: 'station',
        path: ['frame-1'],
      },
      1100,
    );
    await collector.onExecutionFailed({ executionId: 'wfx-fail', error: 'Something went wrong' }, 3000);

    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: 'execution:wfx-fail',
          name: 'Workflow wfx-fail',
          status: 'error',
        }),
      ]),
    );
  });

  it('flushes on execution.cancelled', async () => {
    const exported: SpanDraft[][] = [];
    const collector = new SpanCollector({
      now: () => 5_000,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-cancel', workflowId: 'wf-3' }, 1000);
    await collector.onExecutionCancelled({ executionId: 'wfx-cancel' }, 4000);

    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: 'execution:wfx-cancel',
          name: 'Workflow wfx-cancel',
          status: 'error',
        }),
      ]),
    );
  });

  it('creates orphan agent spans after orphan timeout', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1000;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-orphan', workflowId: 'wf-4' }, 1000);
    // Usage arrives with no sessionId → orphan immediately
    collector.onAgentUsage({
      provider: 'anthropic',
      model: 'claude-opus',
      inputTokens: 5,
      inputCachedTokens: 0,
      outputTokens: 8,
      reasoningTokens: 0,
      totalTokens: 13,
      costUnits: 13,
      costUnitType: 'tokens',
    });

    // Advance time past orphan timeout and sweep
    nowMs = 7_000;
    await collector.sweepOrphans();
    await collector.onExecutionCompleted({ executionId: 'wfx-orphan', totalDuration: 6000 }, 7000);

    const allDrafts = exported.flat();
    const orphanSpan = allDrafts.find((d) => d.attributes['correlation.orphaned'] === true);
    expect(orphanSpan).toBeDefined();
    expect(orphanSpan?.name).toBe('LLM call claude-opus');
  });

  it('creates orphan tool spans for sessionless tool events on the only open execution', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1000;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-tool-orphan', workflowId: 'wf-tool-orphan' }, 1000);
    collector.onAgentToolStarted({ toolName: 'read', toolCallId: 'call-orphan', occurredAt: 1200 });
    collector.onAgentToolCompleted({
      toolName: 'read',
      toolCallId: 'call-orphan',
      success: true,
      occurredAt: 1500,
    });

    nowMs = 7_000;
    await collector.sweepOrphans();
    await collector.onExecutionCompleted({ executionId: 'wfx-tool-orphan', totalDuration: 6000 }, 7000);

    const orphanSpan = exported.flat().find((draft) => draft.spanId === 'tool:wfx-tool-orphan:unknown:call-orphan');
    expect(orphanSpan).toEqual(
      expect.objectContaining({
        parentSpanId: undefined,
        startedAt: 1200,
        endedAt: 1500,
        attributes: expect.objectContaining({
          'correlation.orphaned': true,
          'tool.success': true,
        }),
      }),
    );
  });

  it('ages tool orphan sweeps from ingestion time, not source start time', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 10_000;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-tool-ingested', workflowId: 'wf-tool-ingested' }, 1000);
    collector.onAgentToolStarted({ toolName: 'read', toolCallId: 'call-ingested', occurredAt: 1200 });

    nowMs = 12_000;
    await collector.sweepOrphans();

    expect(exported).toHaveLength(0);
  });

  it('keeps active executions open during orphan sweep', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1000;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-stale', workflowId: 'wf-stale' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-stale',
        frameId: 'frame-stale',
        nodeId: 'node-stale',
        nodeType: 'station',
        path: ['frame-stale'],
      },
      1100,
    );

    nowMs = 6_000;
    await collector.sweepOrphans();
    await collector.onExecutionCompleted({ executionId: 'wfx-stale', totalDuration: 5000 }, 6000);

    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ spanId: 'execution:wfx-stale', status: 'ok', endedAt: 6000 }),
        expect.objectContaining({ spanId: 'frame:wfx-stale:frame-stale', status: 'ok', endedAt: 6000 }),
      ]),
    );
  });

  it('disables timeout-based orphan promotion when orphanTimeoutMs is zero', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1000;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 0,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-no-timeout', workflowId: 'wf-no-timeout' }, 1000);
    collector.onAgentUsage({
      provider: 'anthropic',
      model: 'claude-opus',
      inputTokens: 5,
      inputCachedTokens: 0,
      outputTokens: 8,
      reasoningTokens: 0,
      totalTokens: 13,
      costUnits: 13,
      costUnitType: 'tokens',
    });

    nowMs = 60_000;
    await collector.sweepOrphans();
    expect(exported).toHaveLength(0);

    await collector.onExecutionCompleted({ executionId: 'wfx-no-timeout', totalDuration: 59000 }, 60_000);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ spanId: 'execution:wfx-no-timeout', status: 'ok' }),
        expect.objectContaining({
          spanId: 'llm:wfx-no-timeout:unknown:0',
          attributes: expect.objectContaining({ 'correlation.orphaned': true }),
        }),
      ]),
    );
  });

  it('retains unlinked session events for a late frame link when orphanTimeoutMs is zero', async () => {
    const exported: SpanDraft[][] = [];
    const collector = new SpanCollector({
      now: () => 60_000,
      orphanTimeoutMs: 0,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-zero-session', workflowId: 'wf-zero-session' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-zero-session',
        frameId: 'frame-zero-session',
        nodeId: 'node-zero-session',
        nodeType: 'delegate-role',
        path: ['frame-zero-session'],
      },
      1100,
    );
    collector.onAgentUsage({
      sessionId: 'sess-zero',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 10,
      inputCachedTokens: 1,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 31,
      costUnits: 31,
      costUnitType: 'tokens',
    });
    collector.onAgentToolStarted({ sessionId: 'sess-zero', toolName: 'read', toolCallId: 'call-zero' });

    await collector.sweepOrphans();
    collector.onFrameSessionLinked({
      executionId: 'wfx-zero-session',
      frameId: 'frame-zero-session',
      sessionId: 'sess-zero',
    });
    await collector.onExecutionCompleted({ executionId: 'wfx-zero-session', totalDuration: 59000 }, 60_000);

    expect(exported[0]?.some((draft) => draft.spanId.startsWith('llm:wfx-zero-session'))).toBe(true);
    expect(exported[0]?.some((draft) => draft.spanId.startsWith('tool:wfx-zero-session'))).toBe(true);
  });

  it('exports unlinked local sessions as standalone trace segments after the correlation timeout', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1000;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    collector.onAgentUsage({
      agentId: 'local-agent',
      adapterId: 'local-adapter-1',
      adapterName: 'claude-code',
      clientId: 'claude-code',
      sessionId: 'sess-local',
      adapterSessionId: 'native-local',
      providerConfigId: 'anthropic-oauth',
      turnId: 'turn-local',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 10,
      inputCachedTokens: 5,
      outputTokens: 4,
      reasoningTokens: 0,
      totalTokens: 14,
      costUnits: 14,
      costUnitType: 'tokens',
      occurredAt: 1200,
      duration: 200,
    });
    collector.onAgentToolStarted({
      sessionId: 'sess-local',
      toolName: 'read',
      toolCallId: 'call-local',
      occurredAt: 1250,
    });
    collector.onAgentToolCompleted({
      sessionId: 'sess-local',
      toolName: 'read',
      toolCallId: 'call-local',
      success: true,
      occurredAt: 1300,
    });

    nowMs = 7_000;
    await collector.sweepOrphans();
    await collector.sweepOrphans();

    expect(exported).toHaveLength(1);
    const [root, llm, tool] = exported[0] ?? [];
    expect(root).toMatchObject({
      sessionId: 'sess-local',
      subject: 'session',
      attributes: expect.objectContaining({ 'makaio.trace.scope': 'standalone' }),
    });
    expect(root?.executionId).toBeUndefined();
    expect(llm).toMatchObject({
      parentSpanId: root?.spanId,
      subject: 'usage',
      attributes: expect.objectContaining({
        'makaio.client.id': 'claude-code',
        'makaio.provider.config_id': 'anthropic-oauth',
      }),
    });
    expect(llm?.executionId).toBeUndefined();
    expect(tool).toMatchObject({
      parentSpanId: root?.spanId,
      subject: 'tool',
    });
    expect(tool?.executionId).toBeUndefined();
  });

  it('retries stale standalone usage and tools after a transient export failure', async () => {
    const exported: SpanDraft[][] = [];
    const attemptedRootSpanIds: string[] = [];
    let nowMs = 1_000;
    let attempts = 0;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        attempts += 1;
        const root = drafts.find((draft) => draft.subject === 'session');
        if (root !== undefined) attemptedRootSpanIds.push(root.spanId);
        if (attempts === 1) throw new Error('transient export failure');
        exported.push(drafts);
      },
    });

    collector.onAgentUsage({
      sessionId: 'sess-retry-local',
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 10,
      inputCachedTokens: 5,
      outputTokens: 4,
      reasoningTokens: 0,
      totalTokens: 14,
      costUnits: 14,
      costUnitType: 'tokens',
    });
    collector.onAgentToolStarted({
      sessionId: 'sess-retry-local',
      toolName: 'read',
      toolCallId: 'call-retry-local',
      occurredAt: 1_100,
    });
    collector.onAgentToolCompleted({
      sessionId: 'sess-retry-local',
      toolName: 'read',
      toolCallId: 'call-retry-local',
      success: true,
      occurredAt: 1_200,
    });

    nowMs = 6_000;
    await expect(collector.sweepOrphans()).rejects.toThrow('transient export failure');
    await expect(collector.sweepOrphans()).resolves.toBeUndefined();
    await collector.sweepOrphans();

    expect(attempts).toBe(2);
    expect(attemptedRootSpanIds).toEqual(['session:sess-retry-local:0', 'session:sess-retry-local:0']);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: 'session', sessionId: 'sess-retry-local' }),
        expect.objectContaining({ subject: 'usage', sessionId: 'sess-retry-local' }),
        expect.objectContaining({
          subject: 'tool',
          sessionId: 'sess-retry-local',
          endedAt: 1_200,
          attributes: expect.objectContaining({ 'tool.success': true }),
        }),
      ]),
    );
  });

  it('retries stale usage whose claimed execution never opens without changing span identity', async () => {
    const exported: SpanDraft[][] = [];
    const attemptedRootSpanIds: string[] = [];
    let nowMs = 1_000;
    let attempts = 0;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        attempts += 1;
        const root = drafts.find((draft) => draft.subject === 'session');
        if (root !== undefined) attemptedRootSpanIds.push(root.spanId);
        if (attempts === 1) throw new Error('unopened execution export failure');
        exported.push(drafts);
      },
    });

    collector.onAgentUsage({
      executionId: 'wfx-never-opened',
      sessionId: 'sess-unopened-retry',
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 10,
      inputCachedTokens: 5,
      outputTokens: 4,
      reasoningTokens: 0,
      totalTokens: 14,
      costUnits: 14,
      costUnitType: 'tokens',
    });

    nowMs = 6_000;
    await expect(collector.sweepOrphans()).rejects.toThrow('unopened execution export failure');
    await expect(collector.sweepOrphans()).resolves.toBeUndefined();
    await collector.sweepOrphans();

    expect(attempts).toBe(2);
    expect(attemptedRootSpanIds).toEqual(['session:sess-unopened-retry:0', 'session:sess-unopened-retry:0']);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: 'session', sessionId: 'sess-unopened-retry' }),
        expect.objectContaining({ subject: 'usage', sessionId: 'sess-unopened-retry' }),
      ]),
    );
  });

  it('restores only unexported execution groups and preserves the failed group segment', async () => {
    const attemptedRootSpanIds: string[] = [];
    const exportedSessions: string[] = [];
    let nowMs = 1_000;
    let attempts = 0;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        attempts += 1;
        const root = drafts.find((draft) => draft.subject === 'session');
        if (root !== undefined) attemptedRootSpanIds.push(root.spanId);
        if (attempts === 2) throw new Error('second group failed');
        if (root?.sessionId !== undefined) exportedSessions.push(root.sessionId);
      },
    });
    const usage = (sessionId: string): AgentUsagePayload => ({
      executionId: 'wfx-multi-group',
      sessionId,
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 1,
      inputCachedTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
      costUnits: 2,
      costUnitType: 'tokens',
    });

    collector.onAgentUsage(usage('sess-a'));
    collector.onAgentUsage(usage('sess-b'));
    nowMs = 6_000;

    await expect(collector.sweepOrphans()).rejects.toThrow('second group failed');
    await expect(collector.sweepOrphans()).resolves.toBeUndefined();

    expect(attemptedRootSpanIds).toEqual(['session:sess-a:0', 'session:sess-b:1', 'session:sess-b:1']);
    expect(exportedSessions).toEqual(['sess-a', 'sess-b']);
  });

  it('coalesces concurrent sweeps so new arrivals receive a fresh segment', async () => {
    const attemptedRootSpanIds: string[] = [];
    let nowMs = 1_000;
    let releaseFirstExport = (): void => {};
    let markFirstExportStarted = (): void => {};
    const firstExportGate = new Promise<void>((resolve) => {
      releaseFirstExport = resolve;
    });
    const firstExportStarted = new Promise<void>((resolve) => {
      markFirstExportStarted = resolve;
    });
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        const root = drafts.find((draft) => draft.subject === 'session');
        if (root !== undefined) attemptedRootSpanIds.push(root.spanId);
        if (attemptedRootSpanIds.length === 1) {
          markFirstExportStarted();
          await firstExportGate;
        }
      },
    });
    const usage = (): AgentUsagePayload => ({
      executionId: 'wfx-concurrent-sweep',
      sessionId: 'sess-concurrent-sweep',
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 1,
      inputCachedTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
      costUnits: 2,
      costUnitType: 'tokens',
    });

    collector.onAgentUsage(usage());
    nowMs = 6_000;
    const firstSweep = collector.sweepOrphans();
    await firstExportStarted;
    collector.onAgentUsage(usage());
    nowMs = 11_000;
    const overlappingSweep = collector.sweepOrphans();

    expect(overlappingSweep).toBe(firstSweep);
    expect(attemptedRootSpanIds).toEqual(['session:sess-concurrent-sweep:0']);
    releaseFirstExport();
    await firstSweep;
    await collector.sweepOrphans();

    expect(attemptedRootSpanIds).toEqual(['session:sess-concurrent-sweep:0', 'session:sess-concurrent-sweep:1']);
  });

  it('replays a failed standalone batch when its claimed execution opens during export', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1_000;
    let rejectFirstExport = (_error: Error): void => {};
    let markFirstExportStarted = (): void => {};
    const firstExportGate = new Promise<void>((_resolve, reject) => {
      rejectFirstExport = reject;
    });
    const firstExportStarted = new Promise<void>((resolve) => {
      markFirstExportStarted = resolve;
    });
    let attempts = 0;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        attempts += 1;
        if (attempts === 1) {
          markFirstExportStarted();
          await firstExportGate;
        }
        exported.push(drafts);
      },
    });

    collector.onAgentUsage({
      executionId: 'wfx-opens-during-export',
      sessionId: 'sess-opens-during-export',
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 1,
      inputCachedTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
      costUnits: 2,
      costUnitType: 'tokens',
    });
    nowMs = 6_000;
    const sweep = collector.sweepOrphans();
    await firstExportStarted;
    collector.onExecutionStarted({ executionId: 'wfx-opens-during-export', workflowId: 'wf-test' }, nowMs);
    rejectFirstExport(new Error('standalone export failed'));

    await expect(sweep).rejects.toThrow('standalone export failed');
    await collector.onExecutionCompleted({ executionId: 'wfx-opens-during-export', totalDuration: 1 }, nowMs + 1);
    await collector.sweepOrphans();

    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ spanId: 'execution:wfx-opens-during-export' }),
        expect.objectContaining({
          spanId: 'llm:wfx-opens-during-export:sess-opens-during-export:0',
          executionId: 'wfx-opens-during-export',
        }),
      ]),
    );
  });

  it('replays failed standalone usage and tools when the session links during export', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 1_000;
    let rejectFirstExport = (_error: Error): void => {};
    let markFirstExportStarted = (): void => {};
    const firstExportGate = new Promise<void>((_resolve, reject) => {
      rejectFirstExport = reject;
    });
    const firstExportStarted = new Promise<void>((resolve) => {
      markFirstExportStarted = resolve;
    });
    let attempts = 0;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 5_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        attempts += 1;
        if (attempts === 1) {
          markFirstExportStarted();
          await firstExportGate;
        }
        exported.push(drafts);
      },
    });

    collector.onExecutionStarted({ executionId: 'wfx-links-during-export', workflowId: 'wf-test' }, nowMs);
    collector.onFrameStarted(
      {
        executionId: 'wfx-links-during-export',
        frameId: 'frame-links-during-export',
        nodeId: 'delegate',
        nodeType: 'delegate-agent',
        path: ['frame-links-during-export'],
      },
      nowMs,
    );
    collector.onAgentUsage({
      sessionId: 'sess-links-during-export',
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 1,
      inputCachedTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
      costUnits: 2,
      costUnitType: 'tokens',
    });
    collector.onAgentToolStarted({
      sessionId: 'sess-links-during-export',
      toolName: 'read',
      toolCallId: 'call-links-during-export',
    });
    nowMs = 6_000;
    const sweep = collector.sweepOrphans();
    await firstExportStarted;
    collector.onFrameSessionLinked({
      executionId: 'wfx-links-during-export',
      frameId: 'frame-links-during-export',
      sessionId: 'sess-links-during-export',
    });
    rejectFirstExport(new Error('standalone export failed'));

    await expect(sweep).rejects.toThrow('standalone export failed');
    await collector.onExecutionCompleted({ executionId: 'wfx-links-during-export', totalDuration: 1 }, nowMs + 1);
    await collector.sweepOrphans();

    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: 'llm:wfx-links-during-export:sess-links-during-export:0',
          parentSpanId: 'frame:wfx-links-during-export:frame-links-during-export',
        }),
        expect.objectContaining({
          spanId: 'tool:wfx-links-during-export:sess-links-during-export:call-links-during-export',
          parentSpanId: 'frame:wfx-links-during-export:frame-links-during-export',
        }),
      ]),
    );
  });

  it('flushes pending standalone session usage on shutdown when timeout promotion is disabled', async () => {
    const exported: SpanDraft[][] = [];
    const collector = new SpanCollector({
      now: () => 5_000,
      orphanTimeoutMs: 0,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    collector.onAgentUsage({
      sessionId: 'sess-shutdown-local',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 10,
      inputCachedTokens: 1,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 31,
      costUnits: 31,
      costUnitType: 'tokens',
    });

    await collector.flushAll();

    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: 'session', sessionId: 'sess-shutdown-local' }),
        expect.objectContaining({ subject: 'usage', sessionId: 'sess-shutdown-local' }),
      ]),
    );
  });

  it('retries shutdown standalone export after a transient failure', async () => {
    const exported: SpanDraft[][] = [];
    let attempts = 0;
    const collector = new SpanCollector({
      now: () => 5_000,
      orphanTimeoutMs: 0,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        attempts += 1;
        if (attempts === 1) throw new Error('shutdown export failure');
        exported.push(drafts);
      },
    });

    collector.onAgentUsage({
      sessionId: 'sess-shutdown-retry',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 10,
      inputCachedTokens: 1,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 31,
      costUnits: 31,
      costUnitType: 'tokens',
    });

    await expect(collector.flushAll()).resolves.toBeUndefined();
    await collector.flushAll();

    expect(attempts).toBe(2);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: 'session', sessionId: 'sess-shutdown-retry' }),
        expect.objectContaining({ subject: 'usage', sessionId: 'sess-shutdown-retry' }),
      ]),
    );
  });

  it('force-flushes the oldest execution with error status when maxOpenExecutions is reached', async () => {
    const exported: SpanDraft[][] = [];
    let nowMs = 5_000;
    const collector = new SpanCollector({
      now: () => nowMs,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1,
      emit: async (drafts) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        exported.push(drafts);
      },
    });

    // Start first execution (fills the cap)
    await collector.onExecutionStarted({ executionId: 'wfx-evict', workflowId: 'wf-evict' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-evict',
        frameId: 'frame-evict',
        nodeId: 'node-evict',
        nodeType: 'station',
        path: ['frame-evict'],
      },
      1100,
    );

    // Advance clock to eviction time
    nowMs = 9_000;

    // Start second execution — triggers eviction of wfx-evict without waiting for export I/O.
    const eviction = collector.onExecutionStarted({ executionId: 'wfx-new', workflowId: 'wf-new' }, 9000);
    expect(exported).toHaveLength(0);
    await eviction;

    expect(exported).toHaveLength(1);
    const evictedDrafts = exported[0];

    const rootSpan = evictedDrafts.find((d) => d.spanId === 'execution:wfx-evict');
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.status).toBe('error');
    expect(rootSpan?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'evicted',
          attributes: expect.objectContaining({ 'eviction.reason': 'max_open_executions' }),
        }),
      ]),
    );

    const frameSpan = evictedDrafts.find((d) => d.spanId === 'frame:wfx-evict:frame-evict');
    expect(frameSpan).toBeDefined();
    expect(frameSpan?.status).toBe('error');
  });

  it('keeps frame metadata from frame.started when frame.completed lacks nodeType and path', async () => {
    const exported: SpanDraft[][] = [];
    const collector = new SpanCollector({
      now: () => 10_000,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-meta', workflowId: 'wf-5' }, 1000);
    collector.onFrameStarted(
      {
        executionId: 'wfx-meta',
        frameId: 'frame-meta',
        nodeId: 'node-meta',
        nodeType: 'station',
        path: ['frame-meta'],
      },
      1100,
    );
    // frame.completed does NOT have nodeType or path (matches the real schema)
    collector.onFrameCompleted(
      {
        executionId: 'wfx-meta',
        frameId: 'frame-meta',
        nodeId: 'node-meta',
        duration: 500,
      },
      1600,
    );
    await collector.onExecutionCompleted({ executionId: 'wfx-meta', totalDuration: 600 }, 1700);

    const allDrafts = exported.flat();
    const frameSpan = allDrafts.find((d) => d.spanId === 'frame:wfx-meta:frame-meta');
    expect(frameSpan).toBeDefined();
    expect(frameSpan?.attributes['makaio.frame.node_type']).toBe('station');
  });

  it('preserves terminal frame state when frame.completed arrives before frame.started', async () => {
    const exported: SpanDraft[][] = [];
    const collector = new SpanCollector({
      now: () => 10_000,
      orphanTimeoutMs: 30_000,
      maxOpenExecutions: 1000,
      emit: async (drafts) => {
        exported.push(drafts);
      },
    });

    await collector.onExecutionStarted({ executionId: 'wfx-out-of-order', workflowId: 'wf-6' }, 1000);
    collector.onFrameCompleted(
      {
        executionId: 'wfx-out-of-order',
        frameId: 'frame-late-start',
        nodeId: 'node-late-start',
        duration: 400,
      },
      1500,
    );
    collector.onFrameStarted(
      {
        executionId: 'wfx-out-of-order',
        frameId: 'frame-late-start',
        nodeId: 'node-late-start',
        nodeType: 'station',
        path: ['frame-late-start'],
      },
      1100,
    );
    await collector.onExecutionCompleted({ executionId: 'wfx-out-of-order', totalDuration: 700 }, 1700);

    const frameSpan = exported.flat().find((draft) => draft.spanId === 'frame:wfx-out-of-order:frame-late-start');
    expect(frameSpan).toMatchObject({
      status: 'ok',
      startedAt: 1100,
      endedAt: 1500,
      attributes: expect.objectContaining({
        'makaio.frame.node_type': 'station',
      }),
    });
  });
});
