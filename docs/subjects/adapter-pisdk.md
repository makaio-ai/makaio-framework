---
title: "adapter:piSdk"
editUrl: false
prev: false
next: false
---

# `adapter:piSdk`

| Field | Value |
|-------|-------|
| Prefix | `adapter:piSdk` |
| Namespace constant | `PiSdkNamespace` |
| Subjects constant | `PiSdkSubjects` |
| Kind | adapter |
| Schema record | `piSdkSchemas` |
| Tier | framework |
| Package | `@makaio/adapter-pi-sdk` |
| Defined in | [`adapters/implementations/pi-sdk/src/namespaces/index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/pi-sdk/src/namespaces/index.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `agent_complete` | [`adapter:piSdk.agent_complete`](#adapter:piSdk.agent_complete) | event | — |
| `agent_started` | [`adapter:piSdk.agent_started`](#adapter:piSdk.agent_started) | event | — |
| `auto_retry_ended` | [`adapter:piSdk.auto_retry_ended`](#adapter:piSdk.auto_retry_ended) | event | — |
| `auto_retry_started` | [`adapter:piSdk.auto_retry_started`](#adapter:piSdk.auto_retry_started) | event | — |
| `compaction_ended` | [`adapter:piSdk.compaction_ended`](#adapter:piSdk.compaction_ended) | event | — |
| `compaction_started` | [`adapter:piSdk.compaction_started`](#adapter:piSdk.compaction_started) | event | — |
| `error` | [`adapter:piSdk.error`](#adapter:piSdk.error) | event | — |
| `message_complete` | [`adapter:piSdk.message_complete`](#adapter:piSdk.message_complete) | event | — |
| `queue_update` | [`adapter:piSdk.queue_update`](#adapter:piSdk.queue_update) | event | — |
| `sdk.event` | [`adapter:piSdk.sdk.event`](#adapter:piSdk.sdk.event) | event | — |
| `text_complete` | [`adapter:piSdk.text_complete`](#adapter:piSdk.text_complete) | event | — |
| `text_delta` | [`adapter:piSdk.text_delta`](#adapter:piSdk.text_delta) | event | — |
| `thinking_complete` | [`adapter:piSdk.thinking_complete`](#adapter:piSdk.thinking_complete) | event | — |
| `thinking_delta` | [`adapter:piSdk.thinking_delta`](#adapter:piSdk.thinking_delta) | event | — |
| `tool_approval` | [`adapter:piSdk.tool_approval`](#adapter:piSdk.tool_approval) | rpc | [`tool-approval.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/utils/tool-approval.ts) |
| `tool_completed` | [`adapter:piSdk.tool_completed`](#adapter:piSdk.tool_completed) | event | — |
| `tool_started` | [`adapter:piSdk.tool_started`](#adapter:piSdk.tool_started) | event | — |
| `turn.state_changed` | [`adapter:piSdk.turn.state_changed`](#adapter:piSdk.turn.state_changed) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.step_finished` | [`adapter:piSdk.turn.step_finished`](#adapter:piSdk.turn.step_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.step_started` | [`adapter:piSdk.turn.step_started`](#adapter:piSdk.turn.step_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_finished` | [`adapter:piSdk.turn.turn_finished`](#adapter:piSdk.turn.turn_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_started` | [`adapter:piSdk.turn.turn_started`](#adapter:piSdk.turn.turn_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `usage` | [`adapter:piSdk.usage`](#adapter:piSdk.usage) | event | — |

## Subject Details

### <a id="adapter:piSdk.agent_complete"></a>`adapter:piSdk.agent_complete` (event)

Agent has finished a full prompt run.
Mapped from Pi's agent_end event.

NOTE: Pi's agent_end carries the full conversation messages array via
event.messages, which differs from the shared AgentCompleteEventSchema
(message: string | undefined). A Pi-specific schema preserves the full payload.
Field: `messages` (unknown[]).

Subject: `adapter:piSdk.agent_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"agent_complete"` | yes |
| `messages` | `unknown[]` | yes |
| `text` | `string \| undefined` | no |

### <a id="adapter:piSdk.agent_started"></a>`adapter:piSdk.agent_started` (event)

Agent has started processing a prompt.
Mapped from Pi's agent_start event.

Subject: `adapter:piSdk.agent_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"agent_started"` | yes |
| `model` | `string \| undefined` | no |

### <a id="adapter:piSdk.auto_retry_ended"></a>`adapter:piSdk.auto_retry_ended` (event)

Automatic retry has ended (either succeeded or exhausted retries).
Mapped from Pi's auto_retry_end event.

Subject: `adapter:piSdk.auto_retry_ended`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"auto_retry_ended"` | yes |

### <a id="adapter:piSdk.auto_retry_started"></a>`adapter:piSdk.auto_retry_started` (event)

Automatic retry of a failed API call has started.
Pi SDK retries transiently failed requests automatically.
Mapped from Pi's auto_retry_start event.

Subject: `adapter:piSdk.auto_retry_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"auto_retry_started"` | yes |

### <a id="adapter:piSdk.compaction_ended"></a>`adapter:piSdk.compaction_ended` (event)

Context compaction has finished.
Mapped from Pi's compaction_end event.

Subject: `adapter:piSdk.compaction_ended`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"compaction_ended"` | yes |

### <a id="adapter:piSdk.compaction_started"></a>`adapter:piSdk.compaction_started` (event)

Context compaction has started.
Pi SDK compacts the conversation history when the context window fills.
Mapped from Pi's compaction_start event.

Subject: `adapter:piSdk.compaction_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"compaction_started"` | yes |

### <a id="adapter:piSdk.error"></a>`adapter:piSdk.error` (event)

An error occurred during processing.

NOTE: Pi SDK surfaces structured error objects rather than plain error strings.
`error` is typed as unknown rather than using the shared ErrorEventSchema's
`message: string` field to avoid data loss. Field: `error` (unknown).

Subject: `adapter:piSdk.error`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `unknown` | yes |
| `eventType` | `"error"` | yes |

### <a id="adapter:piSdk.message_complete"></a>`adapter:piSdk.message_complete` (event)

Full message object emitted when a single message finishes.
Mapped from Pi's message_end event.

Pi's message shape: `{ role, content, usage, stopReason, errorMessage }`

Subject: `adapter:piSdk.message_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"message_complete"` | yes |
| `message` | `unknown` | yes |

### <a id="adapter:piSdk.queue_update"></a>`adapter:piSdk.queue_update` (event)

Queue position or status update from the Pi SDK.
Mapped from Pi's queue_update event.

Subject: `adapter:piSdk.queue_update`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"queue_update"` | yes |

### <a id="adapter:piSdk.sdk.event"></a>`adapter:piSdk.sdk.event` (event)

Loose schema for raw Pi SDK events from session.subscribe().

Uses loose object mode to avoid coupling to Pi SDK's exact internal types while
retaining the `type` discriminator for observability routing.
Semantic subjects below carry normalized, framework-conventional payloads.

Subject: `adapter:piSdk.sdk.event`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `type` | `string` | yes |

### <a id="adapter:piSdk.text_complete"></a>`adapter:piSdk.text_complete` (event)

Text generation complete for the current message.
Mapped from Pi's message_update when assistantMessageEvent.type === 'text_end'.

Subject: `adapter:piSdk.text_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"text_complete"` | yes |
| `text` | `string` | yes |

### <a id="adapter:piSdk.text_delta"></a>`adapter:piSdk.text_delta` (event)

Streaming text delta from the model's current response message.
Mapped from Pi's message_update when assistantMessageEvent.type === 'text_delta'.

Subject: `adapter:piSdk.text_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `string` | yes |
| `eventType` | `"text_delta"` | yes |

### <a id="adapter:piSdk.thinking_complete"></a>`adapter:piSdk.thinking_complete` (event)

Thinking/reasoning complete for the current message.
Mapped from Pi's message_update when assistantMessageEvent.type === 'thinking_end'.

Subject: `adapter:piSdk.thinking_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"thinking_complete"` | yes |
| `text` | `string` | yes |

### <a id="adapter:piSdk.thinking_delta"></a>`adapter:piSdk.thinking_delta` (event)

Streaming thinking/reasoning delta from the model's internal chain-of-thought.
Mapped from Pi's message_update when assistantMessageEvent.type === 'thinking_delta'.

Subject: `adapter:piSdk.thinking_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `string` | yes |
| `eventType` | `"thinking_delta"` | yes |

### <a id="adapter:piSdk.tool_approval"></a>`adapter:piSdk.tool_approval` (rpc)

Scoped tool approval schema for adapter connector buses.

`sessionId` is optional here because the connector emits the approval request
before the agent layer has enriched it. The agent's `wireToolApprovalRpc`
(or equivalent) injects `sessionId` from its own context before forwarding
to the global `AgentSubjects.toolApprove` subject, where `sessionId` is required.

Adapters with a genuinely different wire format (e.g., gemini-sdk's callId/name)
should define their own schema rather than extending this one.

Subject: `adapter:piSdk.tool_approval`
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

### <a id="adapter:piSdk.tool_completed"></a>`adapter:piSdk.tool_completed` (event)

Tool execution has completed (success or error).
Mapped from Pi's tool_execution_end event.

NOTE: This intentionally deviates from the shared ToolCompletedEventSchema
(result: z.string(), success: boolean). Pi SDK surfaces a structured result
object and an `isError` flag; serializing to a plain string would be lossy.
Fields: `toolName`, `toolCallId`, `result` (unknown), `isError`.

Subject: `adapter:piSdk.tool_completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"tool_completed"` | yes |
| `isError` | `boolean` | yes |
| `messageId` | `string` | yes |
| `result` | `unknown` | yes |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |

### <a id="adapter:piSdk.tool_started"></a>`adapter:piSdk.tool_started` (event)

Tool execution has started.
Mapped from Pi's tool_execution_start event.

Subject: `adapter:piSdk.tool_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `args` | `Record<string, unknown> \| undefined` | no |
| `eventType` | `"tool_started"` | yes |
| `messageId` | `string` | yes |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |

### <a id="adapter:piSdk.turn.state_changed"></a>`adapter:piSdk.turn.state_changed` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:piSdk.turn.state_changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:piSdk.turn.step_finished"></a>`adapter:piSdk.turn.step_finished` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:piSdk.turn.step_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:piSdk.turn.step_started"></a>`adapter:piSdk.turn.step_started` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:piSdk.turn.step_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:piSdk.turn.turn_finished"></a>`adapter:piSdk.turn.turn_finished` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:piSdk.turn.turn_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:piSdk.turn.turn_started"></a>`adapter:piSdk.turn.turn_started` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:piSdk.turn.turn_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:piSdk.usage"></a>`adapter:piSdk.usage` (event)

Token usage summary for a completed message or turn.
Pi SDK emits usage data within message_end's message payload.

Pi's usage shape: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`

Subject: `adapter:piSdk.usage`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"usage"` | yes |
| `usage` | `unknown` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
