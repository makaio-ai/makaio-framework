import { ChatCompletionChunk } from 'openai/resources';

export const chunksGlm_4_5_Air_ToolCall = [
  // Phase 1: Initial role assignment
  {
    id: 'chatcmpl-4e747c21-42b3-45ed-90c4-5a62a63b66ee',
    object: 'chat.completion.chunk',
    created: 1764683318,
    model: 'zai-org/GLM-4.5-Air:thinking',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  },

  // Phase 2: Reasoning (3 chunks)
  {
    id: 'chatcmpl-4e747c21-42b3-45ed-90c4-5a62a63b66ee',
    object: 'chat.completion.chunk',
    created: 1764683318,
    model: 'zai-org/GLM-4.5-Air:thinking',
    choices: [
      {
        index: 0,
        delta: {
          reasoning:
            '\nThe user is asking me to write the word "HELLO" to a specific file path. They want me to reply with "OK" if successful or "ERROR" if not.\n\n',
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-4e747c21-42b3-45ed-90c4-5a62a63b66ee',
    object: 'chat.completion.chunk',
    created: 1764683318,
    model: 'zai-org/GLM-4.5-Air:thinking',
    choices: [
      {
        index: 0,
        delta: {
          reasoning:
            'Let me use the write_file function to write "HELLO" to the specified file path. The file path is:\n/var/folders/h6/h2r8mv8x3tb_0xqmr8t2j9b80t0b12/T/test-approval-1764683317541-a9455355-2dbf-4029-9e22-294e31009331-simple-allow.txt\n\n',
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-4e747c21-42b3-45ed-90c4-5a62a63b66ee',
    object: 'chat.completion.chunk',
    created: 1764683318,
    model: 'zai-org/GLM-4.5-Air:thinking',
    choices: [
      {
        index: 0,
        delta: { reasoning: 'I need to use the write_file function with the content parameter set to "HELLO".' },
        finish_reason: null,
      },
    ],
  },

  // Phase 3: Content output (3 chunks)
  {
    id: 'chatcmpl-4e747c21-42b3-45ed-90c4-5a62a63b66ee',
    object: 'chat.completion.chunk',
    created: 1764683318,
    model: 'zai-org/GLM-4.5-Air:thinking',
    choices: [{ index: 0, delta: { content: '\n' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-4e747c21-42b3-45ed-90c4-5a62a63b66ee',
    object: 'chat.completion.chunk',
    created: 1764683318,
    model: 'zai-org/GLM-4.5-Air:thinking',
    choices: [
      {
        index: 0,
        delta: {
          content: '<tool_call>write_file\n<arg_key>content</arg_key>\n<arg_value>HELLO</arg_value>\n',
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-4e747c21-42b3-45ed-90c4-5a62a63b66ee',
    object: 'chat.completion.chunk',
    created: 1764683318,
    model: 'zai-org/GLM-4.5-Air:thinking',
    choices: [
      {
        index: 0,
        delta: {
          content:
            '<arg_key>path</arg_key>\n<arg_value>/var/folders/h6/h2r8mv8x3tb_0xqmr8t2j9b80t0b12/T/test-approval-1764683317541-a9455355-2dbf-4029-9e22-294e31009331-simple-allow.txt</arg_value>\n</tool_call>',
        },
        finish_reason: null,
      },
    ],
  },

  // Phase 4: Tool call (kept as-is - structural requirement)
  {
    id: 'chatcmpl-4e747c21-42b3-45ed-90c4-5a62a63b66ee',
    object: 'chat.completion.chunk',
    created: 1764683318,
    model: 'zai-org/GLM-4.5-Air:thinking',
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call_0_0', type: 'function', function: { arguments: '{}' } }] },
        finish_reason: null,
      },
    ],
  },

  // Phase 5: Finish
  {
    id: 'chatcmpl-4e747c21-42b3-45ed-90c4-5a62a63b66ee',
    object: 'chat.completion.chunk',
    created: 1764683318,
    model: 'zai-org/GLM-4.5-Air:thinking',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: {
      prompt_tokens: 344,
      completion_tokens: 252,
      total_tokens: 596,
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
      input_tokens: 344,
    },
    x_nanogpt_pricing: { amount: 0, currency: 'USD' },
  },
] as ChatCompletionChunk[];
