---
title: "adapter:cursorSdk"
editUrl: false
prev: false
next: false
---

# `adapter:cursorSdk`

| Field | Value |
|-------|-------|
| Prefix | `adapter:cursorSdk` |
| Namespace constant | `CursorSdkNamespace` |
| Subjects constant | `CursorSdkSubjects` |
| Kind | adapter |
| Schema record | `cursorSdkSchemas` |
| Tier | framework |
| Package | `@makaio/adapter-cursor-sdk` |
| Defined in | [`adapters/implementations/cursor-sdk/src/namespaces/index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/cursor-sdk/src/namespaces/index.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `agent_complete` | [`adapter:cursorSdk.agent_complete`](#adapter:cursorSdk.agent_complete) | event | — |
| `agent_started` | [`adapter:cursorSdk.agent_started`](#adapter:cursorSdk.agent_started) | event | — |
| `error` | [`adapter:cursorSdk.error`](#adapter:cursorSdk.error) | event | — |
| `message_complete` | [`adapter:cursorSdk.message_complete`](#adapter:cursorSdk.message_complete) | event | — |
| `run.created` | [`adapter:cursorSdk.run.created`](#adapter:cursorSdk.run.created) | event | — |
| `sdk.event` | [`adapter:cursorSdk.sdk.event`](#adapter:cursorSdk.sdk.event) | event | — |
| `shell_output_delta` | [`adapter:cursorSdk.shell_output_delta`](#adapter:cursorSdk.shell_output_delta) | event | — |
| `status_changed` | [`adapter:cursorSdk.status_changed`](#adapter:cursorSdk.status_changed) | event | — |
| `summary_complete` | [`adapter:cursorSdk.summary_complete`](#adapter:cursorSdk.summary_complete) | event | — |
| `summary_started` | [`adapter:cursorSdk.summary_started`](#adapter:cursorSdk.summary_started) | event | — |
| `text_complete` | [`adapter:cursorSdk.text_complete`](#adapter:cursorSdk.text_complete) | event | — |
| `text_delta` | [`adapter:cursorSdk.text_delta`](#adapter:cursorSdk.text_delta) | event | — |
| `thinking_complete` | [`adapter:cursorSdk.thinking_complete`](#adapter:cursorSdk.thinking_complete) | event | — |
| `thinking_delta` | [`adapter:cursorSdk.thinking_delta`](#adapter:cursorSdk.thinking_delta) | event | — |
| `tool_approval` | [`adapter:cursorSdk.tool_approval`](#adapter:cursorSdk.tool_approval) | rpc | [`tool-approval.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/utils/tool-approval.ts) |
| `tool_completed` | [`adapter:cursorSdk.tool_completed`](#adapter:cursorSdk.tool_completed) | event | — |
| `tool_started` | [`adapter:cursorSdk.tool_started`](#adapter:cursorSdk.tool_started) | event | — |
| `turn.state_changed` | [`adapter:cursorSdk.turn.state_changed`](#adapter:cursorSdk.turn.state_changed) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.step_finished` | [`adapter:cursorSdk.turn.step_finished`](#adapter:cursorSdk.turn.step_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.step_started` | [`adapter:cursorSdk.turn.step_started`](#adapter:cursorSdk.turn.step_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_finished` | [`adapter:cursorSdk.turn.turn_finished`](#adapter:cursorSdk.turn.turn_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_started` | [`adapter:cursorSdk.turn.turn_started`](#adapter:cursorSdk.turn.turn_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `usage` | [`adapter:cursorSdk.usage`](#adapter:cursorSdk.usage) | event | — |

## Subject Details

### <a id="adapter:cursorSdk.agent_complete"></a>`adapter:cursorSdk.agent_complete` (event)

Agent has finished a full prompt run.
Mapped from Cursor's turn-ended event.

Subject: `adapter:cursorSdk.agent_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `durationMs` | `number \| undefined` | no |
| `eventType` | `"agent_complete"` | yes |
| `result` | `unknown` | no |

### <a id="adapter:cursorSdk.agent_started"></a>`adapter:cursorSdk.agent_started` (event)

Agent has started processing a prompt.
Mapped from Cursor's run.created event.

Subject: `adapter:cursorSdk.agent_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"agent_started"` | yes |
| `model` | `string \| undefined` | no |
| `runId` | `string` | yes |

### <a id="adapter:cursorSdk.error"></a>`adapter:cursorSdk.error` (event)

An error occurred during processing.

NOTE: Cursor SDK may surface structured error objects rather than plain strings.
`error` is typed as unknown to avoid data loss.

Subject: `adapter:cursorSdk.error`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `unknown` | yes |
| `eventType` | `"error"` | yes |
| `message` | `string \| undefined` | no |

### <a id="adapter:cursorSdk.message_complete"></a>`adapter:cursorSdk.message_complete` (event)

Full message object emitted when a single message finishes.
Typed as unknown to avoid coupling to the SDK's exact shape.

Subject: `adapter:cursorSdk.message_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `unknown` | yes |
| `eventType` | `"message_complete"` | yes |

### <a id="adapter:cursorSdk.run.created"></a>`adapter:cursorSdk.run.created` (event)

A new Cursor run has been created for this turn.
Mapped from Cursor's run.created event.

Subject: `adapter:cursorSdk.run.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"run.created"` | yes |
| `runId` | `string` | yes |

### <a id="adapter:cursorSdk.sdk.event"></a>`adapter:cursorSdk.sdk.event` (event)

Loose schema for raw Cursor SDK events from agent.send() onDelta.

Uses loose object mode to avoid coupling to Cursor SDK's exact internal types
while retaining the `type` discriminator for observability routing.
Semantic subjects below carry normalized, framework-conventional payloads.

Subject: `adapter:cursorSdk.sdk.event`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `type` | `string` | yes |

### <a id="adapter:cursorSdk.shell_output_delta"></a>`adapter:cursorSdk.shell_output_delta` (event)

Streaming shell command output delta.
Mapped from Cursor's InteractionUpdate when type === 'shell-output-delta'.

Subject: `adapter:cursorSdk.shell_output_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `string` | yes |
| `eventType` | `"shell_output_delta"` | yes |

### <a id="adapter:cursorSdk.status_changed"></a>`adapter:cursorSdk.status_changed` (event)

Agent operational status has changed.
Mapped from Cursor's status-changed event.

Subject: `adapter:cursorSdk.status_changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"status_changed"` | yes |
| `message` | `string \| undefined` | no |
| `status` | `string` | yes |

### <a id="adapter:cursorSdk.summary_complete"></a>`adapter:cursorSdk.summary_complete` (event)

Agent has completed its summary.
Mapped from Cursor's summary-completed event.

Subject: `adapter:cursorSdk.summary_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"summary_complete"` | yes |
| `text` | `string` | yes |

### <a id="adapter:cursorSdk.summary_started"></a>`adapter:cursorSdk.summary_started` (event)

Agent has started generating a summary of its actions.
Mapped from Cursor's summary-started event.

Subject: `adapter:cursorSdk.summary_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"summary_started"` | yes |

### <a id="adapter:cursorSdk.text_complete"></a>`adapter:cursorSdk.text_complete` (event)

Text generation complete for the current message.
Synthesized from accumulated text_delta events.

Subject: `adapter:cursorSdk.text_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"text_complete"` | yes |
| `text` | `string` | yes |

### <a id="adapter:cursorSdk.text_delta"></a>`adapter:cursorSdk.text_delta` (event)

Streaming text delta from the model's current response message.
Mapped from Cursor's InteractionUpdate when type === 'text-delta'.

Subject: `adapter:cursorSdk.text_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `string` | yes |
| `eventType` | `"text_delta"` | yes |

### <a id="adapter:cursorSdk.thinking_complete"></a>`adapter:cursorSdk.thinking_complete` (event)

Thinking/reasoning complete for the current message.
Mapped from Cursor's InteractionUpdate when type === 'thinking-completed'.

Subject: `adapter:cursorSdk.thinking_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `durationMs` | `number \| undefined` | no |
| `eventType` | `"thinking_complete"` | yes |
| `text` | `string` | yes |

### <a id="adapter:cursorSdk.thinking_delta"></a>`adapter:cursorSdk.thinking_delta` (event)

Streaming thinking/reasoning delta from the model's internal chain-of-thought.
Mapped from Cursor's InteractionUpdate when type === 'thinking-delta'.

Subject: `adapter:cursorSdk.thinking_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `string` | yes |
| `eventType` | `"thinking_delta"` | yes |

### <a id="adapter:cursorSdk.tool_approval"></a>`adapter:cursorSdk.tool_approval` (rpc)

Scoped tool approval schema for adapter connector buses.

`sessionId` is optional here because the connector emits the approval request
before the agent layer has enriched it. The agent's `wireToolApprovalRpc`
(or equivalent) injects `sessionId` from its own context before forwarding
to the global `AgentSubjects.toolApprove` subject, where `sessionId` is required.

Adapters with a genuinely different wire format (e.g., gemini-sdk's callId/name)
should define their own schema rather than extending this one.

Subject: `adapter:cursorSdk.tool_approval`
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

### <a id="adapter:cursorSdk.tool_completed"></a>`adapter:cursorSdk.tool_completed` (event)

Tool execution has completed (success or error).
Mapped from Cursor's InteractionUpdate when type === 'tool-call-completed'.

NOTE: Cursor SDK surfaces a structured result object and an `isError` flag;
serializing to a plain string would be lossy. Fields: toolName, toolCallId,
result (unknown), isError.

Subject: `adapter:cursorSdk.tool_completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"tool_completed"` | yes |
| `isError` | `boolean` | yes |
| `result` | `unknown` | yes |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |

### <a id="adapter:cursorSdk.tool_started"></a>`adapter:cursorSdk.tool_started` (event)

Tool execution has started.
Mapped from Cursor's InteractionUpdate when type === 'tool-call-started'.

Subject: `adapter:cursorSdk.tool_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `args` | `unknown` | no |
| `eventType` | `"tool_started"` | yes |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |

### <a id="adapter:cursorSdk.turn.state_changed"></a>`adapter:cursorSdk.turn.state_changed` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:cursorSdk.turn.state_changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:cursorSdk.turn.step_finished"></a>`adapter:cursorSdk.turn.step_finished` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:cursorSdk.turn.step_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:cursorSdk.turn.step_started"></a>`adapter:cursorSdk.turn.step_started` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:cursorSdk.turn.step_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:cursorSdk.turn.turn_finished"></a>`adapter:cursorSdk.turn.turn_finished` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:cursorSdk.turn.turn_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:cursorSdk.turn.turn_started"></a>`adapter:cursorSdk.turn.turn_started` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:cursorSdk.turn.turn_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:cursorSdk.usage"></a>`adapter:cursorSdk.usage` (event)

Token usage summary for a completed message or turn.

Subject: `adapter:cursorSdk.usage`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `eventType` | `"usage"` | yes |
| `usage` | `unknown` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
