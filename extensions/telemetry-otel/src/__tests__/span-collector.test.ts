import { describe, expect, it } from 'vitest';
import type { SpanDraft } from '../contracts/types.js';
import { SpanCollector } from '../collector/span-collector.js';

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
      sessionId: 'sess-child',
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
            'llm.duration_ms': 250,
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

  it('drops stale unlinked session events without exporting them as orphans', async () => {
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

    expect(exported[0]?.some((draft) => draft.spanId.startsWith('llm:wfx-stale-session'))).toBe(false);
    expect(exported[0]?.some((draft) => draft.spanId.startsWith('tool:wfx-stale-session'))).toBe(false);
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

    expect(exported).toHaveLength(1);
    expect(exported[0]?.some((draft) => draft.name === 'LLM call gpt-5.4')).toBe(false);
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

  it('drops unlinked session events on sweep when orphanTimeoutMs is zero', async () => {
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

    expect(exported[0]?.some((draft) => draft.spanId.startsWith('llm:wfx-zero-session'))).toBe(false);
    expect(exported[0]?.some((draft) => draft.spanId.startsWith('tool:wfx-zero-session'))).toBe(false);
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
