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
      apiKeySource: 'user',
      claude_code_version: '',
      model: 'sonnet',
      cwd: '/tmp',
      tools: [],
      mcp_servers: [],
      permissionMode: 'default',
      slash_commands: [],
      output_style: '',
      skills: [],
      plugins: [],
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

  it('maps agent.tool.output to SDKToolResultMessage', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.output',
      { ...BASE_EVENT, output: 'file contents', toolCallId: 'tc-1' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tc-1',
      content: 'file contents',
      is_error: false,
      session_id: 'session-1',
      uuid: 'msg-1',
    });
  });

  it('preserves structured agent.tool.output payloads as JSON content', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.output',
      { ...BASE_EVENT, output: { paths: ['/tmp/a.ts'], totalMatches: 1 }, toolCallId: 'tc-1' },
      state,
    );

    expect(msg).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tc-1',
      content: '{"paths":["/tmp/a.ts"],"totalMatches":1}',
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
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Rate limit'],
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
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 75000,
      },
    });
  });

  it('always emits context window events (no level-based dedup)', () => {
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
    expect(msg2).not.toBeNull();
  });

  it('emits context window event with updated token count', () => {
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
    expect(msg).toMatchObject({
      compact_metadata: { trigger: 'auto', pre_tokens: 95000 },
    });
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

  it('maps agent.tool.completed to SDKToolResultMessage', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.completed',
      { ...BASE_EVENT, toolName: 'read', toolCallId: 'tc-99', result: 'output text', success: true },
      state,
    );
    expect(msg).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tc-99',
      content: 'output text',
      is_error: false,
      session_id: 'session-1',
      uuid: 'msg-1',
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

  it('normalizes read_file name to Read and path to file_path', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE_EVENT, toolName: 'read_file', args: { path: '/tmp/x' }, toolCallId: 'tc-n1' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } }] },
    });
  });

  it('normalizes write_file name to Write and path to file_path', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE_EVENT, toolName: 'write_file', args: { path: '/tmp/x', content: 'hi' }, toolCallId: 'tc-n1b' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/x', content: 'hi' } }] },
    });
  });

  it('normalizes shell_exec to Bash (input unchanged)', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE_EVENT, toolName: 'shell_exec', args: { command: 'ls' }, toolCallId: 'tc-n2' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    });
  });

  it('normalizes shell_kill shellId to task_id', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE_EVENT, toolName: 'shell_kill', args: { shellId: 'sh-1' }, toolCallId: 'tc-n2b' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'TaskStop', input: { task_id: 'sh-1' } }] },
    });
  });

  it('normalizes spawn_subagent task to prompt', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE_EVENT, toolName: 'spawn_subagent', args: { task: 'do something' }, toolCallId: 'tc-n2c' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'do something' } }] },
    });
  });

  it('normalizes send_to_subagent subagentId→to and content→message', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      {
        ...BASE_EVENT,
        toolName: 'send_to_subagent',
        args: { subagentId: 'sa-1', content: 'hello' },
        toolCallId: 'tc-n2d',
      },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'sa-1', message: 'hello' } }] },
    });
  });

  it('passes through unknown tool names and inputs unchanged', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE_EVENT, toolName: 'my_custom_mcp_tool', args: { foo: 'bar' }, toolCallId: 'tc-n3' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'my_custom_mcp_tool', input: { foo: 'bar' } }] },
    });
  });

  it('normalizes tool names in tool_progress messages', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.started',
      { ...BASE_EVENT, toolName: 'write_file', toolCallId: 'tc-n4' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'tool_progress',
      tool_name: 'Write',
    });
  });

  it('maps agent.contextWindow.updated without currentTokens to pre_tokens 0', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE_EVENT, level: 'critical', percentage: 99 },
      state,
    );
    expect(msg).toMatchObject({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 0 },
    });
  });
});
