---
title: "adapter"
editUrl: false
prev: false
next: false
---

# `adapter`

| Field | Value |
|-------|-------|
| Prefix | `adapter` |
| Namespace constant | `AdapterNamespace` |
| Subjects constant | `AdapterSubjects` |
| Kind | bus |
| Schema record | `AdapterSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/adapter/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `agent.created` | [`adapter.agent.created`](#adapter.agent.created) | event | [`agent-created.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/agent-created.ts) |
| `error` | [`adapter.error`](#adapter.error) | event | [`error.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/error.ts) |
| `getAgent` | [`adapter.getAgent`](#adapter.getAgent) | rpc | [`get-agent.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/get-agent.ts) |
| `getCapabilities` | [`adapter.getCapabilities`](#adapter.getCapabilities) | rpc | [`get-capabilities.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/get-capabilities.ts) |
| `getConfigSchema` | [`adapter.getConfigSchema`](#adapter.getConfigSchema) | rpc | [`get-config-schema.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/get-config-schema.ts) |
| `infer` | [`adapter.infer`](#adapter.infer) | rpc | [`infer.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/infer.ts) |
| `initialized` | [`adapter.initialized`](#adapter.initialized) | event | [`initialized.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/initialized.ts) |
| `listAgents` | [`adapter.listAgents`](#adapter.listAgents) | rpc | [`list-agents.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/list-agents.ts) |
| `log` | [`adapter.log`](#adapter.log) | event | [`log.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/log.ts) |
| `quota` | [`adapter.quota`](#adapter.quota) | event | [`quota.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/quota.ts) |
| `rehydrateAgent` | [`adapter.rehydrateAgent`](#adapter.rehydrateAgent) | rpc | [`rehydrate-agent.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/rehydrate-agent.ts) |
| `session.closed` | [`adapter.session.closed`](#adapter.session.closed) | event | [`session-closed.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/session-closed.ts) |
| `session.created` | [`adapter.session.created`](#adapter.session.created) | event | [`session-created.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/session-created.ts) |
| `session.discovered` | [`adapter.session.discovered`](#adapter.session.discovered) | event | [`session-discovered.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/session-discovered.ts) |
| `session.usage` | [`adapter.session.usage`](#adapter.session.usage) | event | [`session-usage.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/session-usage.ts) |
| `startAgent` | [`adapter.startAgent`](#adapter.startAgent) | rpc | [`start-agent.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/start-agent.ts) |
| `stopAgent` | [`adapter.stopAgent`](#adapter.stopAgent) | rpc | [`stop-agent.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/adapter/schemas/stop-agent.ts) |

## Subject Details

### <a id="adapter.agent.created"></a>`adapter.agent.created` (event)

Agent execution unit created.

Subject: `adapter.agent.created`
Type: Event (fire-and-forget)
Emitted when: Adapter spawns a new agent execution unit

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `sessionId` | `string` | yes |

### <a id="adapter.error"></a>`adapter.error` (event)

Error during execution.

Subject: `adapter.error`
Type: Event (fire-and-forget)
Emitted during: promptText() execution on failure

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `error` | `string` | yes |
| `errorCategory` | `"auth" \| "rate_limit" \| "model_unavailable" \| "quota_exceeded" \| undefined` | no |
| `sessionId` | `string \| undefined` | no |

### <a id="adapter.getAgent"></a>`adapter.getAgent` (rpc)

Get information about a specific agent.

Subject: `adapter.getAgent`
Type: Request (RPC)
Purpose: Returns details for a specific agent, or null if not found.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `agent` | `{ agentId: string; sessionId: string; adapterSessionId?: string \| undefined; } \| null` | yes |

### <a id="adapter.getCapabilities"></a>`adapter.getCapabilities` (rpc)

Request adapter capabilities.

Subject: `adapter.getCapabilities`
Type: Request (RPC)

Returns the adapter's declared capabilities and native tools.
Can be queried by adapter name or adapter instance ID.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `adapterName` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `capabilities` | `string[]` | yes |
| `nativeTools` | `string[]` | yes |

### <a id="adapter.getConfigSchema"></a>`adapter.getConfigSchema` (rpc)

Get adapter config schema as JSON Schema.

Subject: `adapter.getConfigSchema`
Type: Request (RPC)
Purpose: Returns the adapter's providerConfig schema serialized as JSON Schema
         for dynamic form generation in web-ui.

The response includes the full JSON Schema representation of the adapter's
configSchema field, suitable for rendering configuration forms.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `found` | `boolean` | yes |
| `jsonSchema` | `Record<string, unknown> \| null` | yes |

### <a id="adapter.infer"></a>`adapter.infer` (rpc)

One-shot inference request/response schema.

Subject: `adapter.infer`
Type: Request (RPC)
Purpose: Ephemeral LLM inference without agent lifecycle overhead.
         Used for classification, quick prompts, and meta-LLM calls.

The adapter creates a temporary connector, executes the inference,
extracts the text response, and cleans up — no persistent agent.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `model` | `string \| undefined` | no |
| `prompt` | `string` | yes |
| `providerContext` | `{ state: "resolved"; providerConfigId: string; definitionId: string; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; }; credentialRefs: Record<string, string>; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "inferred"; label: string; description?: string \| undefined; }; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "none"; label: string; description?: string \| undefined; }; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; capabilities?: Record<string, unknown> \| undefined; } \| { state: "unresolved"; } \| undefined` | no |
| `responseSchema` | `{ schema: Record<string, JsonValue>; name?: string \| undefined; strict?: boolean \| undefined; } \| undefined` | no |
| `systemPrompt` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `text` | `string` | yes |
| `usage` | `{ inputTokens: number; outputTokens: number; } \| undefined` | no |

### <a id="adapter.initialized"></a>`adapter.initialized` (event)

Adapter initialization completed.

Subject: `adapter.initialized`
Type: Event (fire-and-forget)
Emitted when: Adapter finishes initialization and is ready to handle requests.

This event signals that all adapter handlers are registered and the adapter
is ready to process incoming messages. Useful for coordinating startup timing
and preventing race conditions when transports accept connections before
adapters are ready.

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `capabilities` | `string[]` | yes |
| `nativeTools` | `string[] \| undefined` | no |

### <a id="adapter.listAgents"></a>`adapter.listAgents` (rpc)

List active agents for an adapter.

Subject: `adapter.listAgents`
Type: Request (RPC)
Purpose: Returns all active agents managed by the specified adapter.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `agents` | `{ agentId: string; sessionId: string; adapterSessionId?: string \| undefined; }[]` | yes |

### <a id="adapter.log"></a>`adapter.log` (event)

Adapter or SDK log message.

Subject: `adapter.log`
Type: Event (fire-and-forget)
Emitted when: Adapter or SDK emits log messages (authentication, connection status, etc.)

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `level` | `"error" \| "info" \| "debug" \| "warn" \| undefined` | no |
| `message` | `string` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter.quota"></a>`adapter.quota` (event)

Account-wide quota and billing metrics.

Subject: `adapter.quota`
Type: Event (fire-and-forget)
Emitted when: Quota information is available from the provider (e.g., GitHub Copilot)

This tracks account-wide usage limits across all sessions in the billing period.
Only applicable to providers with quota systems (currently GitHub Copilot).

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `limit` | `number` | yes |
| `overage` | `number` | yes |
| `provider` | `string` | yes |
| `quotaType` | `string` | yes |
| `resetDate` | `string` | yes |
| `used` | `number` | yes |

### <a id="adapter.rehydrateAgent"></a>`adapter.rehydrateAgent` (rpc)

Rehydrate an agent by swapping its connector.

Subject: `adapter.rehydrateAgent`
Type: Request (RPC)
Purpose: Allows the orchestrator to swap an agent's connector (e.g., after a crash)
instead of killing and recreating the agent. This preserves the agent's
identity and session state while replacing the underlying execution context.

The adapter will:
1. Stop the existing connector for the specified agent
2. Create a new connector with optional config overrides (cwd, model)
3. Wire the new connector to the existing agent instance

Success is implicit. Errors are thrown if:
- Agent not found
- Adapter not found
- Connector swap fails

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `cwd` | `string \| undefined` | no |
| `model` | `string \| undefined` | no |
| `resumeAdapterSessionId` | `string \| undefined` | no |

**Response:**

_Empty object._

### <a id="adapter.session.closed"></a>`adapter.session.closed` (event)

External provider session closed.

Subject: `adapter.session.closed`
Type: Event (fire-and-forget)
Emitted when: SDK session ends

Re-emitted by AIAdapter when it receives AgentSubjects.session_closed.

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `reason` | `string \| undefined` | no |
| `sessionId` | `string` | yes |

### <a id="adapter.session.created"></a>`adapter.session.created` (event)

External provider session established.

Subject: `adapter.session.created`
Type: Event (fire-and-forget)
Emitted when: SDK session is created (Anthropic, OpenAI, etc.)

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string \| undefined` | no |
| `model` | `string` | yes |
| `sessionId` | `string` | yes |

### <a id="adapter.session.discovered"></a>`adapter.session.discovered` (event)

Subject: `adapter.session.discovered`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `cwd` | `string \| null` | yes |
| `forkPointMessageId` | `string \| null` | yes |
| `kind` | `"fork" \| "root" \| "subagent" \| "compress"` | yes |
| `logFilePath` | `string \| null \| undefined` | no |
| `machineId` | `string \| null \| undefined` | no |
| `model` | `string \| null` | yes |
| `parentAdapterSessionId` | `string \| null` | yes |
| `startedAt` | `number \| undefined` | no |
| `title` | `string \| undefined` | no |

### <a id="adapter.session.usage"></a>`adapter.session.usage` (event)

Session-level cumulative usage metrics.

Subject: `adapter.session.usage`
Type: Event (fire-and-forget)
Emitted when: Session usage totals are updated (after each API call)

This event contains running totals for the entire session/conversation.
For per-call delta metrics, see `agent.usage`.

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string \| undefined` | no |
| `sessionId` | `string` | yes |
| `totalCalls` | `number` | yes |
| `totalInputTokens` | `number` | yes |
| `totalOutputTokens` | `number` | yes |

### <a id="adapter.startAgent"></a>`adapter.startAgent` (rpc)

Start a new agent with full lifecycle control.

Subject: `adapter.startAgent`
Type: Request (RPC)
Purpose: Non-blocking agent creation with full control over session management.
         Returns immediately with agent identifiers for further interaction.

Request modes:
- `create` (default, can be omitted): Create fresh session. Server generates sessionId.
- `resume`: Continue existing makaio session from a provider session's last state.
- `fork`: Branch from existing provider session into same makaio session.

For `fork` mode, `sessionId` and `sourceSessionId` are REQUIRED.
For `resume` mode, `sessionId` and `adapterSessionId` are REQUIRED.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterConfig` | `Record<string, unknown> \| undefined` | no |
| `adapterId` | `string` | yes |
| `allowedDirectories` | `string[] \| undefined` | no |
| `allowedTools` | `string[] \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `clientProfileName` | `string \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `disallowedTools` | `string[] \| undefined` | no |
| `env` | `Record<string, string> \| undefined` | no |
| `ephemeral` | `boolean \| undefined` | no |
| `harnessId` | `string \| undefined` | no |
| `initialMessage` | `string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; } \| undefined` | no |
| `mcpSessionContext` | `{ sessionId: string; projectId: string \| null; profileId: string \| null; servers: { name: string; transport: { type: "stdio"; command: string; args?: string[] \| undefined; env?: Record<string, string> \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "sse"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "http"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; }; exposureMode: "direct" \| "discovery"; }[]; directTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; discoverableTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; } \| { sessionId: string; servers: { name: string; transport: { type: "stdio"; command: string; args?: string[] \| undefined; env?: Record<string, string> \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "sse"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "http"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; }; exposureMode: "direct" \| "discovery"; }[]; directTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; discoverableTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; } \| undefined` | no |
| `mode` | `"create" \| "fork" \| "resume" \| undefined` | no |
| `model` | `string \| undefined` | no |
| `providerContext` | `{ state: "resolved"; providerConfigId: string; definitionId: string; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; }; credentialRefs: Record<string, string>; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "inferred"; label: string; description?: string \| undefined; }; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "none"; label: string; description?: string \| undefined; }; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; capabilities?: Record<string, unknown> \| undefined; } \| { state: "unresolved"; } \| undefined` | no |
| `reasoningEffort` | `"none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined` | no |
| `responseSchema` | `{ schema: Record<string, JsonValue>; name?: string \| undefined; strict?: boolean \| undefined; } \| undefined` | no |
| `role` | `"lead" \| "member"` | yes |
| `sessionContext` | `{ messageHistory?: { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }[] \| undefined; hasNewTransforms?: boolean \| undefined; hasCompression?: boolean \| undefined; extractedContext?: unknown; isFirstTurn?: boolean \| undefined; hasConnectorSwap?: boolean \| undefined; cacheStrategy?: "auto" \| "systemPrompt" \| "fullPrefix" \| undefined; turnContext?: Record<string, unknown> \| undefined; requestCorrelation?: { sessionId?: string \| undefined; turnId?: string \| undefined; messageId?: string \| undefined; executionId?: string \| undefined; frameId?: string \| undefined; } \| undefined; nativeLocality?: { kind: "native"; } \| { kind: "degrade"; reason: "adapter-unsupported" \| "adapter-mismatch" \| "no-adapter-session" \| "missing-machine-id" \| "machine-mismatch" \| "cwd-mismatch" \| "transforms-present" \| "compression-present" \| "connector-swap" \| "mid-history-unsupported" \| "hybrid-imported-orchestrated" \| "native-attempt-failed" \| "agent-already-started" \| "fork-point-unresolvable"; } \| { kind: "foreign"; machineId: string; } \| undefined; nativeFork?: { sourceSessionId: string; sourceAdapterSessionId: string; forkPointMessageId?: string \| undefined; targetWorkingDirectory?: string \| undefined; } \| undefined; } \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `systemPrompt` | `string \| { mode: "append"; content: string; } \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="adapter.stopAgent"></a>`adapter.stopAgent` (rpc)

Stop and dispose an agent.

Subject: `adapter.stopAgent`
Type: Request (RPC)
Purpose: Aborts the agent and removes it from the adapter's tracking.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
