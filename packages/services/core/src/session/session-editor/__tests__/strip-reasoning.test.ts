import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '@makaio/contracts';
import { stripReasoningAction } from '../actions/strip-reasoning.js';

describe('stripReasoningAction', () => {
  it('removes reasoning blocks and preserves other blocks', async () => {
    const input: SessionMessage[] = [
      {
        messageId: 'm1',
        sessionId: 's1',
        turnId: 't1',
        role: 'assistant',
        contentText: 'thinking',
        blocks: [
          { type: 'reasoning', content: 'hidden reasoning' },
          { type: 'text', content: 'answer' },
          { type: 'tool_output', toolCallId: 'tool-1', output: 'result' },
        ],
        timestamp: 1,
      },
    ];

    const result = await stripReasoningAction.execute(input);

    expect(result.kind).toBe('messages');
    if (result.kind !== 'messages') {
      throw new Error('Expected messages result');
    }
    expect(result.messages[0].blocks).toEqual([
      { type: 'text', content: 'answer' },
      { type: 'tool_output', toolCallId: 'tool-1', output: 'result' },
    ]);
  });
});
