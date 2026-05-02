import { describe, expect, it } from 'vitest';

import { SDKUserMessageSchema } from '@makaio/client-claude-code';

describe('SDKUserMessageSchema', () => {
  it('accepts compact summary messages when they are synthetic', () => {
    const result = SDKUserMessageSchema.safeParse({
      type: 'user',
      uuid: 'user-1',
      session_id: 'session-1',
      agentId: 'main',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: 'Compaction summary',
      },
      isCompactSummary: true,
      isSynthetic: true,
    });

    expect(result.success).toBe(true);
  });

  it('rejects compact summary messages when they are not synthetic', () => {
    const result = SDKUserMessageSchema.safeParse({
      type: 'user',
      uuid: 'user-1',
      session_id: 'session-1',
      agentId: 'main',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: 'Compaction summary',
      },
      isCompactSummary: true,
    });

    expect(result.success).toBe(false);
  });
});
