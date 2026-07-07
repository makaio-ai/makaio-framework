import { describe, expect, it } from 'vitest';
import { UserMessageSentSchema } from '../user-message-sent.js';

describe('UserMessageSentSchema', () => {
  const baseFields = {
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'claude-code',
    messageId: 'msg-1',
    content: {
      role: 'user' as const,
      blocks: [{ type: 'text' as const, content: 'hello' }],
    },
    deliveryMode: 'enqueue' as const,
  };

  it('validates with adapterSessionId present', () => {
    const result = UserMessageSentSchema.safeParse({
      ...baseFields,
      adapterSessionId: 'session-1',
    });

    expect(result.success).toBe(true);
    expect(result.data!.adapterSessionId).toBe('session-1');
  });

  it('validates without adapterSessionId (unconfirmed fork pre-confirmation)', () => {
    const result = UserMessageSentSchema.safeParse(baseFields);

    expect(result.success).toBe(true);
    expect(result.data!.adapterSessionId).toBeUndefined();
  });
});
