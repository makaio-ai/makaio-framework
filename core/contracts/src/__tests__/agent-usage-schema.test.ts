import { describe, expect, it } from 'vitest';
import { UsageGranularitySchema, UsageSchema } from '../agent/index.js';

/**
 * Build a fully valid `agent.usage` payload for schema-contract assertions.
 * @returns Valid usage payload including the mandatory `granularity` field.
 */
function createValidUsagePayload(): Record<string, unknown> {
  return {
    agentId: 'review-agent',
    adapterId: 'adapter-instance-1',
    adapterName: 'anthropic-sdk',
    sessionId: 'session-1',
    granularity: 'provider-call',
    llmCallId: 'call-1',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    inputTokens: 100,
    inputCachedTokens: 80,
    outputTokens: 20,
    reasoningTokens: 2,
    totalTokens: 122,
    costUnits: 122,
    costUnitType: 'tokens',
  };
}

describe('agent.usage schema', () => {
  it('accepts every declared measurement granularity', () => {
    for (const granularity of UsageGranularitySchema.options) {
      const result = UsageSchema.safeParse({ ...createValidUsagePayload(), granularity });
      expect(result.success).toBe(true);
    }
  });

  it('requires the granularity field', () => {
    const { granularity: _granularity, ...withoutGranularity } = createValidUsagePayload();
    expect(UsageSchema.safeParse(withoutGranularity).success).toBe(false);
  });

  it('rejects undeclared granularity values', () => {
    expect(UsageSchema.safeParse({ ...createValidUsagePayload(), granularity: 'session-total' }).success).toBe(false);
  });

  it('keeps granularity orthogonal to llmCallId', () => {
    const { llmCallId: _llmCallId, ...withoutCallId } = createValidUsagePayload();
    const aggregate = UsageSchema.parse({ ...withoutCallId, granularity: 'query-aggregate' });
    expect(aggregate.granularity).toBe('query-aggregate');
    expect(aggregate.llmCallId).toBeUndefined();
  });
});
