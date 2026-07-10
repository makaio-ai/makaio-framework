import { describe, expect, it } from 'vitest';
import { normalizeGeminiUsage } from '../src/usage.js';

describe('normalizeGeminiUsage', () => {
  it('declares turn-aggregate granularity on the emitted usage payload', () => {
    const result = normalizeGeminiUsage({
      promptTokenCount: 100,
      candidatesTokenCount: 40,
      totalTokenCount: 140,
    });

    expect(result.granularity).toBe('turn-aggregate');
  });

  it('maps Gemini usage metadata to normalized token fields', () => {
    const result = normalizeGeminiUsage({
      promptTokenCount: 100,
      cachedContentTokenCount: 20,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 15,
      totalTokenCount: 155,
      trafficType: 'PROVISIONED_THROUGHPUT',
    });

    expect(result).toMatchObject({
      provider: 'gemini',
      inputTokens: 100,
      inputCachedTokens: 20,
      outputTokens: 40,
      reasoningTokens: 15,
      totalTokens: 155,
      costUnits: 1,
      costUnitType: 'requests',
      serviceTier: 'PROVISIONED_THROUGHPUT',
    });
  });

  it('defaults all token counts to 0 when usage metadata is absent', () => {
    const result = normalizeGeminiUsage(undefined);

    expect(result).toMatchObject({
      granularity: 'turn-aggregate',
      provider: 'gemini',
      inputTokens: 0,
      inputCachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    });
  });
});
