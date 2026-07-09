import { describe, expect, it } from 'vitest';
import { SpanBuilder } from '../collector/span-builder.js';

describe('SpanBuilder', () => {
  describe('span ID generation', () => {
    it('generates execution span ID from executionId', () => {
      expect(SpanBuilder.executionSpanId('wfx-abc')).toBe('execution:wfx-abc');
    });

    it('generates frame span ID from executionId and frameId', () => {
      expect(SpanBuilder.frameSpanId('wfx-abc', 'frame-xyz')).toBe('frame:wfx-abc:frame-xyz');
    });

    it('generates LLM span ID from executionId, sessionId, and sequence', () => {
      expect(SpanBuilder.llmSpanId('wfx-abc', 'sess-1', 3)).toBe('llm:wfx-abc:sess-1:3');
    });

    it('generates tool span ID from executionId, sessionId, and toolCallId', () => {
      expect(SpanBuilder.toolSpanId('wfx-abc', 'sess-1', 'call-42')).toBe('tool:wfx-abc:sess-1:call-42');
    });
  });

  describe('buildExecutionSpan', () => {
    it('builds a root execution span with makaio attributes', () => {
      const draft = SpanBuilder.buildExecutionSpan({
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        startedAt: 1000,
        endedAt: 2000,
        status: 'ok',
      });

      expect(draft.spanId).toBe('execution:wfx-1');
      expect(draft.parentSpanId).toBeUndefined();
      expect(draft.executionId).toBe('wfx-1');
      expect(draft.name).toBe('Workflow wfx-1');
      expect(draft.kind).toBe('internal');
      expect(draft.status).toBe('ok');
      expect(draft.startedAt).toBe(1000);
      expect(draft.endedAt).toBe(2000);
      expect(draft.namespace).toBe('workflow');
      expect(draft.subject).toBe('execution');
      expect(draft.attributes['makaio.execution.id']).toBe('wfx-1');
      expect(draft.attributes['makaio.workflow.id']).toBe('wf-1');
      expect(draft.links).toEqual([]);
      expect(draft.events).toEqual([]);
    });
  });

  describe('buildFrameSpan', () => {
    it('builds a frame span with hierarchy and makaio frame attributes', () => {
      const input = {
        executionId: 'wfx-1',
        frameId: 'frame-a',
        nodeId: 'analyze',
        nodeType: 'station',
        path: ['frame-root', 'frame-a'],
        parentFrameId: 'frame-root',
        startedAt: 1100,
        endedAt: 1600,
        status: 'ok' as const,
      };
      const draft = SpanBuilder.buildFrameSpan(input);

      expect(draft.spanId).toBe('frame:wfx-1:frame-a');
      expect(draft.parentSpanId).toBe('frame:wfx-1:frame-root');
      expect(draft.frameId).toBe('frame-a');
      expect(draft.namespace).toBe('workflow');
      expect(draft.subject).toBe('frame');
      expect(draft.kind).toBe('internal');
      expect(draft.attributes['makaio.frame.id']).toBe('frame-a');
      expect(draft.attributes['makaio.frame.node_id']).toBe('analyze');
      expect(draft.attributes['makaio.frame.node_type']).toBe('station');
      expect(draft.attributes['makaio.frame.path']).toEqual(['frame-root', 'frame-a']);
      expect(draft.attributes['workflow.node.id']).toBeUndefined();
    });

    it('maps delegate frame nodes to client spans', () => {
      const input = {
        executionId: 'wfx-1',
        frameId: 'frame-delegate',
        nodeId: 'delegate-node',
        nodeType: 'delegate-role',
        path: ['frame-delegate'],
        parentFrameId: undefined,
        startedAt: 1100,
        endedAt: 1600,
        status: 'ok' as const,
      };
      const draft = SpanBuilder.buildFrameSpan(input);

      expect(draft.parentSpanId).toBe('execution:wfx-1');
      expect(draft.kind).toBe('client');
    });
  });

  describe('buildLlmSpan', () => {
    it('maps usage attributes to llm.* OTel attributes', () => {
      const draft = SpanBuilder.buildLlmSpan({
        executionId: 'wfx-1',
        sessionId: 'sess-1',
        agentId: 'agent-review',
        adapterId: 'adapter-instance-1',
        adapterName: 'claude-code',
        adapterSessionId: 'native-session-1',
        messageId: 'message-1',
        turnId: 'turn-1',
        clientId: 'claude-code',
        providerConfigId: 'anthropic-oauth',
        llmCallId: 'call-1',
        frameId: 'frame-a',
        sequence: 0,
        provider: 'openai',
        model: 'gpt-5.4',
        inputTokens: 10,
        inputCachedTokens: 2,
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
        startedAt: 1200,
        endedAt: 1450,
        orphaned: false,
      });

      expect(draft.spanId).toBe('llm:wfx-1:sess-1:0');
      expect(draft.parentSpanId).toBe('frame:wfx-1:frame-a');
      expect(draft.frameId).toBe('frame-a');
      expect(draft.sessionId).toBe('sess-1');
      expect(draft.namespace).toBe('agent');
      expect(draft.subject).toBe('usage');
      expect(draft.attributes['makaio.llm_call.id']).toBe('call-1');
      expect(draft.attributes['makaio.execution.id']).toBe('wfx-1');
      expect(draft.attributes['makaio.frame.id']).toBe('frame-a');
      expect(draft.attributes['makaio.session.id']).toBe('sess-1');
      expect(draft.name).toBe('LLM call gpt-5.4');
      expect(draft.kind).toBe('client');
      expect(draft.attributes['llm.provider']).toBe('openai');
      expect(draft.attributes['llm.model']).toBe('gpt-5.4');
      expect(draft.attributes['llm.tokens.input']).toBe(10);
      expect(draft.attributes['llm.tokens.cached_input']).toBe(2);
      expect(draft.attributes['llm.tokens.cache_write']).toBe(4);
      expect(draft.attributes['llm.tokens.output']).toBe(20);
      expect(draft.attributes['llm.tokens.reasoning']).toBe(3);
      expect(draft.attributes['llm.tokens.total']).toBe(33);
      expect(draft.attributes['llm.cost.estimated']).toBe(0.0123);
      expect(draft.attributes['llm.cost.currency']).toBe('USD');
      expect(draft.attributes['llm.duration_ms']).toBe(250);
      expect(draft.attributes['makaio.agent.id']).toBe('agent-review');
      expect(draft.attributes['makaio.adapter.id']).toBe('adapter-instance-1');
      expect(draft.attributes['makaio.adapter.name']).toBe('claude-code');
      expect(draft.attributes['makaio.adapter.session_id']).toBe('native-session-1');
      expect(draft.attributes['makaio.message.id']).toBe('message-1');
      expect(draft.attributes['makaio.turn.id']).toBe('turn-1');
      expect(draft.attributes['makaio.client.id']).toBe('claude-code');
      expect(draft.attributes['makaio.provider.config_id']).toBe('anthropic-oauth');
      expect(draft.attributes['llm.cost.units']).toBe(33);
      expect(draft.attributes['llm.cost.unit_type']).toBe('tokens');
      expect(draft.attributes['llm.cost.amount']).toBe(0.0123);
      expect(draft.attributes['llm.cost.provenance']).toBe('estimated');
      expect(draft.attributes['correlation.orphaned']).toBeUndefined();
    });

    it('marks orphaned spans with correlation.orphaned attribute', () => {
      const draft = SpanBuilder.buildLlmSpan({
        executionId: 'wfx-1',
        sessionId: 'sess-orphan',
        frameId: undefined,
        sequence: 0,
        provider: 'anthropic',
        model: 'claude-3',
        inputTokens: 5,
        inputCachedTokens: 0,
        outputTokens: 8,
        reasoningTokens: 0,
        totalTokens: 13,
        costUnits: 13,
        costUnitType: 'tokens',
        startedAt: 1000,
        endedAt: 1000,
        orphaned: true,
      });

      expect(draft.parentSpanId).toBeUndefined();
      expect(draft.attributes['correlation.orphaned']).toBe(true);
    });

    it('does not label provider-reported monetary cost as estimated', () => {
      const draft = SpanBuilder.buildLlmSpan({
        executionId: 'wfx-1',
        sessionId: 'sess-1',
        frameId: 'frame-1',
        sequence: 0,
        provider: 'anthropic',
        model: 'claude-test',
        inputTokens: 10,
        inputCachedTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 15,
        costUnits: 15,
        costUnitType: 'tokens',
        cost: 0.25,
        currency: 'USD',
        costProvenance: 'provider-reported',
        startedAt: 1000,
        endedAt: 1100,
        orphaned: false,
      });

      expect(draft.attributes['llm.cost.amount']).toBe(0.25);
      expect(draft.attributes['llm.cost.estimated']).toBeUndefined();
      expect(draft.attributes['llm.cost.provenance']).toBe('provider-reported');
    });

    it('builds standalone session traces without fabricating a workflow execution', () => {
      const root = SpanBuilder.buildStandaloneSessionSpan({
        sessionId: 'sess-local',
        segment: 4,
        startedAt: 1000,
        endedAt: 1500,
      });
      const llm = SpanBuilder.buildStandaloneLlmSpan({
        sessionId: 'sess-local',
        segment: 4,
        sequence: 0,
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 10,
        inputCachedTokens: 5,
        outputTokens: 4,
        reasoningTokens: 0,
        totalTokens: 14,
        costUnits: 14,
        costUnitType: 'tokens',
        startedAt: 1200,
        endedAt: 1400,
      });

      expect(root.executionId).toBeUndefined();
      expect(root.attributes).toMatchObject({
        'makaio.session.id': 'sess-local',
        'makaio.trace.scope': 'standalone',
        'makaio.trace.segment': 4,
      });
      expect(llm.executionId).toBeUndefined();
      expect(llm.parentSpanId).toBe(root.spanId);
      expect(llm.attributes['makaio.trace.scope']).toBe('standalone');
    });
  });

  describe('buildToolSpan', () => {
    it('builds a correlated tool span with documented attributes', () => {
      const draft = SpanBuilder.buildToolSpan({
        executionId: 'wfx-1',
        sessionId: 'sess-1',
        frameId: 'frame-a',
        toolCallId: 'call-42',
        toolName: 'read',
        startedAt: 1200,
        endedAt: 1400,
        success: true,
        orphaned: false,
      });

      expect(draft.spanId).toBe('tool:wfx-1:sess-1:call-42');
      expect(draft.parentSpanId).toBe('frame:wfx-1:frame-a');
      expect(draft.namespace).toBe('agent');
      expect(draft.subject).toBe('tool');
      expect(draft.name).toBe('Tool read');
      expect(draft.kind).toBe('internal');
      expect(draft.status).toBe('ok');
      expect(draft.attributes).toMatchObject({
        'tool.name': 'read',
        'tool.call_id': 'call-42',
        'tool.success': true,
      });
    });
  });
});
