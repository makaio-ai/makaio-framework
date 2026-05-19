import { describe, expect, it } from 'bun:test';
import { createAccumulatorState, mapBusEventToSdkMessage } from '../../src/shared/messages.js';

const BASE_EVENT = {
  agentId: 'agent-1',
  adapterId: 'adapter-1',
  adapterName: 'anthropic-sdk',
  adapterSessionId: 'as-1',
  sessionId: 'session-1',
  messageId: 'msg-1',
};

describe('mapBusEventToSdkMessage', () => {
  it('maps agent.started to SDKSystemMessage', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage('agent.started', { ...BASE_EVENT, model: 'sonnet', cwd: '/tmp' }, state);
    expect(msg).toEqual({
      type: 'system',
      subtype: 'init',
      model: 'sonnet',
      cwd: '/tmp',
      tools: [],
      session_id: 'session-1',
      uuid: 'msg-1',
    });
  });

  it('maps agent.message_delta to SDKAssistantMessage with text block', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage('agent.message_delta', { ...BASE_EVENT, text: 'Hello' }, state);
    expect(msg).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
      session_id: 'session-1',
    });
  });

  it('maps agent.reasoning_delta to SDKAssistantMessage with thinking block', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage('agent.reasoning_delta', { ...BASE_EVENT, content: 'Thinking...' }, state);
    expect(msg).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking...' }],
      },
    });
  });

  it('maps agent.tool.use to SDKAssistantMessage with tool_use block', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE_EVENT, toolName: 'read', args: { path: '/foo' }, toolCallId: 'tc-1' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'read', id: 'tc-1', input: { path: '/foo' } }],
      },
    });
  });

  it('maps agent.tool.output to SDKAssistantMessage with tool_result block', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.output',
      { ...BASE_EVENT, output: 'file contents', toolCallId: 'tc-1' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_result', content: 'file contents', id: 'tc-1' }],
      },
    });
  });

  it('maps agent.complete with successful outcome to SDKResultMessage', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.complete',
      { ...BASE_EVENT, message: 'Done.', outcome: 'completed' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      session_id: 'session-1',
    });
  });

  it('maps agent.complete with error outcome to SDKResultMessage', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.complete',
      { ...BASE_EVENT, outcome: 'error', error: 'Rate limit' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Rate limit',
    });
  });

  it('maps agent.contextWindow.updated to SDKCompactBoundaryMessage', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE_EVENT, level: 'warn', percentage: 75, currentTokens: 75000, maxTokens: 100000 },
      state,
    );
    expect(msg).toMatchObject({
      type: 'system',
      subtype: 'compact',
      level: 'warn',
      percentage: 75,
    });
  });

  it('deduplicates context window events at the same level', () => {
    const state = createAccumulatorState();
    const msg1 = mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE_EVENT, level: 'warn', percentage: 75, currentTokens: 75000, maxTokens: 100000 },
      state,
    );
    const msg2 = mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE_EVENT, level: 'warn', percentage: 80, currentTokens: 80000, maxTokens: 100000 },
      state,
    );
    expect(msg1).not.toBeNull();
    expect(msg2).toBeNull();
  });

  it('emits context window event when level changes', () => {
    const state = createAccumulatorState();
    mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE_EVENT, level: 'warn', percentage: 75, currentTokens: 75000, maxTokens: 100000 },
      state,
    );
    const msg = mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE_EVENT, level: 'critical', percentage: 95, currentTokens: 95000, maxTokens: 100000 },
      state,
    );
    expect(msg).toMatchObject({ level: 'critical', percentage: 95 });
  });

  it('accumulates usage into state', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.usage',
      {
        ...BASE_EVENT,
        provider: 'anthropic',
        model: 'sonnet',
        inputTokens: 100,
        inputCachedTokens: 50,
        cacheWriteTokens: 10,
        outputTokens: 200,
        reasoningTokens: 0,
        totalTokens: 300,
        costUnits: 1,
        costUnitType: 'tokens',
        cost: 0.001,
      },
      state,
    );
    expect(msg).toBeNull();
    expect(state.usage.input_tokens).toBe(100);
    expect(state.usage.output_tokens).toBe(200);
    expect(state.usage.cache_read_input_tokens).toBe(50);
    expect(state.usage.cache_creation_input_tokens).toBe(10);
    expect(state.totalCost).toBeCloseTo(0.001);
  });

  it('maps agent.message to SDKAssistantMessage with text block', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage('agent.message', { ...BASE_EVENT, content: 'full message text' }, state);
    expect(msg).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'full message text' }],
      },
    });
  });

  it('maps agent.reasoning to SDKAssistantMessage with thinking block', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage('agent.reasoning', { ...BASE_EVENT, content: 'full reasoning block' }, state);
    expect(msg).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'full reasoning block' }],
      },
    });
  });

  it('maps agent.tool.completed to SDKAssistantMessage with tool_result block', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.completed',
      { ...BASE_EVENT, toolName: 'read', toolCallId: 'tc-99', result: 'output text', success: true },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_result', content: 'output text', id: 'tc-99' }],
      },
    });
  });

  it('maps agent.step.started to SDKAssistantMessage', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.step.started',
      { ...BASE_EVENT, stepType: 'text', blockIndex: 0 },
      state,
    );
    expect(msg).toMatchObject({ type: 'assistant' });
  });

  it('maps agent.step.finished to SDKAssistantMessage', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.step.finished',
      { ...BASE_EVENT, stepType: 'text', blockIndex: 0, content: { type: 'text', content: 'x' } },
      state,
    );
    expect(msg).toMatchObject({ type: 'assistant' });
  });

  it('returns null for unknown event types', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage('agent.unknown', BASE_EVENT, state);
    expect(msg).toBeNull();
  });

  it('normalises an invalid compact level to "ok"', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE_EVENT, level: 'catastrophic', percentage: 99 },
      state,
    );
    expect(msg).toMatchObject({ type: 'system', subtype: 'compact', level: 'ok' });
  });
});
