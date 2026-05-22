import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '@makaio/contracts';
import { llmSummarizeAction } from '../llm-summarize.js';

describe('llmSummarizeAction', () => {
  it('passes messages through unchanged in pipeline execution', async () => {
    const messages: SessionMessage[] = [
      {
        messageId: 'm1',
        turnId: null,
        sessionId: 's1',
        role: 'user',
        contentText: 'hello',
        blocks: [{ type: 'text', content: 'hello' }],
        timestamp: 1,
      },
    ];

    const result = await llmSummarizeAction.execute(messages);

    expect(result).toEqual({ kind: 'messages', messages });
  });
});
