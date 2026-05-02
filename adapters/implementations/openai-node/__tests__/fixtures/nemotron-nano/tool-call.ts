import { ChatCompletionChunk } from 'openai/resources';

export const chunksNemotron_Nano_ToolCall = [
  // Phase 1: Initial role assignment
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: '', reasoning: null, reasoning_details: [] },
        finish_reason: null,
        native_finish_reason: null,
        logprobs: null,
      },
    ],
  },

  // Phase 2: Reasoning (3 chunks)
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: '',
          reasoning: 'Okay, let me try to',
          reasoning_details: [{ type: 'reasoning.text', text: 'Okay, let me try to', format: 'unknown', index: 0 }],
        },
        finish_reason: null,
        native_finish_reason: null,
        logprobs: null,
      },
    ],
  },
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: '',
          reasoning: " figure out how to handle this user's",
          reasoning_details: [
            { type: 'reasoning.text', text: " figure out how to handle this user's", format: 'unknown', index: 0 },
          ],
        },
        finish_reason: null,
        native_finish_reason: null,
        logprobs: null,
      },
    ],
  },
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: '',
          reasoning: ' request.\n',
          reasoning_details: [{ type: 'reasoning.text', text: ' request.\n', format: 'unknown', index: 0 }],
        },
        finish_reason: null,
        native_finish_reason: null,
        logprobs: null,
      },
    ],
  },

  // Phase 3: Reasoning end
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: '', reasoning: null, reasoning_details: [] },
        finish_reason: null,
        native_finish_reason: null,
        logprobs: null,
      },
    ],
  },

  // Phase 4: Tool call init (function name)
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'fVSbZbppB', type: 'function', index: 0, function: { name: 'write_file' } }],
        },
        finish_reason: null,
        native_finish_reason: null,
        logprobs: null,
      },
    ],
  },

  // Phase 5: Tool call arguments (3 chunks)
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [{ index: 0, function: { arguments: '{"file": "/var/folders/h6/' }, type: 'function' }],
        },
        finish_reason: null,
        native_finish_reason: null,
        logprobs: null,
      },
    ],
  },
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              function: {
                arguments:
                  'h2r8mv8x3tb_0xqmr8t2j9b80t0b12/T/test-approval-1764686369362-334156d4-73e9-45d9-b30c-0d6b7ed57c8c',
              },
              type: 'function',
            },
          ],
        },
        finish_reason: null,
        native_finish_reason: null,
        logprobs: null,
      },
    ],
  },
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { index: 0, function: { arguments: '-simple-allow.txt", "content": "HELLO"}' }, type: 'function' },
          ],
        },
        finish_reason: null,
        native_finish_reason: null,
        logprobs: null,
      },
    ],
  },

  // Phase 6: Tool call finish
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              function: {
                arguments:
                  '{"file": "/var/folders/h6/h2r8mv8x3tb_0xqmr8t2j9b80t0b12/T/test-approval-1764686369362-334156d4-73e9-45d9-b30c-0d6b7ed57c8c-simple-allow.txt", "content": "HELLO"}',
              },
              type: 'function',
            },
          ],
        },
        finish_reason: 'tool_calls',
        native_finish_reason: 'tool_calls',
        logprobs: null,
      },
    ],
  },

  // Phase 7: Usage
  {
    id: 'gen-1764686369-V4ZTXCvG7vcUAs8siQSy',
    provider: 'Nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl:free',
    object: 'chat.completion.chunk',
    created: 1764686369,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null,
        // @ts-expect-error specific to OpenRouter
        native_finish_reason: null,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 428,
      completion_tokens: 1104,
      total_tokens: 1532,
      cost: 0,
      is_byok: false,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0, video_tokens: 0 },
      cost_details: {
        upstream_inference_cost: null,
        upstream_inference_prompt_cost: 0,
        upstream_inference_completions_cost: 0,
      },
      completion_tokens_details: { reasoning_tokens: 1048, image_tokens: 0 },
    },
  },
] as Array<ChatCompletionChunk & { provider?: string }>;
