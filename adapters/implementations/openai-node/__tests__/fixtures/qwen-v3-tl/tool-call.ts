import { ChatCompletionChunk } from 'openai/resources';

// NOTE: from OpenRouter
export const chunksQwen_3_VL_ToolCall = [
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [
      {
        index: 0,
        delta: {
          reasoning:
            'Okay, the user wants me to write the word "HELLO" to a specific file path. Let me check the tools provided.\n\nThe available functions are read_file, write_file, and list_directory.',
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [
      {
        index: 0,
        delta: {
          reasoning:
            ' Since the task is to write content, I should use write_file. The parameters for write_file aren\'t specified in detail, but the description says it can create parent directories and append. The user just wants to write "HELLO" to that exact file.\n\nI need to structure the tool call with the correct arguments. The file path is /var/folders/h6/h2r8mv8x3tb_0xqmr8t2j9b80t0b12/T/test-approval-1764685945336-2f0ea835-9475-4364-9407-2f918f33e6f3-simple-allow.txt.',
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [
      {
        index: 0,
        delta: {
          reasoning:
            ' The content should be "HELLO". I assume the write_file function requires parameters like path and content. Even though the parameters are listed as empty in the tool definition, the description mentions it takes content, so I include those.\n\nSo the tool call should have name "write_file" with arguments: path and content. Let me make sure the JSON is correctly formatted. The user said to reply with OK if successful, but the assistant job here is to make the tool call, not the final response. The system will handle the response based on the tool success. So I just need to output the tool call.\n',
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [{ index: 0, delta: { content: '\n\n' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1910c9d8f6224ad591709f28',
              type: 'function',
              function: { arguments: '', name: 'write_file' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1910c9d8f6224ad591709f28',
              type: 'function',
              function: {
                arguments: '{"path": "/var/folders/h6/h2r8mv8x3tb_0xqmr8t2j9b80t0b12/T/test-approval-1764685945336-',
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1910c9d8f6224ad591709f28',
              type: 'function',
              function: { arguments: '2f0ea835-9475-4364-9407-2f918f33e6f3-simple-allow.txt", ' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1910c9d8f6224ad591709f28',
              type: 'function',
              function: { arguments: '"content": "HEL' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1910c9d8f6224ad591709f28', type: 'function', function: { arguments: 'LO"}' } },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-fad1a56d-2945-40be-8f73-f1addcc2a020',
    object: 'chat.completion.chunk',
    created: 1764685948,
    model: 'qwen3-vl-235b-a22b-thinking',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: {
      prompt_tokens: 349,
      completion_tokens: 445,
      total_tokens: 794,
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
      input_tokens: 349,
    },
    x_nanogpt_pricing: {
      amount: 0,
      currency: 'USD',
      cost: 0,
      inputTokens: 349,
      outputTokens: 445,
      paymentSource: 'USD',
      billedToTeam: false,
      billedTeamId: null,
      billedTeamName: null,
    },
  },
] as ChatCompletionChunk[];
