---
title: "adapter:codex-app-server"
editUrl: false
prev: false
next: false
---

# `adapter:codex-app-server`

| Field | Value |
|-------|-------|
| Prefix | `adapter:codex-app-server` |
| Namespace constant | `CodexAppServerNamespace` |
| Subjects constant | `CodexAppServerSubjects` |
| Kind | adapter |
| Schema record | `codexAppServerSchemas` |
| Tier | framework |
| Package | `@makaio/adapter-codex-app-server` |
| Defined in | [`adapters/implementations/codex-app-server/src/namespaces/index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/index.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `agent_message` | [`adapter:codex-app-server.agent_message`](#adapter:codex-app-server.agent_message) | event | [`agent-message.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/agent-message.ts) |
| `agent_message_delta` | [`adapter:codex-app-server.agent_message_delta`](#adapter:codex-app-server.agent_message_delta) | event | [`agent-message.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/agent-message.ts) |
| `dynamic_tool_call_approval_request` | [`adapter:codex-app-server.dynamic_tool_call_approval_request`](#adapter:codex-app-server.dynamic_tool_call_approval_request) | rpc | [`dynamic-tool-call.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/dynamic-tool-call.ts) |
| `dynamic_tool_call_begin` | [`adapter:codex-app-server.dynamic_tool_call_begin`](#adapter:codex-app-server.dynamic_tool_call_begin) | event | [`dynamic-tool-call.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/dynamic-tool-call.ts) |
| `dynamic_tool_call_end` | [`adapter:codex-app-server.dynamic_tool_call_end`](#adapter:codex-app-server.dynamic_tool_call_end) | event | [`dynamic-tool-call.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/dynamic-tool-call.ts) |
| `exec_approval_request` | [`adapter:codex-app-server.exec_approval_request`](#adapter:codex-app-server.exec_approval_request) | rpc | [`command-execution.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/command-execution.ts) |
| `exec_command_begin` | [`adapter:codex-app-server.exec_command_begin`](#adapter:codex-app-server.exec_command_begin) | event | [`command-execution.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/command-execution.ts) |
| `exec_command_end` | [`adapter:codex-app-server.exec_command_end`](#adapter:codex-app-server.exec_command_end) | event | [`command-execution.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/command-execution.ts) |
| `exec_command_output_delta` | [`adapter:codex-app-server.exec_command_output_delta`](#adapter:codex-app-server.exec_command_output_delta) | event | [`command-execution.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/command-execution.ts) |
| `file_change_approval_request` | [`adapter:codex-app-server.file_change_approval_request`](#adapter:codex-app-server.file_change_approval_request) | rpc | [`file-change.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/file-change.ts) |
| `file_change_output_delta` | [`adapter:codex-app-server.file_change_output_delta`](#adapter:codex-app-server.file_change_output_delta) | event | [`file-change.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/file-change.ts) |
| `item_completed` | [`adapter:codex-app-server.item_completed`](#adapter:codex-app-server.item_completed) | event | [`item-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/item-lifecycle.ts) |
| `item_started` | [`adapter:codex-app-server.item_started`](#adapter:codex-app-server.item_started) | event | [`item-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/item-lifecycle.ts) |
| `reasoning` | [`adapter:codex-app-server.reasoning`](#adapter:codex-app-server.reasoning) | event | [`reasoning.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/reasoning.ts) |
| `reasoning_delta` | [`adapter:codex-app-server.reasoning_delta`](#adapter:codex-app-server.reasoning_delta) | event | [`reasoning.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/reasoning.ts) |
| `thread_completed` | [`adapter:codex-app-server.thread_completed`](#adapter:codex-app-server.thread_completed) | event | [`thread-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/thread-lifecycle.ts) |
| `thread_started` | [`adapter:codex-app-server.thread_started`](#adapter:codex-app-server.thread_started) | event | [`thread-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/thread-lifecycle.ts) |
| `token_usage` | [`adapter:codex-app-server.token_usage`](#adapter:codex-app-server.token_usage) | event | [`token-usage.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/token-usage.ts) |
| `turn_completed` | [`adapter:codex-app-server.turn_completed`](#adapter:codex-app-server.turn_completed) | event | [`turn-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/turn-lifecycle.ts) |
| `turn_started` | [`adapter:codex-app-server.turn_started`](#adapter:codex-app-server.turn_started) | event | [`turn-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/turn-lifecycle.ts) |
| `turn_state_changed` | [`adapter:codex-app-server.turn_state_changed`](#adapter:codex-app-server.turn_state_changed) | event | [`turn-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/turn-lifecycle.ts) |
| `turn_step_finished` | [`adapter:codex-app-server.turn_step_finished`](#adapter:codex-app-server.turn_step_finished) | event | [`turn-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/turn-lifecycle.ts) |
| `turn_step_started` | [`adapter:codex-app-server.turn_step_started`](#adapter:codex-app-server.turn_step_started) | event | [`turn-lifecycle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/codex-app-server/src/namespaces/schemas/turn-lifecycle.ts) |

## Subject Details

### <a id="adapter:codex-app-server.agent_message"></a>`adapter:codex-app-server.agent_message` (event)

Schema for agent_message event
Emitted when a complete agent message is ready

Subject: `adapter:codex-app-server.agent_message`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `message` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.agent_message_delta"></a>`adapter:codex-app-server.agent_message_delta` (event)

Schema for agent_message.delta event
Emitted for incremental text updates from the agent

Subject: `adapter:codex-app-server.agent_message_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.dynamic_tool_call_approval_request"></a>`adapter:codex-app-server.dynamic_tool_call_approval_request` (rpc)

Schema for dynamic_tool_call_approval_request RPC.

Request/response pair for dynamic tool call approval routing via scoped bus.
Connector calls requestToolApproval → approval handler routes to global bus → returns response.

Note: Enrichment fields (agentId, adapterId, etc.) are auto-injected by requestToolApproval.

Subject: `adapter:codex-app-server.dynamic_tool_call_approval_request`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `adapterName` | `string \| undefined` | no |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string \| undefined` | no |
| `args` | `Record<string, unknown>` | yes |
| `itemId` | `string` | yes |
| `name` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `decision` | `"accept" \| "decline"` | yes |
| `message` | `string \| undefined` | no |

### <a id="adapter:codex-app-server.dynamic_tool_call_begin"></a>`adapter:codex-app-server.dynamic_tool_call_begin` (event)

Schema for dynamic_tool_call_begin event.

Emitted when an `item/started` notification arrives for a `dynamicToolCall` item.
The `name` and `args` fields are populated from the cached `item/tool/call` server
request that was handled before (or concurrent with) the `item/started` notification.

Subject: `adapter:codex-app-server.dynamic_tool_call_begin`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `args` | `Record<string, unknown>` | yes |
| `itemId` | `string` | yes |
| `name` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.dynamic_tool_call_end"></a>`adapter:codex-app-server.dynamic_tool_call_end` (event)

Schema for dynamic_tool_call_end event.

Emitted when an `item/completed` notification arrives for a `dynamicToolCall` item.
The `output` and `success` fields are populated from the cached tool execution result.

Subject: `adapter:codex-app-server.dynamic_tool_call_end`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `itemId` | `string` | yes |
| `name` | `string` | yes |
| `output` | `string` | yes |
| `success` | `boolean` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.exec_approval_request"></a>`adapter:codex-app-server.exec_approval_request` (rpc)

Schema for exec_approval_request RPC
Request/response pair for command approval routing via scoped bus.
Connector calls requestToolApproval → registerToolApprovalHandler routes to global bus → returns response.

Note: Enrichment fields (agentId, adapterId, etc.) are auto-injected by requestToolApproval.

Subject: `adapter:codex-app-server.exec_approval_request`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `adapterName` | `string \| undefined` | no |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string \| undefined` | no |
| `callId` | `string` | yes |
| `command` | `string[]` | yes |
| `cwd` | `string` | yes |
| `reason` | `string \| null` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `decision` | `"accept" \| "decline"` | yes |
| `message` | `string \| undefined` | no |

### <a id="adapter:codex-app-server.exec_command_begin"></a>`adapter:codex-app-server.exec_command_begin` (event)

Schema for exec_command.begin event
Emitted when a command execution starts

Subject: `adapter:codex-app-server.exec_command_begin`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `callId` | `string` | yes |
| `command` | `string[]` | yes |
| `cwd` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.exec_command_end"></a>`adapter:codex-app-server.exec_command_end` (event)

Schema for exec_command.end event
Emitted when a command execution completes

Subject: `adapter:codex-app-server.exec_command_end`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `callId` | `string` | yes |
| `exitCode` | `number` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.exec_command_output_delta"></a>`adapter:codex-app-server.exec_command_output_delta` (event)

Schema for exec_command.output.delta event
Emitted for incremental output from a running command

Subject: `adapter:codex-app-server.exec_command_output_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `callId` | `string` | yes |
| `chunk` | `string` | yes |
| `stream` | `"stdout" \| "stderr"` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.file_change_approval_request"></a>`adapter:codex-app-server.file_change_approval_request` (rpc)

Schema for file_change_approval_request RPC
Request/response pair for file change approval routing via scoped bus.
Connector calls requestToolApproval → registerToolApprovalHandler routes to global bus → returns response.

Note: Enrichment fields (agentId, adapterId, etc.) are auto-injected by requestToolApproval.

Subject: `adapter:codex-app-server.file_change_approval_request`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `adapterName` | `string \| undefined` | no |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string \| undefined` | no |
| `grantRoot` | `string \| null` | yes |
| `itemId` | `string` | yes |
| `reason` | `string \| null` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `decision` | `"accept" \| "decline"` | yes |
| `message` | `string \| undefined` | no |

### <a id="adapter:codex-app-server.file_change_output_delta"></a>`adapter:codex-app-server.file_change_output_delta` (event)

Schema for file_change.output.delta event
Emitted for incremental file change updates

Subject: `adapter:codex-app-server.file_change_output_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `string` | yes |
| `itemId` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.item_completed"></a>`adapter:codex-app-server.item_completed` (event)

Schema for item.completed event
Emitted when an item completes

Subject: `adapter:codex-app-server.item_completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `itemId` | `string` | yes |
| `itemType` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.item_started"></a>`adapter:codex-app-server.item_started` (event)

Schema for item.started event
Emitted when an item begins execution

Subject: `adapter:codex-app-server.item_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `itemId` | `string` | yes |
| `itemType` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.reasoning"></a>`adapter:codex-app-server.reasoning` (event)

Schema for reasoning event
Emitted when complete reasoning is available

Subject: `adapter:codex-app-server.reasoning`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `reasoning` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.reasoning_delta"></a>`adapter:codex-app-server.reasoning_delta` (event)

Schema for reasoning.delta event
Emitted for incremental reasoning content

Subject: `adapter:codex-app-server.reasoning_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `delta` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.thread_completed"></a>`adapter:codex-app-server.thread_completed` (event)

Schema for thread.completed event
Emitted when a thread is archived or completed.

Note: agentId is required for bus filtering to work correctly.

Subject: `adapter:codex-app-server.thread_completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:codex-app-server.thread_started"></a>`adapter:codex-app-server.thread_started` (event)

Schema for thread.started event
Emitted when a new thread is successfully started.

Note: agentId is required for bus filtering to work correctly.
The filteredBus.on() filters events by agentId.

Subject: `adapter:codex-app-server.thread_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:codex-app-server.token_usage"></a>`adapter:codex-app-server.token_usage` (event)

Schema for token_usage event
Emitted when token usage is updated.

Note: agentId is required for bus filtering to work correctly.

Subject: `adapter:codex-app-server.token_usage`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `completionTokens` | `number` | yes |
| `inputCachedTokens` | `number` | yes |
| `modelContextWindow` | `number \| undefined` | no |
| `promptTokens` | `number` | yes |
| `reasoningTokens` | `number` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `totalTokens` | `number` | yes |
| `turnId` | `string \| undefined` | no |

### <a id="adapter:codex-app-server.turn_completed"></a>`adapter:codex-app-server.turn_completed` (event)

Schema for turn.completed event
Emitted when a turn completes (turn_finished state).

Note: agentId is required for bus filtering to work correctly.

Subject: `adapter:codex-app-server.turn_completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.turn_started"></a>`adapter:codex-app-server.turn_started` (event)

Schema for turn.started event
Emitted when a turn begins processing (turn_started state).

Note: agentId is required for bus filtering to work correctly.

Subject: `adapter:codex-app-server.turn_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.turn_state_changed"></a>`adapter:codex-app-server.turn_state_changed` (event)

Turn state change event
Emitted whenever turn state transitions

Subject: `adapter:codex-app-server.turn_state_changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"active" \| "idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished" \| "processing_started" \| "interrupted"` | yes |
| `oldState` | `"active" \| "idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished" \| "processing_started" \| "interrupted"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:codex-app-server.turn_step_finished"></a>`adapter:codex-app-server.turn_step_finished` (event)

Schema for turn.step_finished event
Emitted when a step/item completes.

Note: agentId is required for bus filtering to work correctly.

Subject: `adapter:codex-app-server.turn_step_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `itemId` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

### <a id="adapter:codex-app-server.turn_step_started"></a>`adapter:codex-app-server.turn_step_started` (event)

Schema for turn.step_started event
Emitted when a step/item begins execution.

Note: agentId is required for bus filtering to work correctly.

Subject: `adapter:codex-app-server.turn_step_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `itemId` | `string` | yes |
| `threadId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
