/**
 * SDK compatibility gap inventory.
 *
 * Resolved gaps are verified with real assertions. Remaining gaps and
 * intentional divergences are documented as `it.todo()`.
 *
 * Verified against live Claude Code sessions (2026-05-19).
 * Fixtures: __tests__/fixtures/claude-tool-use-blocks.json
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { createAccumulatorState, mapBusEventToSdkMessage } from '../../src/shared/messages.js';
import type {
  ContentBlock,
  SDKAssistantMessage,
  SDKMessage,
  SDKToolResultMessage,
  ToolUseBlock,
} from '../../src/shared/types.js';

const BASE = {
  agentId: 'a1',
  adapterId: 'ad1',
  adapterName: 'test',
  adapterSessionId: 'as1',
  sessionId: 'sess-gap',
  messageId: 'msg-gap',
} as const;

// ---------------------------------------------------------------------------
// 1. Message type coverage
//    Claude emits SDKPartialAssistantMessage, stream_event, tool_use_summary,
//    auth_status, rate_limit_event, prompt_suggestion. Makaio's bus model maps
//    to higher-level equivalents for the first two; the rest are not applicable.
// ---------------------------------------------------------------------------

describe('Gap 1: message type coverage', () => {
  it('agent.message_delta maps to full SDKAssistantMessage (covers SDKPartialAssistantMessage use case)', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage('agent.message_delta', { ...BASE, text: 'partial chunk' }, state);
    expect(msg).toMatchObject({ type: 'assistant', message: { role: 'assistant' } });
  });

  it('agent.tool.completed maps to tool_result (covers tool_use_summary use case)', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.completed',
      { ...BASE, toolName: 'read_file', toolCallId: 'tc-1', result: 'content', success: true },
      state,
    );
    expect(msg).toMatchObject({ type: 'tool_result', tool_use_id: 'tc-1' });
  });

  it.todo('stream_event — raw SSE events; Makaio bus events are higher-level abstractions');
  it.todo('auth_status — Makaio handles auth at the adapter layer');
  it.todo('rate_limit_event — Makaio adapters handle rate limits internally');
  it.todo('prompt_suggestion — Makaio has no follow-up prompt suggestion mechanism');
});

// ---------------------------------------------------------------------------
// 2. Tool parity
// ---------------------------------------------------------------------------

describe('Gap 2: tool parity', () => {
  it('edit_file maps to Edit', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      {
        ...BASE,
        toolName: 'edit_file',
        args: { path: '/tmp/f.ts', old_string: 'a', new_string: 'b' },
        toolCallId: 'tc-g1',
      },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/f.ts' } }] },
    });
  });

  it('glob_files maps to Glob', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'glob_files', args: { pattern: '**/*.ts' }, toolCallId: 'tc-g2' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } }] },
    });
  });

  it('grep_files maps to Grep', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'grep_files', args: { pattern: 'TODO', path: '/src' }, toolCallId: 'tc-g3' },
      state,
    );
    expect(msg).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO', path: '/src' } }] },
    });
  });

  it.todo(
    'TaskCreate/TaskUpdate/TaskGet/TaskList — Claude built-in task management; different domain than Makaio subagent tools',
  );
  it.todo('WebSearch — Claude built-in; Makaio has no web search extension yet');
  it.todo('WebFetch — Claude built-in; Makaio has no URL fetcher extension yet');
  it.todo('Skill — Claude built-in; Makaio uses extensions for a similar purpose');
  it.todo('ToolSearch — Claude built-in discovery; Makaio registers tools statically');
});

// ---------------------------------------------------------------------------
// 3. Tool input field normalization (all resolved)
// ---------------------------------------------------------------------------

describe('Gap 3: tool input field normalization', () => {
  it('read_file: path → file_path', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'read_file', args: { path: '/src/index.ts', offset: 0 }, toolCallId: 'tc-r1' },
      state,
    );
    expect(msg).toMatchObject({
      message: { content: [{ name: 'Read', input: { file_path: '/src/index.ts', offset: 0 } }] },
    });
  });

  it('write_file: path → file_path, extra fields pass through', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      {
        ...BASE,
        toolName: 'write_file',
        args: { path: '/tmp/x', content: 'hi', createDirectories: true },
        toolCallId: 'tc-r2',
      },
      state,
    );
    expect(msg).toMatchObject({
      message: { content: [{ name: 'Write', input: { file_path: '/tmp/x', content: 'hi', createDirectories: true } }] },
    });
  });

  it('edit_file: path → file_path', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      {
        ...BASE,
        toolName: 'edit_file',
        args: { path: '/tmp/f', old_string: 'a', new_string: 'b' },
        toolCallId: 'tc-r3',
      },
      state,
    );
    expect(msg).toMatchObject({
      message: { content: [{ name: 'Edit', input: { file_path: '/tmp/f' } }] },
    });
  });

  it('glob_files: cwd → path', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'glob_files', args: { pattern: '*.ts', cwd: '/workspace' }, toolCallId: 'tc-r3b' },
      state,
    );
    expect(msg).toMatchObject({
      message: { content: [{ name: 'Glob', input: { pattern: '*.ts', path: '/workspace' } }] },
    });
  });

  it('shell_kill: shellId → task_id', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'shell_kill', args: { shellId: 'sh-1', signal: 'SIGTERM' }, toolCallId: 'tc-r4' },
      state,
    );
    expect(msg).toMatchObject({
      message: { content: [{ name: 'TaskStop', input: { task_id: 'sh-1', signal: 'SIGTERM' } }] },
    });
  });

  it('spawn_subagent: task → prompt', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'spawn_subagent', args: { task: 'research X', model: 'sonnet' }, toolCallId: 'tc-r5' },
      state,
    );
    expect(msg).toMatchObject({
      message: { content: [{ name: 'Agent', input: { prompt: 'research X', model: 'sonnet' } }] },
    });
  });

  it('send_to_subagent: subagentId → to, content → message', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'send_to_subagent', args: { subagentId: 'sa-1', content: 'done' }, toolCallId: 'tc-r6' },
      state,
    );
    expect(msg).toMatchObject({
      message: { content: [{ name: 'SendMessage', input: { to: 'sa-1', message: 'done' } }] },
    });
  });

  it('shell_exec→Bash: command passes through, other fields are additive', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'shell_exec', args: { command: 'ls -la', cwd: '/tmp', timeout: 5000 }, toolCallId: 'tc-r7' },
      state,
    );
    expect(msg).toMatchObject({
      message: { content: [{ name: 'Bash', input: { command: 'ls -la', cwd: '/tmp', timeout: 5000 } }] },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Type-level divergences (intentional, verified with type assertions)
// ---------------------------------------------------------------------------

describe('Gap 4: intentional type-level divergences (verified)', () => {
  it('ContentBlock covers 3 consumer-relevant variants (text, thinking, tool_use)', () => {
    expectTypeOf<ContentBlock['type']>().toEqualTypeOf<'text' | 'thinking' | 'tool_use'>();
  });

  it('stop_reason is string | null (wider than Claude BetaStopReason, accepts all Claude values)', () => {
    expectTypeOf<SDKAssistantMessage['message']['stop_reason']>().toEqualTypeOf<string | null>();
  });

  it('SDKToolResultMessage is a Makaio-only message type in the SDKMessage union', () => {
    expectTypeOf<SDKToolResultMessage>().toMatchTypeOf<SDKMessage>();
    expectTypeOf<SDKToolResultMessage['type']>().toEqualTypeOf<'tool_result'>();
  });

  it('BetaMessage.model is plain string (wider than Claude Model literal union)', () => {
    expectTypeOf<SDKAssistantMessage['message']['model']>().toEqualTypeOf<string>();
  });

  it('uuid fields are plain string (wider than Claude template literal UUID)', () => {
    expectTypeOf<SDKAssistantMessage['uuid']>().toEqualTypeOf<string>();
  });

  it('ToolUseBlock.input is Record<string, unknown> (narrower than Claude unknown, always assignable)', () => {
    expectTypeOf<ToolUseBlock['input']>().toEqualTypeOf<Record<string, unknown>>();
  });
});

// ---------------------------------------------------------------------------
// 5. Runtime behavior
// ---------------------------------------------------------------------------

describe('Gap 5: runtime behavior', () => {
  it('tool input field names are normalized at the SDK boundary', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'read_file', args: { path: '/x' }, toolCallId: 'tc-b1' },
      state,
    );
    expect(msg).toMatchObject({
      message: { content: [{ input: { file_path: '/x' } }] },
    });
  });

  it('unmapped Makaio tools pass through as snake_case', () => {
    const state = createAccumulatorState();
    const msg = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'list_directory', args: { path: '/src' }, toolCallId: 'tc-b2' },
      state,
    );
    expect(msg).toMatchObject({
      message: { content: [{ name: 'list_directory', input: { path: '/src' } }] },
    });
  });

  it('mapper produces tool_progress before tool_result for sequential bus events', () => {
    const state = createAccumulatorState();
    const msgs: SDKMessage[] = [];
    for (const [subject, payload] of [
      ['agent.tool.started', { ...BASE, toolName: 'read_file', toolCallId: 'tc-ord' }],
      ['agent.tool.output', { ...BASE, toolCallId: 'tc-ord', output: 'content' }],
    ] as const) {
      const m = mapBusEventToSdkMessage(subject, payload as Record<string, unknown>, state);
      if (m) msgs.push(m);
    }
    expect(msgs[0]!.type).toBe('tool_progress');
    expect(msgs[1]!.type).toBe('tool_result');
  });

  it('usage accumulates across multiple agent.usage events', () => {
    const state = createAccumulatorState();
    const usage1 = {
      ...BASE,
      inputTokens: 100,
      outputTokens: 50,
      inputCachedTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.01,
    };
    const usage2 = {
      ...BASE,
      inputTokens: 200,
      outputTokens: 100,
      inputCachedTokens: 50,
      cacheWriteTokens: 10,
      cost: 0.02,
    };
    mapBusEventToSdkMessage('agent.usage', usage1, state);
    mapBusEventToSdkMessage('agent.usage', usage2, state);
    expect(state.usage.input_tokens).toBe(300);
    expect(state.usage.output_tokens).toBe(150);
    expect(state.usage.cache_read_input_tokens).toBe(50);
    expect(state.usage.cache_creation_input_tokens).toBe(10);
    expect(state.totalCost).toBeCloseTo(0.03);
  });

  it('session state transitions map to SDKSessionStateChangedMessage', () => {
    const state = createAccumulatorState();
    const idle = mapBusEventToSdkMessage('agent.idle', { ...BASE }, state);
    const running = mapBusEventToSdkMessage('agent.turn.started', { ...BASE }, state);
    expect(idle).toMatchObject({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    expect(running).toMatchObject({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  });
});
