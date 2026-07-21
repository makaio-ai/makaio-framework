---
title: "adapter:claude-code-tmux"
editUrl: false
prev: false
next: false
---

# `adapter:claude-code-tmux`

| Field | Value |
|-------|-------|
| Prefix | `adapter:claude-code-tmux` |
| Namespace constant | `ClaudeCodeTmuxConnectorNamespace` |
| Subjects constant | `ClaudeCodeTmuxConnectorSubjects` |
| Kind | adapter |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/adapter-claude-code-tmux` |
| Defined in | [`adapters/implementations/claude-code-tmux/src/namespace/index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/claude-code-tmux/src/namespace/index.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `tool_approval` | [`adapter:claude-code-tmux.tool_approval`](#adapter:claude-code-tmux.tool_approval) | rpc | [`tool-approval.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/utils/tool-approval.ts) |
| `tool_use.finished` | [`adapter:claude-code-tmux.tool_use.finished`](#adapter:claude-code-tmux.tool_use.finished) | event | — |
| `tool_use.started` | [`adapter:claude-code-tmux.tool_use.started`](#adapter:claude-code-tmux.tool_use.started) | event | — |
| `turn.state_changed` | [`adapter:claude-code-tmux.turn.state_changed`](#adapter:claude-code-tmux.turn.state_changed) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.step_finished` | [`adapter:claude-code-tmux.turn.step_finished`](#adapter:claude-code-tmux.turn.step_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.step_started` | [`adapter:claude-code-tmux.turn.step_started`](#adapter:claude-code-tmux.turn.step_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_completed` | [`adapter:claude-code-tmux.turn.turn_completed`](#adapter:claude-code-tmux.turn.turn_completed) | event | — |
| `turn.turn_finished` | [`adapter:claude-code-tmux.turn.turn_finished`](#adapter:claude-code-tmux.turn.turn_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_started` | [`adapter:claude-code-tmux.turn.turn_started`](#adapter:claude-code-tmux.turn.turn_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/shared/stream-session/src/namespaces/schemas/turn-state.ts) |

## Subject Details

### <a id="adapter:claude-code-tmux.tool_approval"></a>`adapter:claude-code-tmux.tool_approval` (rpc)

Scoped tool approval schema for adapter connector buses.

`sessionId` is optional here because the connector emits the approval request
before the agent layer has enriched it. The agent's `wireToolApprovalRpc`
(or equivalent) injects `sessionId` from its own context before forwarding
to the global `AgentSubjects.toolApprove` subject, where `sessionId` is required.

Adapters with a genuinely different wire format (e.g., gemini-sdk's callId/name)
should define their own schema rather than extending this one.

Subject: `adapter:claude-code-tmux.tool_approval`
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
| `message` | `string \| undefined` | no |
| `shouldAbort` | `boolean \| undefined` | no |
| `updatedInput` | `Record<string, unknown> \| undefined` | no |
| `updatedPermissions` | `unknown[] \| undefined` | no |

### <a id="adapter:claude-code-tmux.tool_use.finished"></a>`adapter:claude-code-tmux.tool_use.finished` (event)

Payload for `tool_use.finished` — metadata from the PostToolUse hook.

Subject: `adapter:claude-code-tmux.tool_use.finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `isError` | `boolean \| undefined` | no |
| `messageId` | `string` | yes |
| `toolName` | `string` | yes |
| `toolResult` | `unknown` | no |
| `toolUseId` | `string` | yes |

### <a id="adapter:claude-code-tmux.tool_use.started"></a>`adapter:claude-code-tmux.tool_use.started` (event)

Payload for `tool_use.started` — metadata from the PreToolUse hook.

Subject: `adapter:claude-code-tmux.tool_use.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `messageId` | `string` | yes |
| `toolInput` | `unknown` | no |
| `toolName` | `string` | yes |
| `toolUseId` | `string` | yes |

### <a id="adapter:claude-code-tmux.turn.state_changed"></a>`adapter:claude-code-tmux.turn.state_changed` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:claude-code-tmux.turn.state_changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:claude-code-tmux.turn.step_finished"></a>`adapter:claude-code-tmux.turn.step_finished` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:claude-code-tmux.turn.step_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:claude-code-tmux.turn.step_started"></a>`adapter:claude-code-tmux.turn.step_started` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:claude-code-tmux.turn.step_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:claude-code-tmux.turn.turn_completed"></a>`adapter:claude-code-tmux.turn.turn_completed` (event)

Payload for `turn.turn_completed` — carries the assistant's final response text.

Distinct from `turn.turn_finished` (a state-machine transition signal):
`turn_completed` is the semantic "assistant produced a response" event that
the agent layer translates to `AgentSubjects.message` for session persistence.

Subject: `adapter:claude-code-tmux.turn.turn_completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `message` | `string` | yes |

### <a id="adapter:claude-code-tmux.turn.turn_finished"></a>`adapter:claude-code-tmux.turn.turn_finished` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:claude-code-tmux.turn.turn_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:claude-code-tmux.turn.turn_started"></a>`adapter:claude-code-tmux.turn.turn_started` (event)

Schema for a turn state change event.
Emitted by adapters whenever the turn state machine transitions.

Subject: `adapter:claude-code-tmux.turn.turn_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
