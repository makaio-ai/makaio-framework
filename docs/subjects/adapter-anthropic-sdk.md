---
title: "adapter:anthropic-sdk"
editUrl: false
prev: false
next: false
---

# `adapter:anthropic-sdk`

| Field | Value |
|-------|-------|
| Prefix | `adapter:anthropic-sdk` |
| Namespace constant | `AnthropicSdkConnectorNamespace` |
| Subjects constant | `AnthropicSdkConnectorSubjects` |
| Kind | adapter |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/adapter-anthropic-sdk` |
| Defined in | [`adapters/implementations/anthropic-sdk/src/namespaces/index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/anthropic-sdk/src/namespaces/index.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `agent_complete` | [`adapter:anthropic-sdk.agent_complete`](#adapter:anthropic-sdk.agent_complete) | event | [`lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/namespaces/schemas/lifecycle.ts) |
| `agent_started` | [`adapter:anthropic-sdk.agent_started`](#adapter:anthropic-sdk.agent_started) | event | [`lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/namespaces/schemas/lifecycle.ts) |
| `chunk` | [`adapter:anthropic-sdk.chunk`](#adapter:anthropic-sdk.chunk) | event | [`chunk.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/anthropic-sdk/src/namespaces/schemas/chunk.ts) |
| `error` | [`adapter:anthropic-sdk.error`](#adapter:anthropic-sdk.error) | event | [`lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/namespaces/schemas/lifecycle.ts) |
| `message_complete` | [`adapter:anthropic-sdk.message_complete`](#adapter:anthropic-sdk.message_complete) | event | [`message.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/anthropic-sdk/src/namespaces/schemas/message.ts) |
| `reasoning_complete` | [`adapter:anthropic-sdk.reasoning_complete`](#adapter:anthropic-sdk.reasoning_complete) | event | [`reasoning.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/anthropic-sdk/src/namespaces/schemas/reasoning.ts) |
| `reasoning_delta` | [`adapter:anthropic-sdk.reasoning_delta`](#adapter:anthropic-sdk.reasoning_delta) | event | [`reasoning.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/anthropic-sdk/src/namespaces/schemas/reasoning.ts) |
| `sdk.event` | [`adapter:anthropic-sdk.sdk.event`](#adapter:anthropic-sdk.sdk.event) | event | — |
| `sdk.raw` | [`adapter:anthropic-sdk.sdk.raw`](#adapter:anthropic-sdk.sdk.raw) | event | — |
| `tool_approval` | [`adapter:anthropic-sdk.tool_approval`](#adapter:anthropic-sdk.tool_approval) | rpc | [`tool-approval.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/utils/tool-approval.ts) |
| `tool_calls` | [`adapter:anthropic-sdk.tool_calls`](#adapter:anthropic-sdk.tool_calls) | event | [`tool-calls.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/anthropic-sdk/src/namespaces/schemas/tool-calls.ts) |
| `tool_completed` | [`adapter:anthropic-sdk.tool_completed`](#adapter:anthropic-sdk.tool_completed) | event | [`tool-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/namespaces/schemas/tool-lifecycle.ts) |
| `tool_started` | [`adapter:anthropic-sdk.tool_started`](#adapter:anthropic-sdk.tool_started) | event | [`tool-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/namespaces/schemas/tool-lifecycle.ts) |
| `turn.state_changed` | [`adapter:anthropic-sdk.turn.state_changed`](#adapter:anthropic-sdk.turn.state_changed) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.step_finished` | [`adapter:anthropic-sdk.turn.step_finished`](#adapter:anthropic-sdk.turn.step_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.step_started` | [`adapter:anthropic-sdk.turn.step_started`](#adapter:anthropic-sdk.turn.step_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_finished` | [`adapter:anthropic-sdk.turn.turn_finished`](#adapter:anthropic-sdk.turn.turn_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_started` | [`adapter:anthropic-sdk.turn.turn_started`](#adapter:anthropic-sdk.turn.turn_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `usage` | [`adapter:anthropic-sdk.usage`](#adapter:anthropic-sdk.usage) | event | [`usage.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/anthropic-sdk/src/namespaces/schemas/usage.ts) |

## Subject Details

### <a id="adapter:anthropic-sdk.agent_complete"></a>`adapter:anthropic-sdk.agent_complete` (event)

Schema for agent complete event.
Emitted when agent finishes processing (success or error).

Subject: `adapter:anthropic-sdk.agent_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `eventType` | `"agent_complete"` | yes |
| `message` | `string \| undefined` | no |

### <a id="adapter:anthropic-sdk.agent_started"></a>`adapter:anthropic-sdk.agent_started` (event)

Schema for agent started event.
Emitted when agent begins processing a user message.

Subject: `adapter:anthropic-sdk.agent_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"agent_started"` | yes |
| `model` | `string \| undefined` | no |

### <a id="adapter:anthropic-sdk.chunk"></a>`adapter:anthropic-sdk.chunk` (event)

Schema for streaming chunk event.
Based on Anthropic RawContentBlockDeltaEvent structure.

Subject: `adapter:anthropic-sdk.chunk`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `{ type: "text_delta"; text: string; } \| { type: "thinking_delta"; thinking: string; } \| { type: "input_json_delta"; partial_json: string; }` | yes |
| `eventType` | `"chunk"` | yes |
| `index` | `number` | yes |

### <a id="adapter:anthropic-sdk.error"></a>`adapter:anthropic-sdk.error` (event)

Schema for error event.
Emitted when an error occurs during processing.

Subject: `adapter:anthropic-sdk.error`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `code` | `string \| number \| undefined` | no |
| `eventType` | `"error"` | yes |
| `message` | `string` | yes |
| `type` | `string \| undefined` | no |

### <a id="adapter:anthropic-sdk.message_complete"></a>`adapter:anthropic-sdk.message_complete` (event)

Schema for message complete event.
Emitted when a full assistant message has been assembled from streaming chunks.
Extends the base schema with Anthropic-specific `finish_reason` values
(including `pause_turn`) and the `blockIndex` field on tool calls.

Subject: `adapter:anthropic-sdk.message_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `string \| null` | yes |
| `eventType` | `"message_complete"` | yes |
| `finish_reason` | `"tool_use" \| "end_turn" \| "max_tokens" \| "stop_sequence" \| "pause_turn" \| null` | yes |
| `reasoning` | `string \| undefined` | no |
| `tool_calls` | `{ id: string; blockIndex: number; type: "function"; function: { name: string; arguments: string; }; }[] \| undefined` | no |

### <a id="adapter:anthropic-sdk.reasoning_complete"></a>`adapter:anthropic-sdk.reasoning_complete` (event)

Schema for reasoning complete event.
Emitted when full reasoning/thinking content has been assembled.
Extends the base schema with the Anthropic-specific `signature` field.

Subject: `adapter:anthropic-sdk.reasoning_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `eventType` | `"reasoning_complete"` | yes |
| `signature` | `string \| undefined` | no |

### <a id="adapter:anthropic-sdk.reasoning_delta"></a>`adapter:anthropic-sdk.reasoning_delta` (event)

Schema for reasoning delta event.
Emitted during streaming when the model outputs extended thinking content.
Supported by Anthropic models with extended thinking enabled.

Subject: `adapter:anthropic-sdk.reasoning_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `eventType` | `"reasoning_delta"` | yes |

### <a id="adapter:anthropic-sdk.sdk.event"></a>`adapter:anthropic-sdk.sdk.event` (event)

Envelope schema for sdk.event catch-all subject.
Wraps the discriminated union in an envelope for proper TypeScript narrowing at emit time.
Pattern matches codex-mcp's \{ id, msg \} envelope.

Subject: `adapter:anthropic-sdk.sdk.event`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `adapterName` | `string \| undefined` | no |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string \| undefined` | no |
| `event` | `{ eventType: "chunk"; index: number; delta: { type: "text_delta"; text: string; } \| { type: "thinking_delta"; thinking: string; } \| { type: "input_json_delta"; partial_json: string; }; } \| { eventType: "usage"; prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_read_input_tokens?: number \| undefined; cache_creation_input_tokens?: number \| undefined; } \| { eventType: "tool_calls"; toolCalls: { id: string; type: "function"; function: { name: string; arguments: string; }; blockIndex: number; }[]; } \| { eventType: "message_complete"; content: string \| null; finish_reason: "tool_use" \| "end_turn" \| "max_tokens" \| "stop_sequence" \| "pause_turn" \| null; reasoning?: string \| undefined; tool_calls?: { id: string; blockIndex: number; type: "function"; function: { name: string; arguments: string; }; }[] \| undefined; } \| { eventType: "reasoning_delta"; content: string; } \| { eventType: "reasoning_complete"; content: string; signature?: string \| undefined; } \| { eventType: "agent_started"; model?: string \| undefined; } \| { eventType: "agent_complete"; message?: string \| undefined; error?: string \| undefined; } \| { eventType: "error"; message: string; code?: string \| number \| undefined; type?: string \| undefined; } \| { eventType: "tool_started"; toolName: string; toolCallId: string; } \| { eventType: "tool_completed"; toolName: string; toolCallId: string; result: string; success: boolean; }` | yes |
| `sessionId` | `string \| undefined` | no |

### <a id="adapter:anthropic-sdk.sdk.raw"></a>`adapter:anthropic-sdk.sdk.raw` (event)

Schema for raw Anthropic streaming events.
Passthrough schema for observability - captures raw API response.
Used by stream-bridge to emit unprocessed events before normalization.

Subject: `adapter:anthropic-sdk.sdk.raw`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `type` | `"message_delta" \| "message_start" \| "message_stop" \| "content_block_start" \| "content_block_delta" \| "content_block_stop"` | yes |

### <a id="adapter:anthropic-sdk.tool_approval"></a>`adapter:anthropic-sdk.tool_approval` (rpc)

Scoped tool approval schema for adapter connector buses.

`sessionId` is optional here because the connector emits the approval request
before the agent layer has enriched it. The agent's `wireToolApprovalRpc`
(or equivalent) injects `sessionId` from its own context before forwarding
to the global `AgentSubjects.toolApprove` subject, where `sessionId` is required.

Adapters with a genuinely different wire format (e.g., gemini-sdk's callId/name)
should define their own schema rather than extending this one.

Subject: `adapter:anthropic-sdk.tool_approval`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
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

### <a id="adapter:anthropic-sdk.tool_calls"></a>`adapter:anthropic-sdk.tool_calls` (event)

Schema for tool calls event.
Emitted when the model requests tool/function execution.

Subject: `adapter:anthropic-sdk.tool_calls`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"tool_calls"` | yes |
| `toolCalls` | `{ id: string; type: "function"; function: { name: string; arguments: string; }; blockIndex: number; }[]` | yes |

### <a id="adapter:anthropic-sdk.tool_completed"></a>`adapter:anthropic-sdk.tool_completed` (event)

Schema for tool completed event.
Emitted when tool execution finishes (success or failure).

Subject: `adapter:anthropic-sdk.tool_completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"tool_completed"` | yes |
| `result` | `string` | yes |
| `success` | `boolean` | yes |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |

### <a id="adapter:anthropic-sdk.tool_started"></a>`adapter:anthropic-sdk.tool_started` (event)

Schema for tool started event.
Emitted when tool execution begins.

Subject: `adapter:anthropic-sdk.tool_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"tool_started"` | yes |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |

### <a id="adapter:anthropic-sdk.turn.state_changed"></a>`adapter:anthropic-sdk.turn.state_changed` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:anthropic-sdk.turn.state_changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:anthropic-sdk.turn.step_finished"></a>`adapter:anthropic-sdk.turn.step_finished` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:anthropic-sdk.turn.step_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:anthropic-sdk.turn.step_started"></a>`adapter:anthropic-sdk.turn.step_started` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:anthropic-sdk.turn.step_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:anthropic-sdk.turn.turn_finished"></a>`adapter:anthropic-sdk.turn.turn_finished` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:anthropic-sdk.turn.turn_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:anthropic-sdk.turn.turn_started"></a>`adapter:anthropic-sdk.turn.turn_started` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:anthropic-sdk.turn.turn_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:anthropic-sdk.usage"></a>`adapter:anthropic-sdk.usage` (event)

Schema for token usage event.
Based on Anthropic Usage structure.

Subject: `adapter:anthropic-sdk.usage`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `cache_creation_input_tokens` | `number \| undefined` | no |
| `cache_read_input_tokens` | `number \| undefined` | no |
| `completion_tokens` | `number` | yes |
| `eventType` | `"usage"` | yes |
| `prompt_tokens` | `number` | yes |
| `total_tokens` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
