---
title: "agent"
editUrl: false
prev: false
next: false
---

# `agent`

| Field | Value |
|-------|-------|
| Prefix | `agent` |
| Namespace constant | `AgentNamespace` |
| Subjects constant | `AgentSubjects` |
| Kind | bus |
| Schema record | `AgentSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/agent/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `complete` | [`agent.complete`](#agent.complete) | event | [`complete.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/complete.ts) |
| `contextWindow.updated` | [`agent.contextWindow.updated`](#agent.contextWindow.updated) | event | [`context-window.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/context-window.ts) |
| `credential.change` | [`agent.credential.change`](#agent.credential.change) | rpc | [`credential-change.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/credential-change.ts) |
| `cwd.change` | [`agent.cwd.change`](#agent.cwd.change) | rpc | [`cwd-change.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/cwd-change.ts) |
| `cwd.changed` | [`agent.cwd.changed`](#agent.cwd.changed) | event | [`cwd-change.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/cwd-change.ts) |
| `getCapabilities` | [`agent.getCapabilities`](#agent.getCapabilities) | rpc | [`get-capabilities.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/get-capabilities.ts) |
| `idle` | [`agent.idle`](#agent.idle) | event | [`idle.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/idle.ts) |
| `interrupt` | [`agent.interrupt`](#agent.interrupt) | rpc | [`interrupt.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/interrupt.ts) |
| `mcp.servers.set` | [`agent.mcp.servers.set`](#agent.mcp.servers.set) | rpc | [`mcp-servers-set.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/mcp-servers-set.ts) |
| `message` | [`agent.message`](#agent.message) | event | [`message.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/message.ts) |
| `message_delta` | [`agent.message_delta`](#agent.message_delta) | event | [`message.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/message.ts) |
| `model.change` | [`agent.model.change`](#agent.model.change) | rpc | [`model-change.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/model-change.ts) |
| `model.changed` | [`agent.model.changed`](#agent.model.changed) | event | [`model-changed.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/model-changed.ts) |
| `reasoning` | [`agent.reasoning`](#agent.reasoning) | event | [`reasoning.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/reasoning.ts) |
| `reasoning_delta` | [`agent.reasoning_delta`](#agent.reasoning_delta) | event | [`reasoning.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/reasoning.ts) |
| `sendMessage` | [`agent.sendMessage`](#agent.sendMessage) | rpc | [`send-message.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/send-message.ts) |
| `session.closed` | [`agent.session.closed`](#agent.session.closed) | event | [`session-closed.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/session-closed.ts) |
| `started` | [`agent.started`](#agent.started) | event | [`started.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/started.ts) |
| `step.finished` | [`agent.step.finished`](#agent.step.finished) | event | [`step.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/step.ts) |
| `step.started` | [`agent.step.started`](#agent.step.started) | event | [`step.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/step.ts) |
| `structuredOutput.enforce` | [`agent.structuredOutput.enforce`](#agent.structuredOutput.enforce) | rpc | [`structured-output.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/structured-output.ts) |
| `structuredOutput.retryPolicy` | [`agent.structuredOutput.retryPolicy`](#agent.structuredOutput.retryPolicy) | rpc | [`structured-output.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/structured-output.ts) |
| `tool.completed` | [`agent.tool.completed`](#agent.tool.completed) | event | [`tool.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/tool.ts) |
| `tool.output` | [`agent.tool.output`](#agent.tool.output) | event | [`tool.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/tool.ts) |
| `tool.started` | [`agent.tool.started`](#agent.tool.started) | event | [`tool.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/tool.ts) |
| `tool.use` | [`agent.tool.use`](#agent.tool.use) | event | [`tool.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/tool.ts) |
| `toolApprove` | [`agent.toolApprove`](#agent.toolApprove) | rpc | [`tool-approve.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/tool-approve.ts) |
| `turn.completed` | [`agent.turn.completed`](#agent.turn.completed) | event | [`turn.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/turn.ts) |
| `turn.started` | [`agent.turn.started`](#agent.turn.started) | event | [`turn.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/turn.ts) |
| `usage` | [`agent.usage`](#agent.usage) | event | [`usage.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/usage.ts) |
| `user_message.acknowledged` | [`agent.user_message.acknowledged`](#agent.user_message.acknowledged) | event | [`user-message-acknowledged.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/user-message-acknowledged.ts) |
| `user_message.completed` | [`agent.user_message.completed`](#agent.user_message.completed) | event | [`user-message-completed.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/user-message-completed.ts) |
| `user_message.sent` | [`agent.user_message.sent`](#agent.user_message.sent) | event | [`user-message-sent.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/user-message-sent.ts) |
| `validateModelChange` | [`agent.validateModelChange`](#agent.validateModelChange) | rpc | [`validate-model-change.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/agent/schemas/validate-model-change.ts) |

## Subject Details

### <a id="agent.complete"></a>`agent.complete` (event)

Agent turn completed (any terminal outcome).

Subject: `agent.complete`
Type: Event (fire-and-forget)
Emitted when: An agent finishes processing a turn — success or error.

Consumers can inspect `outcome` to distinguish success from failure:
- `completed` — normal completion, `message` contains the response
- `error` — processing failed, `error` contains the reason
- `superseded` / `merged` / `cancelled` / `rejected` — non-error terminal states

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `error` | `string \| undefined` | no |
| `errorCategory` | `"rate_limit" \| "auth" \| "model_unavailable" \| "quota_exceeded" \| undefined` | no |
| `message` | `string \| undefined` | no |
| `messageId` | `string` | yes |
| `occurredAt` | `number \| undefined` | no |
| `outcome` | `"error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected" \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `structuredOutputValidation` | `{ status: "passed"; } \| { status: "enforced"; } \| { status: "failed"; errors: { message: string; instancePath: string; schemaPath: string; }[]; } \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.contextWindow.updated"></a>`agent.contextWindow.updated` (event)

Context window status after a turn completes.

Subject: `agent.contextWindow.updated`
Type: Event (fire-and-forget)
Emitted when: After each turn completes with usage data

Used by orchestration layer to trigger compression when thresholds are reached.

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `cachedTokens` | `number \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `currentTokens` | `number` | yes |
| `level` | `"warn" \| "ok" \| "critical"` | yes |
| `maxTokens` | `number` | yes |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `percentage` | `number` | yes |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.credential.change"></a>`agent.credential.change` (rpc)

Request to change agent credentials mid-session.

Subject: `agent.credential.change`
Type: Request/Response
Sent when: Credential state changes (account-manager rotation or user config update)
Handler: AIAgent re-resolves credentials, rebuilds connector if SDK-based

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `changeSequence` | `number` | yes |
| `clientId` | `string \| undefined` | no |
| `credentialRefs` | `Record<string, string>` | yes |
| `definitionId` | `string` | yes |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string` | yes |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="agent.cwd.change"></a>`agent.cwd.change` (rpc)

Request to change the agent working directory.

Subject: `agent.cwd.change`
Type: Request/Response
Sent when: Caller detects agent's cwd differs from desired cwd
Handler: AIAgent swaps connector with new cwd

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `newCwd` | `string` | yes |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `skipWarning` | `boolean \| undefined` | no |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `previousCwd` | `string \| undefined` | no |
| `reason` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="agent.cwd.changed"></a>`agent.cwd.changed` (event)

Agent working directory changed.

Subject: `agent.cwd.changed`
Type: Event (fire-and-forget)
Emitted when: Agent's working directory has been successfully changed
Use for: UI updates, audit logging

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `newCwd` | `string` | yes |
| `occurredAt` | `number \| undefined` | no |
| `previousCwd` | `string` | yes |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.getCapabilities"></a>`agent.getCapabilities` (rpc)

Query effective capabilities of a running agent.

Subject: `agent.getCapabilities`
Type: Request (RPC)
Purpose: Returns capabilities based on the agent's current model

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `capabilities` | `string[]` | yes |
| `model` | `string \| undefined` | no |
| `nativeTools` | `string[]` | yes |

### <a id="agent.idle"></a>`agent.idle` (event)

Agent processing state transitioned to idle.

Subject: `agent.idle`
Type: Event (fire-and-forget)
Emitted when: An agent's processing state transitions to 'idle'

This event fires AFTER `agent.complete` and signals that the agent
is fully idle and ready for mutations like cwd.change or model.change.
Orchestration-level consumers (who don't have direct connector access)
can listen to this event to know when the agent is safe to mutate.

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.interrupt"></a>`agent.interrupt` (rpc)

Request to interrupt the active agent turn.

Subject: `agent.interrupt`
Type: Request/Response
Sent when: Caller wants the connector to stop current processing and return control.
Handler: AIAgent delegates to the active connector's `interrupt()` implementation.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="agent.mcp.servers.set"></a>`agent.mcp.servers.set` (rpc)

Request to replace the agent's runtime MCP server context.

Subject: `agent.mcp.servers.set`
Type: Request/Response
Sent when: Caller wants to replace dynamic SDK MCP servers mid-session
Handler: AIAgent swaps the connector immediately when idle, or stages the
latest request for the next turn boundary when requested by the caller.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `mcpSessionContext` | `{ sessionId: string; servers: { name: string; transport: { type: "stdio"; command: string; args?: string[] \| undefined; env?: Record<string, string> \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "sse"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "http"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; }; exposureMode: "direct" \| "discovery"; }[]; directTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; discoverableTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; }` | yes |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnActiveBehavior` | `"reject" \| "stageForNextTurn" \| undefined` | no |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `reason` | `string \| undefined` | no |
| `staged` | `boolean \| undefined` | no |
| `success` | `boolean` | yes |
| `swapped` | `boolean \| undefined` | no |

### <a id="agent.message"></a>`agent.message` (event)

Complete AI message received.

Subject: `agent.message`
Type: Event (fire-and-forget)
Emitted when: A full message is received from the AI model

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `content` | `string` | yes |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.message_delta"></a>`agent.message_delta` (event)

AI message stream delta received.

Subject: `agent.message_delta`
Type: Event (fire-and-forget)
Emitted when: Streaming message text is received from the AI model

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `text` | `string` | yes |
| `turnId` | `string \| undefined` | no |

### <a id="agent.model.change"></a>`agent.model.change` (rpc)

Request to change the agent model.

Subject: `agent.model.change`
Type: Request/Response
Sent when: Caller wants to switch the model mid-session
Handler: AIAgent attempts native in-place change, falls back to connector swap

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `newModel` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `providerContext` | `{ providerConfigId: string; definitionId: string; credentialRefs: Record<string, string>; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; credentialEnvVars?: Record<string, string> \| undefined; ambientCredentialEnvVars?: string[] \| undefined; capabilities?: Record<string, unknown> \| undefined; } \| undefined` | no |
| `reasoningEffort` | `"none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `skipWarning` | `boolean \| undefined` | no |
| `turnActiveBehavior` | `"reject" \| "stageForNextTurn" \| undefined` | no |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `appliedReasoningEffort` | `"none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined` | no |
| `model` | `string \| undefined` | no |
| `reason` | `string \| undefined` | no |
| `staged` | `boolean \| undefined` | no |
| `success` | `boolean` | yes |
| `supportedReasoningLevels` | `{ none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined` | no |
| `swapped` | `boolean \| undefined` | no |

### <a id="agent.model.changed"></a>`agent.model.changed` (event)

Agent model changed during execution.

Subject: `agent.model.changed`
Type: Event (fire-and-forget)
Emitted when: The model is changed mid-session (e.g., user switches models)
Use for: Tracking model transitions for billing, context restoration

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `newModel` | `string` | yes |
| `newReasoningEffort` | `"none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `previousModel` | `string` | yes |
| `previousReasoningEffort` | `"none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.reasoning"></a>`agent.reasoning` (event)

Complete AI reasoning block received.

Subject: `agent.reasoning`
Type: Event (fire-and-forget)
Emitted when: A full reasoning/thinking block is received from the AI model

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `content` | `string` | yes |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.reasoning_delta"></a>`agent.reasoning_delta` (event)

AI reasoning stream delta received.

Subject: `agent.reasoning_delta`
Type: Event (fire-and-forget)
Emitted when: Streaming reasoning content is received from the AI model

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `content` | `string` | yes |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.sendMessage"></a>`agent.sendMessage` (rpc)

Send a message to an existing agent.

Subject: `agent.sendMessage`
Type: Request (RPC)
Purpose: Sends a message to an existing agent instance (errors if agent doesn't exist)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `deliveryMode` | `"enqueue" \| "immediate" \| undefined` | no |
| `message` | `string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }` | yes |
| `messageId` | `string \| undefined` | no |
| `responseSchema` | `{ schema: Record<string, JsonValue>; name?: string \| undefined; strict?: boolean \| undefined; } \| undefined` | no |
| `sessionContext` | `{ messageHistory?: { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }[] \| undefined; hasNewTransforms?: boolean \| undefined; hasCompression?: boolean \| undefined; extractedContext?: unknown; isFirstTurn?: boolean \| undefined; hasConnectorSwap?: boolean \| undefined; cacheStrategy?: "auto" \| "systemPrompt" \| "fullPrefix" \| undefined; turnContext?: Record<string, unknown> \| undefined; } \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `messageId` | `string` | yes |

### <a id="agent.session.closed"></a>`agent.session.closed` (event)

Agent session closed.

Subject: `agent.session.closed`
Type: Event (fire-and-forget)
Emitted when: Agent session ends (abort, close, or natural completion)

AIAdapter listens to this and re-emits as AdapterSubjects.session.closed.
This maintains proper layering: agent emits agent-level events,
adapter translates to adapter-level events.

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `reason` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.started"></a>`agent.started` (event)

Agent execution started.

Subject: `agent.started`
Type: Event (fire-and-forget)
Emitted when: An agent begins processing a task

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `cwd` | `string \| null` | yes |
| `messageId` | `string \| undefined` | no |
| `model` | `string \| null` | yes |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.step.finished"></a>`agent.step.finished` (event)

Agent step finished event.

Subject: `agent.step.finished`
Type: Event (fire-and-forget)
Emitted when: A content block completes processing

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `blockIndex` | `number` | yes |
| `clientId` | `string \| undefined` | no |
| `content` | `{ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; }` | yes |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `stepType` | `"text" \| "reasoning" \| "tool_use"` | yes |
| `turnId` | `string \| undefined` | no |

### <a id="agent.step.started"></a>`agent.step.started` (event)

Agent step started event.

Subject: `agent.step.started`
Type: Event (fire-and-forget)
Emitted when: A content block begins processing

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `blockData` | `{ type: "tool_use"; toolName: string; toolCallId: string; } \| { type: "reasoning"; } \| { type: "text"; } \| undefined` | no |
| `blockIndex` | `number` | yes |
| `clientId` | `string \| undefined` | no |
| `content` | `{ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `stepType` | `"text" \| "reasoning" \| "tool_use"` | yes |
| `turnId` | `string \| undefined` | no |

### <a id="agent.structuredOutput.enforce"></a>`agent.structuredOutput.enforce` (rpc)

RPC schema for enforcing structured output after validation failures.

Subject: `agent.structuredOutput.enforce`
Type: Request (RPC)
Direction: framework → host

Emitted when retry attempts are exhausted and the framework needs the host
to decide whether to enforce conformance via a fallback adapter/model or
to surface the error upstream. The framework-owned default handler is a
no-op that returns `enforced: false`; enforcement only happens when a host
registers an override handler. Returning `enforced: true` with a corrected
`output` string means the framework treats the turn as successfully completed.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterHasCapability` | `boolean` | yes |
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `fallbackAdapterId` | `string \| undefined` | no |
| `fallbackAdapterName` | `string \| undefined` | no |
| `fallbackModel` | `string \| undefined` | no |
| `rawOutput` | `string` | yes |
| `responseSchema` | `{ schema: Record<string, JsonValue>; name?: string \| undefined; strict?: boolean \| undefined; }` | yes |
| `sessionId` | `string \| undefined` | no |
| `validationErrors` | `{ message: string; instancePath: string; schemaPath: string; }[]` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `enforced` | `boolean` | yes |

### <a id="agent.structuredOutput.retryPolicy"></a>`agent.structuredOutput.retryPolicy` (rpc)

RPC schema for resolving the structured-output retry policy.

Subject: `agent.structuredOutput.retryPolicy`
Type: Request (RPC)
Direction: framework → host

Emitted before a retry decision is made. The host layer (or any registered
override handler) returns the maximum number of retry attempts permitted for
this agent/adapter/schema combination. The framework-owned default policy is
`maxRetries: 0`, so structured-output validation does not replay turns unless
a host explicitly opts in. Replaying a turn can duplicate non-idempotent tool
or outbound side effects.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterCapabilities` | `string[]` | yes |
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `attemptNumber` | `number` | yes |
| `responseSchema` | `{ schema: Record<string, JsonValue>; name?: string \| undefined; strict?: boolean \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `maxRetries` | `number` | yes |

### <a id="agent.tool.completed"></a>`agent.tool.completed` (event)

Tool execution completed.

Subject: `agent.tool.completed`
Type: Event (fire-and-forget)
Emitted when: A tool finishes execution

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
| `result` | `string \| Record<string, unknown> \| Record<string, unknown>[]` | yes |
| `sessionId` | `string \| undefined` | no |
| `success` | `boolean \| undefined` | no |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |
| `turnId` | `string \| undefined` | no |

### <a id="agent.tool.output"></a>`agent.tool.output` (event)

Tool execution output received.

Subject: `agent.tool.output`
Type: Event (fire-and-forget)
Emitted when: A tool produces output during execution

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
| `output` | `string` | yes |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `toolCallId` | `string` | yes |
| `toolName` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.tool.started"></a>`agent.tool.started` (event)

Tool execution started.

Subject: `agent.tool.started`
Type: Event (fire-and-forget)
Emitted when: A tool begins execution

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |
| `turnId` | `string \| undefined` | no |

### <a id="agent.tool.use"></a>`agent.tool.use` (event)

Tool use requested by agent.

Subject: `agent.tool.use`
Type: Event (fire-and-forget)
Emitted when: Agent requests to use a tool

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
| `sessionId` | `string \| undefined` | no |
| `toolCallId` | `string` | yes |
| `toolName` | `string` | yes |
| `turnId` | `string \| undefined` | no |

### <a id="agent.toolApprove"></a>`agent.toolApprove` (rpc)

Request approval for tool execution.

Subject: `agent.toolApprove`
Type: Request (RPC)
Emitted when: Agent requires approval before executing a tool

Response semantics:
- `action: 'allow'`: Approve tool execution
  - `updatedInput`: Optional modified arguments (e.g., user corrected a path)
  - `updatedPermissions`: Optional permission updates (e.g., "always allow" this pattern)
- `action: 'deny'`: Reject tool execution
  - `message`: Required explanation or guidance for the agent
  - `shouldAbort`: If true, stop execution entirely; if false/unset, agent may retry

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
| `sessionId` | `string` | yes |
| `toolCallId` | `string` | yes |
| `toolName` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `action` | `"allow" \| "deny"` | yes |

### <a id="agent.turn.completed"></a>`agent.turn.completed` (event)

Agent turn completed.

Subject: `agent.turn.completed`
Type: Event (fire-and-forget)
Emitted when: Agent finishes processing a turn (always paired with agent.turn.started)

Fired for ALL outcomes, not just successful completions. Consumers
that only care about success should filter on `outcome === 'completed'`.
For full outcome details (supersededBy, mergedInto), listen to user_message.completed.

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `error` | `string \| undefined` | no |
| `message` | `string \| undefined` | no |
| `messageId` | `string` | yes |
| `occurredAt` | `number \| undefined` | no |
| `outcome` | `"error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected"` | yes |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `structuredOutputValidation` | `{ status: "passed"; } \| { status: "enforced"; } \| { status: "failed"; errors: { message: string; instancePath: string; schemaPath: string; }[]; } \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.turn.started"></a>`agent.turn.started` (event)

Agent turn started.

Subject: `agent.turn.started`
Type: Event (fire-and-forget)
Emitted when: Agent begins processing a user message (after acknowledgment)

Higher-level abstraction over user_message.acknowledged.
Consumers who don't need merge/supersede details can subscribe to this.

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `content` | `{ role: "user" \| "assistant" \| "system"; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; message?: string \| undefined; }` | yes |
| `mergedFrom` | `string[] \| undefined` | no |
| `messageId` | `string` | yes |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.usage"></a>`agent.usage` (event)

Per-call token usage metrics.

Subject: `agent.usage`
Type: Event (fire-and-forget)
Emitted when: Usage metrics are available from an AI provider API call

This event contains delta metrics for a single API call.
For adapter-level cumulative totals, see `adapter.session.usage`.

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `audioInputTokens` | `number \| undefined` | no |
| `audioOutputTokens` | `number \| undefined` | no |
| `cacheWriteTokens` | `number \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `contextWindow` | `number \| undefined` | no |
| `cost` | `number \| undefined` | no |
| `costUnits` | `number` | yes |
| `costUnitType` | `"requests" \| "tokens"` | yes |
| `currency` | `string \| undefined` | no |
| `duration` | `number \| undefined` | no |
| `inputCachedTokens` | `number` | yes |
| `inputTokens` | `number` | yes |
| `messageId` | `string \| undefined` | no |
| `model` | `string` | yes |
| `occurredAt` | `number \| undefined` | no |
| `outputTokens` | `number` | yes |
| `provider` | `string` | yes |
| `providerConfigId` | `string \| undefined` | no |
| `quota` | `{ type: string; limit: number; used: number; overage: number; resetDate?: string \| undefined; } \| undefined` | no |
| `reasoningTokens` | `number` | yes |
| `serviceTier` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `totalTokens` | `number` | yes |
| `turnId` | `string \| undefined` | no |

### <a id="agent.user_message.acknowledged"></a>`agent.user_message.acknowledged` (event)

User message acknowledged by agent (processing started).

Subject: `agent.user_message.acknowledged`
Type: Event (fire-and-forget)
Emitted when: SDK begins processing a user message

Marks the turn start boundary at agent level.
If messages were merged, `mergedFrom` contains the messageIds that were
folded into this message (their content was combined).

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `mergedFrom` | `string[] \| undefined` | no |
| `messageId` | `string` | yes |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.user_message.completed"></a>`agent.user_message.completed` (event)

User message lifecycle completed.

Subject: `agent.user_message.completed`
Type: Event (fire-and-forget)
Emitted when: A user message's lifecycle ends (any outcome)

Every messageId from user_message.sent will eventually get a corresponding
user_message.completed event with an explicit outcome.

For persistence/reconstruction:
- `completed`: Normal flow, agent.complete also emitted
- `superseded`: Partial response may exist, check supersededBy
- `merged`: Content folded into mergedInto message
- `cancelled`: No response expected
- `error`: Check agent.error for details

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `error` | `string \| undefined` | no |
| `mergedInto` | `string \| undefined` | no |
| `messageId` | `string` | yes |
| `occurredAt` | `number \| undefined` | no |
| `outcome` | `"error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected"` | yes |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `supersededBy` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.user_message.sent"></a>`agent.user_message.sent` (event)

User message sent to agent.

Subject: `agent.user_message.sent`
Type: Event (fire-and-forget)
Emitted when: A user message is enqueued for processing

Captures all user intent including messages that may be superseded.
For persistence, this is the source of truth for user input.

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `clientId` | `string \| undefined` | no |
| `content` | `{ role: "user" \| "assistant" \| "system"; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; message?: string \| undefined; }` | yes |
| `deliveryMode` | `"replace" \| "enqueue" \| "immediate"` | yes |
| `messageId` | `string` | yes |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

### <a id="agent.validateModelChange"></a>`agent.validateModelChange` (rpc)

RPC subject for validating a mid-session model swap.

Subject: `agent.validateModelChange`
Type: Request (RPC)
Direction: framework → host

The framework adapter emits this before replacing a connector. The host
layer (or any registered handler) decides whether the change should proceed
and whether to request an edit-history fork. If no handler is registered
(OSS / headless mode) the framework treats the change as auto-approved.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `currentModel` | `string` | yes |
| `nextModel` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `proceed` | `boolean` | yes |
| `requestEditHistory` | `boolean \| undefined` | no |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
