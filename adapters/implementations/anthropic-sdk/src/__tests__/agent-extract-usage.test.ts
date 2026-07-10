/**
 * Unit tests for {@link AnthropicSdkAgent.extractUsagePayload}.
 *
 * The method is protected, so tests access it through a minimal subclass that
 * re-exposes it as public. Instances are created with `Object.create` to avoid
 * running the full `AIAgent` constructor — the method under test is a pure
 * transformation with no `this` state dependencies.
 */

import { describe, expect, it } from 'vitest';
import type { NormalizedCallUsage } from '@makaio/ai-adapters-core';
import { AnthropicSdkAgent } from '../agent.js';
import type { UsageEvent } from '../namespaces/index.js';

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Minimal subclass that promotes `extractUsagePayload` to a public method.
 *
 * No constructor override is needed — `Object.create` bypasses the base-class
 * constructor entirely, which is safe here because the method under test is
 * a pure transformation with no `this` field access.
 */
class TestableAnthropicSdkAgent extends AnthropicSdkAgent {
  /**
   * Public wrapper around the protected {@link AnthropicSdkAgent.extractUsagePayload}.
   * @param payload - Raw usage event payload to normalize
   * @returns Normalized call usage metrics
   */
  public callExtractUsagePayload(payload: Record<string, unknown>): NormalizedCallUsage {
    return this.extractUsagePayload(payload);
  }
}

/** Create a bare prototype instance — no constructor side-effects. */
function makeAgent(): TestableAnthropicSdkAgent {
  return Object.create(TestableAnthropicSdkAgent.prototype) as TestableAnthropicSdkAgent;
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link UsageEvent} payload for testing.
 * @param overrides - Fields to override on the base fixture
 * @returns A complete UsageEvent object
 */
function makeUsageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventType: 'usage',
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicSdkAgent.extractUsagePayload', () => {
  it('maps cache_creation_input_tokens to cacheWriteTokens', () => {
    const agent = makeAgent();
    const payload = makeUsageEvent({ cache_creation_input_tokens: 42 });

    const result = agent.callExtractUsagePayload(payload);

    expect(result.cacheWriteTokens).toBe(42);
  });

  it('maps cache_read_input_tokens to inputCachedTokens', () => {
    const agent = makeAgent();
    const payload = makeUsageEvent({ cache_read_input_tokens: 7 });

    const result = agent.callExtractUsagePayload(payload);

    expect(result.inputCachedTokens).toBe(7);
  });

  it('defaults cacheWriteTokens to 0 when cache_creation_input_tokens is absent', () => {
    const agent = makeAgent();
    const payload = makeUsageEvent();

    const result = agent.callExtractUsagePayload(payload);

    expect(result.cacheWriteTokens).toBe(0);
  });

  it('defaults inputCachedTokens to 0 when cache_read_input_tokens is absent', () => {
    const agent = makeAgent();
    const payload = makeUsageEvent();

    const result = agent.callExtractUsagePayload(payload);

    expect(result.inputCachedTokens).toBe(0);
  });

  it('maps core token counts from the usage payload', () => {
    const agent = makeAgent();
    const payload = makeUsageEvent({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });

    const result = agent.callExtractUsagePayload(payload);

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
  });

  it('declares provider-call granularity on the emitted usage payload', () => {
    const agent = makeAgent();

    const result = agent.callExtractUsagePayload(makeUsageEvent());

    expect(result.granularity).toBe('provider-call');
  });

  it('sets provider to "anthropic" and costUnitType to "tokens"', () => {
    const agent = makeAgent();
    const payload = makeUsageEvent();

    const result = agent.callExtractUsagePayload(payload);

    expect(result.provider).toBe('anthropic');
    expect(result.costUnitType).toBe('tokens');
  });

  it('sets costUnits equal to totalTokens', () => {
    const agent = makeAgent();
    const payload = makeUsageEvent({ total_tokens: 200 });

    const result = agent.callExtractUsagePayload(payload);

    expect(result.costUnits).toBe(200);
  });

  it('preserves request-level workflow correlation on normalized usage', () => {
    const agent = makeAgent();
    const result = agent.callExtractUsagePayload(
      makeUsageEvent({ llmCallId: 'call-1', executionId: 'execution-1', frameId: 'frame-1' }),
    );

    expect(result).toMatchObject({ llmCallId: 'call-1', executionId: 'execution-1', frameId: 'frame-1' });
  });
});
