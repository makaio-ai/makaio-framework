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
      supportsStructuredOutputStrict: false,
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
      supportsStructuredOutputStrict: false,
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
      supportsStructuredOutputStrict: false,
    });

    expect(request.reasoning_effort).toBeUndefined();
  });

  it('adds json_schema response_format from response schema descriptor', () => {
    const request = buildChatCompletionRequest({
      model: 'gpt-4o',
      messages: [],
      tools: [],
      supportsReasoningEffort: false,
      responseSchema: { schema: { type: 'object', title: 'Answer' }, strict: true },
      supportsStructuredOutputStrict: true,
    });

    expect(request.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'Answer',
        schema: { type: 'object', title: 'Answer' },
        strict: true,
      },
    });
  });

  it('uses explicit name over schema title in response schema descriptor', () => {
    const request = buildChatCompletionRequest({
      model: 'gpt-4o',
      messages: [],
      tools: [],
      supportsReasoningEffort: false,
      responseSchema: { schema: { type: 'object', title: 'Answer' }, name: 'MySchema', strict: true },
      supportsStructuredOutputStrict: true,
    });

    expect(request.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'MySchema' },
    });
  });

  it('falls back to "response" name when schema title is absent or invalid', () => {
    const request = buildChatCompletionRequest({
      model: 'gpt-4o',
      messages: [],
      tools: [],
      supportsReasoningEffort: false,
      responseSchema: { schema: { type: 'object' }, strict: true },
      supportsStructuredOutputStrict: true,
    });

    expect(request.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'response' },
    });
  });

  it('omits strict from json_schema when supportsStructuredOutputStrict is false', () => {
    const request = buildChatCompletionRequest({
      model: 'gpt-4o',
      messages: [],
      tools: [],
      supportsReasoningEffort: false,
      responseSchema: { schema: { type: 'object', title: 'Answer' }, strict: true },
      supportsStructuredOutputStrict: false,
    });

    expect(request.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'Answer', schema: { type: 'object', title: 'Answer' } },
    });
    expect((request.response_format as { json_schema: { strict?: boolean } }).json_schema.strict).toBeUndefined();
  });

  it('omits response_format when responseSchema is undefined', () => {
    const request = buildChatCompletionRequest({
      model: 'gpt-4o',
      messages: [],
      tools: [],
      supportsReasoningEffort: false,
      supportsStructuredOutputStrict: true,
    });

    expect(request.response_format).toBeUndefined();
  });
});
