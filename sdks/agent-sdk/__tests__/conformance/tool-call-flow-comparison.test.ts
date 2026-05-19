/**
 * Tool-call flow comparison: captures the exact message sequence both SDKs
 * produce and compares structural shapes.
 *
 * This test documents the known divergences between Makaio and Claude SDK
 * message streams and verifies the Makaio stream is a strict superset of
 * what a Claude SDK consumer would see.
 *
 * We don't run live queries here — instead we use the mapBusEventToSdkMessage
 * mapper with a realistic bus event sequence that simulates a tool-call turn:
 *
 *   1. agent.started
 *   2. agent.turn.started
 *   3. agent.tool.use (Read file)
 *   4. agent.tool.started
 *   5. agent.tool.output
 *   6. agent.message (assistant response after tool)
 *   7. agent.complete
 *
 * Then we verify each message's type/subtype against what Claude SDK consumers
 * expect, flagging any Makaio-only additions.
 */

import { describe, expect, it } from 'vitest';
import { createAccumulatorState, mapBusEventToSdkMessage } from '../../src/shared/messages.js';
import type { SDKMessage } from '../../src/shared/types.js';

const BASE = {
  agentId: 'a1',
  adapterId: 'ad1',
  adapterName: 'test',
  adapterSessionId: 'as1',
  sessionId: 'sess-1',
  messageId: 'msg-1',
} as const;

/**
 * Simulate a full tool-call turn through the bus event mapper.
 * @returns Ordered array of SDK messages the consumer would receive.
 */
function simulateToolCallTurn(): SDKMessage[] {
  const state = createAccumulatorState();
  const messages: SDKMessage[] = [];

  const events: [string, Record<string, unknown>][] = [
    ['agent.started', { ...BASE, model: 'sonnet', cwd: '/workspace' }],
    ['agent.turn.started', { ...BASE, messageId: 'turn-1', content: 'Read README.md' }],
    [
      'agent.tool.use',
      { ...BASE, messageId: 'tu-1', toolName: 'Read', toolCallId: 'tc-1', args: { file_path: '/workspace/README.md' } },
    ],
    ['agent.tool.started', { ...BASE, messageId: 'ts-1', toolName: 'Read', toolCallId: 'tc-1' }],
    [
      'agent.tool.output',
      { ...BASE, messageId: 'to-1', toolCallId: 'tc-1', output: '# Project\nReadme content here.' },
    ],
    [
      'agent.tool.completed',
      {
        ...BASE,
        messageId: 'td-1',
        toolName: 'Read',
        toolCallId: 'tc-1',
        result: '# Project\nReadme content here.',
        success: true,
      },
    ],
    [
      'agent.usage',
      {
        ...BASE,
        provider: 'anthropic',
        model: 'sonnet',
        inputTokens: 200,
        outputTokens: 50,
        inputCachedTokens: 0,
        cacheWriteTokens: 0,
        cost: 0.001,
      },
    ],
    [
      'agent.message',
      { ...BASE, messageId: 'am-1', content: 'I have read README.md. It contains project documentation.' },
    ],
    ['agent.complete', { ...BASE, messageId: 'ac-1', outcome: 'completed', message: 'Done.' }],
  ];

  for (const [subject, payload] of events) {
    const msg = mapBusEventToSdkMessage(subject, payload, state);
    if (msg !== null) messages.push(msg);
  }

  return messages;
}

/** Message types that a Claude SDK consumer would see in their for-await loop. */
const CLAUDE_SDK_KNOWN_TYPES = new Set([
  'system',
  'assistant',
  'user',
  'result',
  'stream_event',
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'rate_limit_event',
  'prompt_suggestion',
]);

/** Message types that are Makaio-specific additions. */
const MAKAIO_ONLY_TYPES = new Set(['tool_result']);

describe('tool-call flow comparison', () => {
  const messages = simulateToolCallTurn();

  it('produces a non-empty message stream', () => {
    expect(messages.length).toBeGreaterThan(0);
  });

  it('message sequence starts with system init', () => {
    expect(messages[0]!.type).toBe('system');
    expect((messages[0] as { subtype?: string }).subtype).toBe('init');
  });

  it('contains an assistant message with tool_use block', () => {
    const toolUse = messages.find(
      (m) => m.type === 'assistant' && m.message.content.some((b) => b.type === 'tool_use'),
    );
    expect(toolUse).toBeDefined();

    if (toolUse && toolUse.type === 'assistant') {
      const block = toolUse.message.content.find((b) => b.type === 'tool_use');
      expect(block).toBeDefined();
      if (block && block.type === 'tool_use') {
        expect(block.name).toBe('Read');
        expect(block.id).toBe('tc-1');
        expect(block.input).toEqual({ file_path: '/workspace/README.md' });
      }
    }
  });

  it('contains tool_result messages (Makaio extension)', () => {
    const toolResults = messages.filter((m) => m.type === 'tool_result');
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });

  it('contains a tool_progress message from agent.tool.started', () => {
    const progress = messages.filter((m) => m.type === 'tool_progress');
    expect(progress.length).toBe(1);
  });

  it('contains an assistant message with the response text', () => {
    const response = messages.find(
      (m) => m.type === 'assistant' && m.message.content.some((b) => b.type === 'text' && b.text.includes('README.md')),
    );
    expect(response).toBeDefined();
  });

  it('ends with a result message', () => {
    const last = messages[messages.length - 1];
    expect(last!.type).toBe('result');
  });

  it('every non-Makaio message type is in the Claude SDK known set', () => {
    const unknownTypes = messages
      .map((m) => m.type)
      .filter((t) => !CLAUDE_SDK_KNOWN_TYPES.has(t) && !MAKAIO_ONLY_TYPES.has(t));
    expect(unknownTypes).toEqual([]);
  });

  it('documents the full message type sequence for review', () => {
    const sequence = messages.map((m) => {
      const base = m.type;
      if ('subtype' in m && m.subtype) return `${base}/${m.subtype}`;
      if (m.type === 'assistant') {
        const blockTypes = m.message.content.map((b) => b.type).join('+');
        return `${base}[${blockTypes}]`;
      }
      return base;
    });
    expect(sequence).toMatchSnapshot();
  });

  it('assistant messages carry required BetaMessage fields', () => {
    const assistantMsgs = messages.filter((m) => m.type === 'assistant');
    for (const msg of assistantMsgs) {
      if (msg.type !== 'assistant') continue;
      expect(msg.message).toHaveProperty('id');
      expect(msg.message).toHaveProperty('type', 'message');
      expect(msg.message).toHaveProperty('role', 'assistant');
      expect(msg.message).toHaveProperty('model');
      expect(msg.message).toHaveProperty('stop_reason');
      expect(msg.message).toHaveProperty('stop_sequence');
      expect(msg.message).toHaveProperty('usage');
      expect(msg).toHaveProperty('parent_tool_use_id');
      expect(msg).toHaveProperty('session_id');
      expect(msg).toHaveProperty('uuid');
    }
  });

  it('tool_use blocks have all required fields for consumer extraction', () => {
    const toolUseBlocks = messages
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => (m.type === 'assistant' ? m.message.content : []))
      .filter((b) => b.type === 'tool_use');

    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;
      expect(typeof block.name).toBe('string');
      expect(typeof block.id).toBe('string');
      expect(block.id).not.toBe('');
      expect(block.input).not.toBeNull();
      expect(typeof block.input).toBe('object');
    }
  });
});
