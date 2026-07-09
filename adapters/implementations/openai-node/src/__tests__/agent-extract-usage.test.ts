import { describe, expect, it } from 'vitest';
import type { NormalizedCallUsage } from '@makaio/ai-adapters-core';
import { OpenAIAgent } from '../agent.js';
import type { UsageEvent } from '../namespaces/index.js';

class TestableOpenAIAgent extends OpenAIAgent {
  public callExtractUsagePayload(payload: Record<string, unknown>): NormalizedCallUsage {
    return this.extractUsagePayload(payload);
  }
}

function makeAgent(): TestableOpenAIAgent {
  return Object.create(TestableOpenAIAgent.prototype) as TestableOpenAIAgent;
}

describe('OpenAIAgent.extractUsagePayload', () => {
  it('preserves request-level workflow correlation on normalized usage', () => {
    const usage: UsageEvent = {
      eventType: 'usage',
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      llmCallId: 'call-1',
      executionId: 'execution-1',
      frameId: 'frame-1',
    };

    expect(makeAgent().callExtractUsagePayload(usage)).toMatchObject({
      llmCallId: 'call-1',
      executionId: 'execution-1',
      frameId: 'frame-1',
    });
  });
});
