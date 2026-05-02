import { ChatCompletionChunk } from 'openai/resources';

export const chunksDeepSeek_V3_2_ToolCall = [
  {
    id: 'chatcmpl-e365ed39-f8a4-4533-9211-7b0c688f34f5',
    object: 'chat.completion.chunk',
    created: 1764682182,
    model: 'deepseek/deepseek-v3.2:thinking',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-e365ed39-f8a4-4533-9211-7b0c688f34f5',
    object: 'chat.completion.chunk',
    created: 1764682182,
    model: 'deepseek/deepseek-v3.2:thinking',
    choices: [{ index: 0, delta: { reasoning: 'I need to write' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-e365ed39-f8a4-4533-9211-7b0c688f34f5',
    object: 'chat.completion.chunk',
    created: 1764682182,
    model: 'deepseek/deepseek-v3.2:thinking',
    choices: [{ index: 0, delta: { reasoning: ' the word "HELLO"' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-e365ed39-f8a4-4533-9211-7b0c688f34f5',
    object: 'chat.completion.chunk',
    created: 1764682182,
    model: 'deepseek/deepseek-v3.2:thinking',
    choices: [{ index: 0, delta: { reasoning: ' to that specific file' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-e365ed39-f8a4-4533-9211-7b0c688f34f5',
    object: 'chat.completion.chunk',
    created: 1764682182,
    model: 'deepseek/deepseek-v3.2:thinking',
    choices: [
      { index: 0, delta: { content: '\n\n<function_calls>\n<invoke name="write_file">\n' }, finish_reason: null },
    ],
  },
  {
    id: 'chatcmpl-e365ed39-f8a4-4533-9211-7b0c688f34f5',
    object: 'chat.completion.chunk',
    created: 1764682182,
    model: 'deepseek/deepseek-v3.2:thinking',
    choices: [
      {
        index: 0,
        delta: {
          content:
            '<parameter name="path" string="true">/var/folders/h6/h2r8mv8x3tb_0xqmr8t2j9b80t0b12/T/test-approval-176468216',
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-e365ed39-f8a4-4533-9211-7b0c688f34f5',
    object: 'chat.completion.chunk',
    created: 1764682182,
    model: 'deepseek/deepseek-v3.2:thinking',
    choices: [
      {
        index: 0,
        delta: { content: '1596-0f273960-2db0-47a8-9bc9-acebe60b7359-simple-allow.txt</parameter>\n' },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-e365ed39-f8a4-4533-9211-7b0c688f34f5',
    object: 'chat.completion.chunk',
    created: 1764682182,
    model: 'deepseek/deepseek-v3.2:thinking',
    choices: [
      {
        index: 0,
        delta: { content: '<parameter name="content" string="true">HELLO</parameter>\n' },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-e365ed39-f8a4-4533-9211-7b0c688f34f5',
    object: 'chat.completion.chunk',
    created: 1764682182,
    model: 'deepseek/deepseek-v3.2:thinking',
    choices: [{ index: 0, delta: { content: '</invoke>\n</function_calls>' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-e365ed39-f8a4-4533-9211-7b0c688f34f5',
    object: 'chat.completion.chunk',
    created: 1764682182,
    model: 'deepseek/deepseek-v3.2:thinking',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 490,
      completion_tokens: 184,
      total_tokens: 674,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
      reasoning_tokens: 0,
      citation_tokens: 0,
      num_search_queries: 0,
      input_tokens: 490,
    },
    x_nanogpt_pricing: {
      amount: 0,
      currency: 'USD',
      cost: 0,
      inputTokens: 490,
      outputTokens: 184,
      paymentSource: 'USD',
      billedToTeam: false,
      billedTeamId: null,
      billedTeamName: null,
    },
  },
] as ChatCompletionChunk[];
