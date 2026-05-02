# OpenAI-Compatible API Fixtures

Real streaming chunks captured from various OSS models via OpenAI-compatible APIs (NanoGPT, OpenRouter).
These fixtures document the quirks and variations in how different models implement tool calling.

## Models Overview

| Model | Tool Call Method | finish_reason | Quirks |
|-------|-----------------|---------------|--------|
| Qwen-3-VL | `tool_calls` array | `tool_calls` | **Baseline** - standard behavior |
| GLM-4.6 | `tool_calls` array | `tool_calls` | Trailing `{}` in args |
| GLM-4.5-Air | XML in content + empty `tool_calls` | `tool_calls` | Custom XML format |
| DeepSeek-v3.2 | XML in content only | `stop` | No tool_calls array |
| Nemotron-Nano | `tool_calls` array | `tool_calls` | Wrong param names, extra fields |

---

## Detailed Analysis

### Qwen-3-VL (`qwen3-vl-235b-a22b-thinking`) - BASELINE

**Standard OpenAI-compatible behavior.** Use this as reference for expected format.

```
Chunk flow:
  1. role: 'assistant'
  2. reasoning (multiple chunks)
  3. content: '\n\n'
  4. tool_calls[0]: { id, name: 'write_file', arguments: '' }
  5. tool_calls[0]: { arguments: '{"path": "...' }  (streamed)
  6. tool_calls[0]: { arguments: '..."}' }
  7. finish_reason: 'tool_calls' + usage
```

**Aggregated tool call:**
```json
{
  "id": "call_1910c9d8f6224ad591709f28",
  "type": "function",
  "function": {
    "name": "write_file",
    "arguments": "{\"path\": \"...\", \"content\": \"HELLO\"}"
  }
}
```

---

### GLM-4.6 (`z-ai/glm-4.6:thinking`)

**Quirk: Sends tool arguments in TWO chunks, second chunk is just `{}`**

```
Chunk flow:
  1. role: 'assistant'
  2. reasoning (multiple chunks)
  3. tool_calls[0]: { id, name, arguments: '{"path":"...","content":"HELLO"}' }  <- FULL JSON
  4. tool_calls[0]: { id, arguments: '{}' }  <- EXTRA CHUNK
  5. finish_reason: 'tool_calls' + usage
```

**Problem:** Naive concatenation produces malformed JSON:
```
{"path":"/tmp/test.txt","content":"HELLO"}{}
```

**Detection:** `arguments.match(/\}\s*\{\s*\}$/)`

**Fix:** Strip trailing `{}` from concatenated arguments.

---

### GLM-4.5-Air (`zai-org/GLM-4.5-Air:thinking`)

**Quirk: Outputs tool calls as custom XML in `content`, sends empty `tool_calls` array**

```
Chunk flow:
  1. role: 'assistant'
  2. reasoning (multiple chunks)
  3. content: '\n'
  4. content: '<tool_call>write_file\n<arg_key>content</arg_key>\n<arg_value>HELLO</arg_value>\n'
  5. content: '<arg_key>path</arg_key>\n<arg_value>/path/to/file</arg_value>\n</tool_call>'
  6. tool_calls[0]: { id: 'call_0_0', arguments: '{}' }  <- EMPTY
  7. finish_reason: 'tool_calls' + usage
```

**XML Format (different from DeepSeek!):**
```xml
<tool_call>write_file
<arg_key>content</arg_key>
<arg_value>HELLO</arg_value>
<arg_key>path</arg_key>
<arg_value>/path/to/file</arg_value>
</tool_call>
```

**Detection:** `content.includes('<tool_call>') && toolCalls[0]?.function.arguments === '{}'`

**Fix:** Parse XML from content, ignore empty tool_calls array.

---

### DeepSeek-v3.2 (`deepseek/deepseek-v3.2:thinking`)

**Quirk: Outputs tool calls as XML in `content`, NO tool_calls array, finish_reason is `stop`**

```
Chunk flow:
  1. role: 'assistant'
  2. reasoning (multiple chunks)
  3. content: '\n\n<function_calls>\n<invoke name="write_file">\n'
  4. content: '<parameter name="path" string="true">/path/to/file</parameter>\n'
  5. content: '<parameter name="content" string="true">HELLO</parameter>\n'
  6. content: '</invoke>\n</function_calls>'
  7. finish_reason: 'stop' + usage  <- NOT 'tool_calls'!
```

**XML Format:**
```xml
<function_calls>
<invoke name="write_file">
<parameter name="path" string="true">/path/to/file</parameter>
<parameter name="content" string="true">HELLO</parameter>
</invoke>
</function_calls>
```

**Detection:** `content.includes('<function_calls>') && finishReason === 'stop' && toolCalls.length === 0`

**Fix:** Parse XML, synthesize tool_calls array, change finish_reason to `tool_calls`.

---

### Nemotron-Nano (`nvidia/nemotron-nano-12b-v2-vl:free`)

**Multiple quirks: wrong param names, extra fields, repeated args in final chunk**

```
Chunk flow:
  1. role + content: '' + reasoning: null + reasoning_details: []
  2. reasoning + reasoning_details (multiple chunks)
  3. reasoning: null (end of reasoning)
  4. tool_calls[0]: { id, name: 'write_file' }  <- name only
  5. tool_calls[0]: { arguments: '{"file": "/var/...' }  <- WRONG PARAM NAME
  6. tool_calls[0]: { arguments: '..."}' }
  7. tool_calls[0]: { arguments: '<FULL JSON>' } + finish_reason: 'tool_calls'  <- REPEATED
  8. usage chunk
```

**Quirks:**
1. Uses `file` instead of `path` parameter (model hallucination)
2. Has `reasoning_details` array with structured format
3. Provider-specific fields: `provider`, `native_finish_reason`
4. Final tool_calls chunk repeats FULL arguments (not delta)
5. Usage comes in separate chunk after finish_reason

**Detection:** Prefer structural detection over model-name checks. The fixture is identified by
a final `tool_calls` chunk that repeats a full JSON object after arguments have already closed;
`reasoning_details` and `provider` are useful supporting signals, not required identifiers.

**Fix:**
- For repeated args: During aggregation, if accumulated ends with `}` and incoming starts with `{` (but is not just `{}`), replace instead of concatenate
- For wrong params: Application-level concern (tool schema validation)

---

## Normalization Strategy

Stream-bridge should apply these normalizations **post-aggregation**:

```typescript
// 1. GLM-4.6: Strip trailing {}
if (/\}\s*\{\s*\}$/.test(args)) {
  args = args.replace(/\}\s*\{\s*\}$/, '}');
}

// 2. DeepSeek: Extract from <function_calls> XML
if (content.includes('<function_calls>') && finishReason === 'stop' && toolCalls.length === 0) {
  toolCalls = parseDeepSeekXml(content);
  finishReason = 'tool_calls';
}

// 3. GLM-4.5-Air: Extract from <tool_call> XML
if (content.includes('<tool_call>') && toolCalls[0]?.function.arguments === '{}') {
  toolCalls = parseGlmAirXml(content);
}

// 4. Nemotron: Handle repeated full args in final chunk (during aggregation)
// If accumulated ends with '}' and incoming starts with '{' but isn't '{}', replace
if (current.endsWith('}') && incoming.startsWith('{') && incoming !== '{}') {
  accumulator.arguments = incoming;  // Replace, don't concatenate
}
```

---

## Key Differences Summary

| Aspect | Standard | GLM-4.6 | GLM-4.5-Air | DeepSeek | Nemotron |
|--------|----------|---------|-------------|----------|----------|
| Tool call location | `tool_calls` | `tool_calls` | content XML | content XML | `tool_calls` |
| finish_reason | `tool_calls` | `tool_calls` | `tool_calls` | `stop` | `tool_calls` |
| Args streaming | Concatenate | + trailing `{}` | Empty | N/A | + repeated final |
| XML format | N/A | N/A | `<tool_call>` | `<function_calls>` | N/A |
| Extra fields | None | None | None | None | `reasoning_details` |
