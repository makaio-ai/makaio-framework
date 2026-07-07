import { describe, expect, it } from 'vitest';
import { BaseAgentEventSchema } from '../base-event.js';

describe('BaseAgentEventSchema', () => {
  it('accepts analytics metadata fields when present', () => {
    const result = BaseAgentEventSchema.safeParse({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'adapter-session-1',
      clientId: 'claude-code',
      providerConfigId: 'provider-config-1',
      occurredAt: 1_744_123_456_789,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'adapter-session-1',
      clientId: 'claude-code',
      providerConfigId: 'provider-config-1',
      occurredAt: 1_744_123_456_789,
    });
  });

  it('keeps analytics metadata optional', () => {
    const result = BaseAgentEventSchema.safeParse({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'adapter-session-1',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'adapter-session-1',
    });
  });

  it('accepts missing adapterSessionId for unconfirmed fork sessions', () => {
    const result = BaseAgentEventSchema.safeParse({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
    });
    expect(result.data!.adapterSessionId).toBeUndefined();
  });
});
