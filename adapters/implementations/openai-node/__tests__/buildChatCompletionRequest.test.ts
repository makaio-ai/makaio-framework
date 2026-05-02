import { describe, expect, it } from 'vitest';
import { buildChatCompletionRequest } from '../src/utils/buildChatCompletionRequest.js';

describe('buildChatCompletionRequest', () => {
  it('includes reasoning_effort when model supports reasoning and level is configured', () => {
    const request = buildChatCompletionRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      reasoningEffort: 'medium',
      supportsReasoningEffort: true,
    });

    expect(request.reasoning_effort).toBe('medium');
  });

  it('omits reasoning_effort when model does not support reasoning', () => {
    const request = buildChatCompletionRequest({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      reasoningEffort: 'high',
      supportsReasoningEffort: false,
    });

    expect(request.reasoning_effort).toBeUndefined();
  });

  it('omits reasoning_effort when level is none', () => {
    const request = buildChatCompletionRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      reasoningEffort: 'none',
      supportsReasoningEffort: true,
    });

    expect(request.reasoning_effort).toBeUndefined();
  });
});
