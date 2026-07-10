/** Tests for GitHub Copilot provider-call usage normalization. */

import { describe, expect, it } from 'vitest';
import type { AssistantUsageEvent } from '../namespaces/index.js';
import { normalizeAssistantUsage } from '../agent.js';

describe('normalizeAssistantUsage', () => {
  it('preserves the SDK individual-API-call granularity', () => {
    const data: AssistantUsageEvent['data'] = {
      model: 'gpt-4.1',
      inputTokens: 10,
      cacheReadTokens: 2,
      outputTokens: 5,
    };

    expect(normalizeAssistantUsage(data)).toMatchObject({
      provider: 'copilot',
      granularity: 'provider-call',
      inputTokens: 10,
      inputCachedTokens: 2,
      outputTokens: 5,
      totalTokens: 15,
    });
  });
});
