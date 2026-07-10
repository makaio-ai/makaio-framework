---
title: "adapter:openai-node"
editUrl: false
prev: false
next: false
---

# `adapter:openai-node`

| Field | Value |
|-------|-------|
| Prefix | `adapter:openai-node` |
| Namespace constant | `OpenAINodeConnectorNamespace` |
| Subjects constant | `OpenAINodeConnectorSubjects` |
| Kind | adapter |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/adapter-openai-node` |
| Defined in | [`adapters/implementations/openai-node/src/namespaces/index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/openai-node/src/namespaces/index.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `agent_complete` | [`adapter:openai-node.agent_complete`](#adapter:openai-node.agent_complete) | event | [`lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/namespaces/schemas/lifecycle.ts) |
| `agent_started` | [`adapter:openai-node.agent_started`](#adapter:openai-node.agent_started) | event | [`lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/namespaces/schemas/lifecycle.ts) |
| `chunk` | [`adapter:openai-node.chunk`](#adapter:openai-node.chunk) | event | [`chunk.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/openai-node/src/namespaces/schemas/chunk.ts) |
| `error` | [`adapter:openai-node.error`](#adapter:openai-node.error) | event | [`lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/namespaces/schemas/lifecycle.ts) |
| `message_complete` | [`adapter:openai-node.message_complete`](#adapter:openai-node.message_complete) | event | [`message.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/openai-node/src/namespaces/schemas/message.ts) |
| `reasoning_complete` | [`adapter:openai-node.reasoning_complete`](#adapter:openai-node.reasoning_complete) | event | [`reasoning.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/reasoning.ts) |
| `reasoning_delta` | [`adapter:openai-node.reasoning_delta`](#adapter:openai-node.reasoning_delta) | event | [`reasoning.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/reasoning.ts) |
| `sdk.event` | [`adapter:openai-node.sdk.event`](#adapter:openai-node.sdk.event) | event | — |
| `sdk.raw` | [`adapter:openai-node.sdk.raw`](#adapter:openai-node.sdk.raw) | event | — |
| `tool_approval` | [`adapter:openai-node.tool_approval`](#adapter:openai-node.tool_approval) | rpc | [`tool-approval.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/utils/tool-approval.ts) |
| `tool_calls` | [`adapter:openai-node.tool_calls`](#adapter:openai-node.tool_calls) | event | [`tool-calls.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/tool-calls.ts) |
| `tool_completed` | [`adapter:openai-node.tool_completed`](#adapter:openai-node.tool_completed) | event | [`tool-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/namespaces/schemas/tool-lifecycle.ts) |
| `tool_started` | [`adapter:openai-node.tool_started`](#adapter:openai-node.tool_started) | event | [`tool-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/namespaces/schemas/tool-lifecycle.ts) |
| `turn.state_changed` | [`adapter:openai-node.turn.state_changed`](#adapter:openai-node.turn.state_changed) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.step_finished` | [`adapter:openai-node.turn.step_finished`](#adapter:openai-node.turn.step_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.step_started` | [`adapter:openai-node.turn.step_started`](#adapter:openai-node.turn.step_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_finished` | [`adapter:openai-node.turn.turn_finished`](#adapter:openai-node.turn.turn_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_started` | [`adapter:openai-node.turn.turn_started`](#adapter:openai-node.turn.turn_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `usage` | [`adapter:openai-node.usage`](#adapter:openai-node.usage) | event | [`usage.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/openai-node/src/namespaces/schemas/usage.ts) |

## Subject Details

### <a id="adapter:openai-node.agent_complete"></a>`adapter:openai-node.agent_complete` (event)

Schema for agent complete event.
Emitted when agent finishes processing (success or error).

Subject: `adapter:openai-node.agent_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `eventType` | `"agent_complete"` | yes |
| `message` | `string \| undefined` | no |

### <a id="adapter:openai-node.agent_started"></a>`adapter:openai-node.agent_started` (event)

Schema for agent started event.
Emitted when agent begins processing a user message.

Subject: `adapter:openai-node.agent_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"agent_started"` | yes |
| `model` | `string \| undefined` | no |

### <a id="adapter:openai-node.chunk"></a>`adapter:openai-node.chunk` (event)

Schema for streaming chunk event.
Based on OpenAI ChatCompletionChunk structure.

Subject: `adapter:openai-node.chunk`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `choices` | `{ delta: { content?: string \| null \| undefined; role?: "user" \| "assistant" \| "system" \| "tool" \| "developer" \| undefined; refusal?: string \| null \| undefined; tool_calls?: { index: number; id?: string \| undefined; type?: "function" \| undefined; function?: { name?: string \| undefined; arguments?: string \| undefined; } \| undefined; }[] \| undefined; }; index: number; finish_reason: "length" \| "stop" \| "tool_calls" \| "content_filter" \| "function_call" \| null; logprobs?: unknown; }[]` | yes |
| `created` | `number` | yes |
| `eventType` | `"chunk"` | yes |
| `id` | `string` | yes |
| `model` | `string` | yes |
| `object` | `"chat.completion.chunk"` | yes |
| `service_tier` | `"default" \| "priority" \| "auto" \| "flex" \| "scale" \| null \| undefined` | no |
| `system_fingerprint` | `string \| undefined` | no |

### <a id="adapter:openai-node.error"></a>`adapter:openai-node.error` (event)

Schema for error event.
Emitted when an error occurs during processing.

Subject: `adapter:openai-node.error`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `code` | `string \| number \| undefined` | no |
| `eventType` | `"error"` | yes |
| `message` | `string` | yes |
| `type` | `string \| undefined` | no |

### <a id="adapter:openai-node.message_complete"></a>`adapter:openai-node.message_complete` (event)

Schema for message complete event.
Emitted when a full assistant message has been assembled from streaming chunks.
Extends the base schema with OpenAI-specific `finish_reason` values.

Subject: `adapter:openai-node.message_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `string \| null` | yes |
| `eventType` | `"message_complete"` | yes |
| `finish_reason` | `"length" \| "stop" \| "tool_calls" \| "content_filter" \| "function_call" \| null` | yes |
| `reasoning` | `string \| undefined` | no |
| `tool_calls` | `{ id: string; type: "function"; function: { name: string; arguments: string; }; }[] \| undefined` | no |

### <a id="adapter:openai-node.reasoning_complete"></a>`adapter:openai-node.reasoning_complete` (event)

Base schema for a reasoning complete event.

Emitted when the full reasoning / thinking content has been assembled from
all streaming deltas. Does NOT include the Anthropic-specific `signature`
field — the Anthropic adapter extends this schema with `.extend()`.

Adapter-specific schemas may extend this via `.extend()`.

Subject: `adapter:openai-node.reasoning_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `eventType` | `"reasoning_complete"` | yes |

### <a id="adapter:openai-node.reasoning_delta"></a>`adapter:openai-node.reasoning_delta` (event)

Base schema for a reasoning delta event.

Emitted during streaming when the model outputs incremental reasoning /
thinking content. Both Anthropic (extended thinking) and OpenAI-compatible
reasoning models emit this event.

Adapter-specific schemas may extend this via `.extend()`.

Subject: `adapter:openai-node.reasoning_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `eventType` | `"reasoning_delta"` | yes |

### <a id="adapter:openai-node.sdk.event"></a>`adapter:openai-node.sdk.event` (event)

Envelope schema for sdk.event catch-all subject.
Wraps the discriminated union in an envelope for proper TypeScript narrowing at emit time.
Pattern matches codex-mcp's \{ id, msg \} envelope.

Subject: `adapter:openai-node.sdk.event`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `adapterName` | `string \| undefined` | no |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string \| undefined` | no |
| `event` | `{ eventType: "reasoning_delta"; content: string; } \| { eventType: "agent_started"; model?: string \| undefined; } \| { eventType: "agent_complete"; message?: string \| undefined; error?: string \| undefined; } \| { eventType: "error"; message: string; code?: string \| number \| undefined; type?: string \| undefined; } \| { eventType: "tool_started"; toolName: string; toolCallId: string; } \| { eventType: "tool_completed"; toolName: string; toolCallId: string; result: string; success: boolean; } \| { eventType: "tool_calls"; toolCalls: { id: string; type: "function"; function: { name: string; arguments: string; }; }[]; } \| { eventType: "chunk"; id: string; choices: { delta: { content?: string \| null \| undefined; role?: "user" \| "assistant" \| "system" \| "tool" \| "developer" \| undefined; refusal?: string \| null \| undefined; tool_calls?: { index: number; id?: string \| undefined; type?: "function" \| undefined; function?: { name?: string \| undefined; arguments?: string \| undefined; } \| undefined; }[] \| undefined; }; index: number; finish_reason: "length" \| "stop" \| "tool_calls" \| "content_filter" \| "function_call" \| null; logprobs?: unknown; }[]; created: number; model: string; object: "chat.completion.chunk"; service_tier?: "default" \| "priority" \| "auto" \| "flex" \| "scale" \| null \| undefined; system_fingerprint?: string \| undefined; } \| { eventType: "usage"; prompt_tokens: number; completion_tokens: number; total_tokens: number; llmCallId?: string \| undefined; executionId?: string \| undefined; frameId?: string \| undefined; prompt_tokens_details?: { audio_tokens?: number \| undefined; cached_tokens?: number \| undefined; } \| undefined; completion_tokens_details?: { accepted_prediction_tokens?: number \| undefined; audio_tokens?: number \| undefined; reasoning_tokens?: number \| undefined; rejected_prediction_tokens?: number \| undefined; } \| undefined; } \| { eventType: "message_complete"; content: string \| null; finish_reason: "length" \| "stop" \| "tool_calls" \| "content_filter" \| "function_call" \| null; reasoning?: string \| undefined; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string; }; }[] \| undefined; } \| { eventType: "reasoning_complete"; content: string; }` | yes |
| `sessionId` | `string \| undefined` | no |

### <a id="adapter:openai-node.sdk.raw"></a>`adapter:openai-node.sdk.raw` (event)

Schema for raw OpenAI streaming chunks.
Passthrough schema for observability - captures raw API response.
Used by stream-bridge to emit unprocessed chunks before normalization.

Subject: `adapter:openai-node.sdk.raw`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `choices` | `Choice[]` | yes |
| `created` | `number` | yes |
| `id` | `string` | yes |
| `model` | `string` | yes |
| `object` | `"chat.completion.chunk"` | yes |
| `service_tier` | `"default" \| "priority" \| "auto" \| "flex" \| "scale" \| null \| undefined` | no |
| `system_fingerprint` | `string \| undefined` | no |
| `usage` | `CompletionUsage \| null \| undefined` | no |

### <a id="adapter:openai-node.tool_approval"></a>`adapter:openai-node.tool_approval` (rpc)

Scoped tool approval schema for adapter connector buses.

`sessionId` is optional here because the connector emits the approval request
before the agent layer has enriched it. The agent's `wireToolApprovalRpc`
(or equivalent) injects `sessionId` from its own context before forwarding
to the global `AgentSubjects.toolApprove` subject, where `sessionId` is required.

Adapters with a genuinely different wire format (e.g., gemini-sdk's callId/name)
should define their own schema rather than extending this one.

Subject: `adapter:openai-node.tool_approval`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `args` | `Record<string, unknown> \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `reasoning` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `toolCallId` | `string` | yes |
| `toolName` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `action` | `"allow" \| "deny"` | yes |

### <a id="adapter:openai-node.tool_calls"></a>`adapter:openai-node.tool_calls` (event)

Schema for a tool calls event.

Emitted when the model requests tool / function execution.
Both adapters emit this event with the same structure, except the
Anthropic adapter's individual `ToolCall` entries also carry `blockIndex`.

Subject: `adapter:openai-node.tool_calls`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"tool_calls"` | yes |
| `toolCalls` | `{ id: string; type: "function"; function: { name: string; arguments: string; }; }[]` | yes |

### <a id="adapter:openai-node.tool_completed"></a>`adapter:openai-node.tool_completed` (event)

Schema for tool completed event.
Emitted when tool execution finishes (success or failure).

Subject: `adapter:openai-node.tool_completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"tool_completed"` | yes |
| `result` | `string` | yes |
| `success` | `boolean` | yes |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |

### <a id="adapter:openai-node.tool_started"></a>`adapter:openai-node.tool_started` (event)

Schema for tool started event.
Emitted when tool execution begins.

Subject: `adapter:openai-node.tool_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"tool_started"` | yes |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |

### <a id="adapter:openai-node.turn.state_changed"></a>`adapter:openai-node.turn.state_changed` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:openai-node.turn.state_changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:openai-node.turn.step_finished"></a>`adapter:openai-node.turn.step_finished` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:openai-node.turn.step_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:openai-node.turn.step_started"></a>`adapter:openai-node.turn.step_started` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:openai-node.turn.step_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:openai-node.turn.turn_finished"></a>`adapter:openai-node.turn.turn_finished` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:openai-node.turn.turn_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:openai-node.turn.turn_started"></a>`adapter:openai-node.turn.turn_started` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:openai-node.turn.turn_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:openai-node.usage"></a>`adapter:openai-node.usage` (event)

Schema for token usage event.
Based on OpenAI CompletionUsage structure with additional cache fields.

Subject: `adapter:openai-node.usage`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `completion_tokens` | `number` | yes |
| `completion_tokens_details` | `{ accepted_prediction_tokens?: number \| undefined; audio_tokens?: number \| undefined; reasoning_tokens?: number \| undefined; rejected_prediction_tokens?: number \| undefined; } \| undefined` | no |
| `eventType` | `"usage"` | yes |
| `executionId` | `string \| undefined` | no |
| `frameId` | `string \| undefined` | no |
| `llmCallId` | `string \| undefined` | no |
| `prompt_tokens` | `number` | yes |
| `prompt_tokens_details` | `{ audio_tokens?: number \| undefined; cached_tokens?: number \| undefined; } \| undefined` | no |
| `total_tokens` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
