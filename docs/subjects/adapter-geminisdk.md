---
title: "adapter:geminiSDK"
editUrl: false
prev: false
next: false
---

# `adapter:geminiSDK`

| Field | Value |
|-------|-------|
| Prefix | `adapter:geminiSDK` |
| Namespace constant | `GeminiConnectorNamespace` |
| Subjects constant | `GeminiConnectorSubjects` |
| Kind | adapter |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/adapter-gemini-sdk` |
| Defined in | [`adapters/implementations/gemini-sdk/src/namespaces/index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/gemini-sdk/src/namespaces/index.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `acp.tool_approval` | [`adapter:geminiSDK.acp.tool_approval`](#adapter:geminiSDK.acp.tool_approval) | rpc | [`tool-approval.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/gemini-sdk/src/namespaces/schemas/tool-approval.ts) |
| `agent.message.chunk` | [`adapter:geminiSDK.agent.message.chunk`](#adapter:geminiSDK.agent.message.chunk) | event | — |
| `agent.thought.chunk` | [`adapter:geminiSDK.agent.thought.chunk`](#adapter:geminiSDK.agent.thought.chunk) | event | — |
| `agent.tool.started` | [`adapter:geminiSDK.agent.tool.started`](#adapter:geminiSDK.agent.tool.started) | event | — |
| `agent.tool.updated` | [`adapter:geminiSDK.agent.tool.updated`](#adapter:geminiSDK.agent.tool.updated) | event | — |
| `sdk.event` | [`adapter:geminiSDK.sdk.event`](#adapter:geminiSDK.sdk.event) | event | — |
| `session.completed` | [`adapter:geminiSDK.session.completed`](#adapter:geminiSDK.session.completed) | event | — |
| `session.created` | [`adapter:geminiSDK.session.created`](#adapter:geminiSDK.session.created) | event | — |
| `session.error` | [`adapter:geminiSDK.session.error`](#adapter:geminiSDK.session.error) | event | — |
| `session.finished` | [`adapter:geminiSDK.session.finished`](#adapter:geminiSDK.session.finished) | event | — |
| `turn.state_changed` | [`adapter:geminiSDK.turn.state_changed`](#adapter:geminiSDK.turn.state_changed) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/gemini-sdk/src/namespaces/schemas/turn-state.ts) |
| `turn.step_finished` | [`adapter:geminiSDK.turn.step_finished`](#adapter:geminiSDK.turn.step_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/gemini-sdk/src/namespaces/schemas/turn-state.ts) |
| `turn.step_started` | [`adapter:geminiSDK.turn.step_started`](#adapter:geminiSDK.turn.step_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/gemini-sdk/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_finished` | [`adapter:geminiSDK.turn.turn_finished`](#adapter:geminiSDK.turn.turn_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/gemini-sdk/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_started` | [`adapter:geminiSDK.turn.turn_started`](#adapter:geminiSDK.turn.turn_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/gemini-sdk/src/namespaces/schemas/turn-state.ts) |

## Subject Details

### <a id="adapter:geminiSDK.acp.tool_approval"></a>`adapter:geminiSDK.acp.tool_approval` (rpc)

Schema for Gemini tool approval request/response.
Mirrors `ToolCallRequestInfo` from `@google/gemini-cli-core` for SDK-level approval.

Request uses Gemini-native structure, response uses generic approval schema.

Subject: `adapter:geminiSDK.acp.tool_approval`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `agentId` | `string` | yes |
| `args` | `Record<string, unknown>` | yes |
| `callId` | `string` | yes |
| `isClientInitiated` | `boolean` | yes |
| `name` | `string` | yes |
| `prompt_id` | `string` | yes |
| `reasoning` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `action` | `"allow" \| "deny"` | yes |
| `message` | `string \| undefined` | no |
| `shouldAbort` | `boolean \| undefined` | no |
| `updatedInput` | `Record<string, unknown> \| undefined` | no |
| `updatedPermissions` | `unknown[] \| undefined` | no |

### <a id="adapter:geminiSDK.agent.message.chunk"></a>`adapter:geminiSDK.agent.message.chunk` (event)

Subject: `adapter:geminiSDK.agent.message.chunk`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `ContentBlock` | yes |
| `type` | `"agent.message.chunk"` | yes |

### <a id="adapter:geminiSDK.agent.thought.chunk"></a>`adapter:geminiSDK.agent.thought.chunk` (event)

Subject: `adapter:geminiSDK.agent.thought.chunk`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `ContentBlock` | yes |
| `type` | `"agent.thought.chunk"` | yes |

### <a id="adapter:geminiSDK.agent.tool.started"></a>`adapter:geminiSDK.agent.tool.started` (event)

Tool started event - emitted when tool execution begins

Subject: `adapter:geminiSDK.agent.tool.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `kind` | `string` | yes |
| `rawInput` | `unknown` | no |
| `status` | `string` | yes |
| `title` | `string` | yes |
| `toolCallId` | `string` | yes |
| `type` | `"agent.tool.started"` | yes |

### <a id="adapter:geminiSDK.agent.tool.updated"></a>`adapter:geminiSDK.agent.tool.updated` (event)

Tool updated event - emitted when tool execution completes or status changes

Subject: `adapter:geminiSDK.agent.tool.updated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `output` | `unknown` | no |
| `status` | `string \| null \| undefined` | no |
| `toolCallId` | `string` | yes |
| `type` | `"agent.tool.updated"` | yes |

### <a id="adapter:geminiSDK.sdk.event"></a>`adapter:geminiSDK.sdk.event` (event)

Subject: `adapter:geminiSDK.sdk.event`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `ContentBlock \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `error` | `string \| undefined` | no |
| `kind` | `string \| undefined` | no |
| `message` | `string \| undefined` | no |
| `model` | `string \| undefined` | no |
| `output` | `unknown \| undefined` | no |
| `raw` | `ServerGeminiStreamEvent \| undefined` | no |
| `rawInput` | `unknown \| undefined` | no |
| `reason` | `"FINISH_REASON_UNSPECIFIED" \| "STOP" \| "MAX_TOKENS" \| "SAFETY" \| "RECITATION" \| "LANGUAGE" \| "OTHER" \| "BLOCKLIST" \| "PROHIBITED_CONTENT" \| "SPII" \| "MALFORMED_FUNCTION_CALL" \| "IMAGE_SAFETY" \| "UNEXPECTED_TOOL_CALL" \| "IMAGE_PROHIBITED_CONTENT" \| "NO_IMAGE" \| "IMAGE_RECITATION" \| "IMAGE_OTHER" \| undefined` | no |
| `status` | `number \| undefined \| string \| null` | no |
| `title` | `string \| undefined` | no |
| `toolCallId` | `string \| undefined` | no |
| `type` | `"session.created" \| "session.completed" \| "session.finished" \| "session.error" \| "agent.message.chunk" \| "agent.thought.chunk" \| "agent.tool.started" \| "agent.tool.updated" \| "sdk.raw"` | yes |
| `usageMetadata` | `{ cachedContentTokenCount?: number \| undefined; candidatesTokenCount?: number \| undefined; promptTokenCount?: number \| undefined; thoughtsTokenCount?: number \| undefined; toolUsePromptTokenCount?: number \| undefined; totalTokenCount?: number \| undefined; trafficType?: string \| undefined; } \| undefined` | no |

### <a id="adapter:geminiSDK.session.completed"></a>`adapter:geminiSDK.session.completed` (event)

Session completed event - emitted when turn completes with response

Subject: `adapter:geminiSDK.session.completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `message` | `string` | yes |
| `type` | `"session.completed"` | yes |

### <a id="adapter:geminiSDK.session.created"></a>`adapter:geminiSDK.session.created` (event)

Session created event - emitted when session is initialized

Subject: `adapter:geminiSDK.session.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `cwd` | `string` | yes |
| `model` | `string` | yes |
| `type` | `"session.created"` | yes |

### <a id="adapter:geminiSDK.session.error"></a>`adapter:geminiSDK.session.error` (event)

Session error event - emitted on SDK errors

Subject: `adapter:geminiSDK.session.error`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `string` | yes |
| `status` | `number \| undefined` | no |
| `type` | `"session.error"` | yes |

### <a id="adapter:geminiSDK.session.finished"></a>`adapter:geminiSDK.session.finished` (event)

Session finished event - emitted with usage metadata after turn ends

Subject: `adapter:geminiSDK.session.finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `model` | `string \| undefined` | no |
| `reason` | `"FINISH_REASON_UNSPECIFIED" \| "STOP" \| "MAX_TOKENS" \| "SAFETY" \| "RECITATION" \| "LANGUAGE" \| "OTHER" \| "BLOCKLIST" \| "PROHIBITED_CONTENT" \| "SPII" \| "MALFORMED_FUNCTION_CALL" \| "IMAGE_SAFETY" \| "UNEXPECTED_TOOL_CALL" \| "IMAGE_PROHIBITED_CONTENT" \| "NO_IMAGE" \| "IMAGE_RECITATION" \| "IMAGE_OTHER" \| undefined` | no |
| `type` | `"session.finished"` | yes |
| `usageMetadata` | `{ cachedContentTokenCount?: number \| undefined; candidatesTokenCount?: number \| undefined; promptTokenCount?: number \| undefined; thoughtsTokenCount?: number \| undefined; toolUsePromptTokenCount?: number \| undefined; totalTokenCount?: number \| undefined; trafficType?: string \| undefined; } \| undefined` | no |

### <a id="adapter:geminiSDK.turn.state_changed"></a>`adapter:geminiSDK.turn.state_changed` (event)

Turn state change event

Subject: `adapter:geminiSDK.turn.state_changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:geminiSDK.turn.step_finished"></a>`adapter:geminiSDK.turn.step_finished` (event)

Turn state change event

Subject: `adapter:geminiSDK.turn.step_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:geminiSDK.turn.step_started"></a>`adapter:geminiSDK.turn.step_started` (event)

Turn state change event

Subject: `adapter:geminiSDK.turn.step_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:geminiSDK.turn.turn_finished"></a>`adapter:geminiSDK.turn.turn_finished` (event)

Turn state change event

Subject: `adapter:geminiSDK.turn.turn_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:geminiSDK.turn.turn_started"></a>`adapter:geminiSDK.turn.turn_started` (event)

Turn state change event

Subject: `adapter:geminiSDK.turn.turn_started`
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
