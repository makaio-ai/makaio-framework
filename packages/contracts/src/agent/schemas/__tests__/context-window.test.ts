import { describe, it, expect } from 'vitest';
import { ContextWindowUpdatedSchema } from '../context-window.js';

describe('ContextWindowUpdatedSchema', () => {
  it('validates a valid context window update', () => {
    const payload = {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'session-1',
      currentTokens: 50000,
      maxTokens: 200000,
      cachedTokens: 10000,
      percentage: 25,
      level: 'ok',
    };

    const result = ContextWindowUpdatedSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('rejects invalid level', () => {
    const payload = {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'session-1',
      currentTokens: 50000,
      maxTokens: 200000,
      percentage: 25,
      level: 'danger', // Invalid
    };

    const result = ContextWindowUpdatedSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects percentage out of range', () => {
    const payload = {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'session-1',
      currentTokens: 50000,
      maxTokens: 200000,
      percentage: 150, // Invalid
      level: 'ok',
    };

    const result = ContextWindowUpdatedSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});
