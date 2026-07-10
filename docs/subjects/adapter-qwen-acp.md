---
title: "adapter:qwen-acp"
editUrl: false
prev: false
next: false
---

# `adapter:qwen-acp`

| Field | Value |
|-------|-------|
| Prefix | `adapter:qwen-acp` |
| Namespace constant | `QwenAcpNamespace` |
| Subjects constant | `QwenAcpSubjects` |
| Kind | adapter |
| Schema record | `qwenAcpSchemas` |
| Tier | framework |
| Package | `@makaio/adapter-qwen-acp` |
| Defined in | [`adapters/implementations/qwen-acp/src/namespaces/index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/qwen-acp/src/namespaces/index.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `permission_request` | [`adapter:qwen-acp.permission_request`](#adapter:qwen-acp.permission_request) | rpc | [`tool-approval.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/utils/tool-approval.ts) |
| `session_update_context_window` | [`adapter:qwen-acp.session_update_context_window`](#adapter:qwen-acp.session_update_context_window) | event | — |
| `session_update_message_chunk` | [`adapter:qwen-acp.session_update_message_chunk`](#adapter:qwen-acp.session_update_message_chunk) | event | — |
| `session_update_thought_chunk` | [`adapter:qwen-acp.session_update_thought_chunk`](#adapter:qwen-acp.session_update_thought_chunk) | event | — |
| `session_update_tool_call` | [`adapter:qwen-acp.session_update_tool_call`](#adapter:qwen-acp.session_update_tool_call) | event | — |
| `session_update_tool_call_update` | [`adapter:qwen-acp.session_update_tool_call_update`](#adapter:qwen-acp.session_update_tool_call_update) | event | — |
| `session_update_usage` | [`adapter:qwen-acp.session_update_usage`](#adapter:qwen-acp.session_update_usage) | event | — |
| `turn_finished` | [`adapter:qwen-acp.turn_finished`](#adapter:qwen-acp.turn_finished) | event | — |
| `turn_started` | [`adapter:qwen-acp.turn_started`](#adapter:qwen-acp.turn_started) | event | — |
| `turn_state_changed` | [`adapter:qwen-acp.turn_state_changed`](#adapter:qwen-acp.turn_state_changed) | event | — |
| `turn_step_finished` | [`adapter:qwen-acp.turn_step_finished`](#adapter:qwen-acp.turn_step_finished) | event | — |
| `turn_step_started` | [`adapter:qwen-acp.turn_step_started`](#adapter:qwen-acp.turn_step_started) | event | — |
| `turn_text_completed` | [`adapter:qwen-acp.turn_text_completed`](#adapter:qwen-acp.turn_text_completed) | event | — |

## Subject Details

### <a id="adapter:qwen-acp.permission_request"></a>`adapter:qwen-acp.permission_request` (rpc)

Scoped tool approval schema for adapter connector buses.

`sessionId` is optional here because the connector emits the approval request
before the agent layer has enriched it. The agent's `wireToolApprovalRpc`
(or equivalent) injects `sessionId` from its own context before forwarding
to the global `AgentSubjects.toolApprove` subject, where `sessionId` is required.

Adapters with a genuinely different wire format (e.g., gemini-sdk's callId/name)
should define their own schema rather than extending this one.

Subject: `adapter:qwen-acp.permission_request`
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

### <a id="adapter:qwen-acp.session_update_context_window"></a>`adapter:qwen-acp.session_update_context_window` (event)

Emitted when the ACP `usage_update` notification is received, carrying
the full context-window capacity and current occupancy.

`size` is the model's context window limit in tokens.
`used` is the number of tokens currently occupying the context.

Subject: `adapter:qwen-acp.session_update_context_window`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `size` | `number` | yes |
| `timestamp` | `number` | yes |
| `used` | `number` | yes |

### <a id="adapter:qwen-acp.session_update_message_chunk"></a>`adapter:qwen-acp.session_update_message_chunk` (event)

Streaming text delta from the model's response message.

Subject: `adapter:qwen-acp.session_update_message_chunk`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `string` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:qwen-acp.session_update_thought_chunk"></a>`adapter:qwen-acp.session_update_thought_chunk` (event)

Streaming text delta from the model's internal reasoning/thinking.

Subject: `adapter:qwen-acp.session_update_thought_chunk`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `string` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:qwen-acp.session_update_tool_call"></a>`adapter:qwen-acp.session_update_tool_call` (event)

Emitted when the model initiates a tool call.

Subject: `adapter:qwen-acp.session_update_tool_call`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `kind` | `string \| undefined` | no |
| `rawInput` | `unknown` | no |
| `timestamp` | `number` | yes |
| `title` | `string` | yes |
| `toolCallId` | `string` | yes |

### <a id="adapter:qwen-acp.session_update_tool_call_update"></a>`adapter:qwen-acp.session_update_tool_call_update` (event)

Emitted when a tool call completes or its status changes.

Subject: `adapter:qwen-acp.session_update_tool_call_update`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `rawOutput` | `unknown` | no |
| `status` | `string \| undefined` | no |
| `timestamp` | `number` | yes |
| `toolCallId` | `string` | yes |

### <a id="adapter:qwen-acp.session_update_usage"></a>`adapter:qwen-acp.session_update_usage` (event)

Emitted with token usage information from `agent_message_chunk._meta.usage`.

Fields mirror the Qwen Code ACP agent's per-turn usage payload:
`inputTokens`, `outputTokens`, `totalTokens`, `thoughtTokens`, `cachedReadTokens`.

Subject: `adapter:qwen-acp.session_update_usage`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `cachedReadTokens` | `number \| undefined` | no |
| `inputTokens` | `number \| undefined` | no |
| `outputTokens` | `number \| undefined` | no |
| `thoughtTokens` | `number \| undefined` | no |
| `timestamp` | `number` | yes |
| `totalTokens` | `number \| undefined` | no |

### <a id="adapter:qwen-acp.turn_finished"></a>`adapter:qwen-acp.turn_finished` (event)

Emitted when an agent turn ends (normally or via error).

Subject: `adapter:qwen-acp.turn_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `stopReason` | `string \| undefined` | no |
| `timestamp` | `number` | yes |

### <a id="adapter:qwen-acp.turn_started"></a>`adapter:qwen-acp.turn_started` (event)

Emitted when a new agent turn begins.

Subject: `adapter:qwen-acp.turn_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:qwen-acp.turn_state_changed"></a>`adapter:qwen-acp.turn_state_changed` (event)

Emitted on each state transition within a turn's state machine.

Subject: `adapter:qwen-acp.turn_state_changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `newState` | `string` | yes |
| `previousState` | `string` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:qwen-acp.turn_step_finished"></a>`adapter:qwen-acp.turn_step_finished` (event)

Emitted when a discrete step within a turn finishes.

Subject: `adapter:qwen-acp.turn_step_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `stepType` | `string` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:qwen-acp.turn_step_started"></a>`adapter:qwen-acp.turn_step_started` (event)

Emitted when a discrete step within a turn starts (e.g., tool call, generation).

Subject: `adapter:qwen-acp.turn_step_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `stepType` | `string` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:qwen-acp.turn_text_completed"></a>`adapter:qwen-acp.turn_text_completed` (event)

Emitted by the connector after a prompt turn completes successfully.

Carries the full accumulated text so the agent can forward it to
`AgentSubjects.message` for session persistence.
Emitted directly by the connector via `bus.emit()`, so `agentId` must
be included explicitly (same pattern as turn lifecycle events).

Subject: `adapter:qwen-acp.turn_text_completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `text` | `string` | yes |
| `timestamp` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
