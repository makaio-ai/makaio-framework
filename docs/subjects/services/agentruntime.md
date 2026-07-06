---
title: "agentRuntime"
editUrl: false
prev: false
next: false
---

# `agentRuntime`

| Field | Value |
|-------|-------|
| Prefix | `agentRuntime` |
| Namespace constant | `AgentRuntimeNamespace` |
| Subjects constant | `AgentRuntimeSubjects` |
| Kind | bus |
| Schema record | `AgentRuntimeSchemas` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/agent-runtime/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/agent-runtime/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `completed` | [`agentRuntime.completed`](#agentRuntime.completed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/agent-runtime/schemas.ts) |
| `get` | [`agentRuntime.get`](#agentRuntime.get) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/agent-runtime/schemas.ts) |
| `kill` | [`agentRuntime.kill`](#agentRuntime.kill) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/agent-runtime/schemas.ts) |
| `send` | [`agentRuntime.send`](#agentRuntime.send) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/agent-runtime/schemas.ts) |
| `spawn` | [`agentRuntime.spawn`](#agentRuntime.spawn) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/agent-runtime/schemas.ts) |
| `spawned` | [`agentRuntime.spawned`](#agentRuntime.spawned) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/agent-runtime/schemas.ts) |

## Subject Details

### <a id="agentRuntime.completed"></a>`agentRuntime.completed` (event)

Emitted when an agent instance completes or fails.

Subject: `agentRuntime.completed`
Type: Event (fire-and-forget)

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `instanceId` | `string` | yes |
| `result` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="agentRuntime.get"></a>`agentRuntime.get` (rpc)

Get the status of a spawned agent instance.

Subject: `agentRuntime.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `instanceId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `displayName` | `string` | yes |
| `error` | `string \| undefined` | no |
| `instanceId` | `string` | yes |
| `kind` | `string` | yes |
| `progress` | `string[] \| undefined` | no |
| `result` | `string \| undefined` | no |
| `status` | `"completed" \| "cancelled" \| "failed" \| "running" \| "waiting_input"` | yes |
| `subagentId` | `string` | yes |

### <a id="agentRuntime.kill"></a>`agentRuntime.kill` (rpc)

Kill a running agent instance.

Subject: `agentRuntime.kill`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `instanceId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `killed` | `boolean` | yes |

### <a id="agentRuntime.send"></a>`agentRuntime.send` (rpc)

Send a message to a running agent instance.

Subject: `agentRuntime.send`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `instanceId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sent` | `boolean` | yes |

### <a id="agentRuntime.spawn"></a>`agentRuntime.spawn` (rpc)

Spawn an agent from a runtime-compatible selection.

Subject: `agentRuntime.spawn`
Type: Request (RPC)

The host-tier handler resolves the selection (persona → profile → config),
creates a subagent via `SubagentSubjects.spawn`, and returns the instance ID.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agent` | `{ [x: string]: unknown; kind: string; providerConfigId?: string \| undefined; model?: string \| undefined; reasoningEffort?: "none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined; cwd?: string \| undefined; systemPrompt?: string \| { mode: "append"; content: string; } \| undefined; allowedTools?: string[] \| undefined; disallowedTools?: string[] \| undefined; env?: Record<string, string> \| undefined; mcpSessionContext?: { sessionId: string; servers: { name: string; transport: { type: "stdio"; command: string; args?: string[] \| undefined; env?: Record<string, string> \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "sse"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "http"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; }; exposureMode: "direct" \| "discovery"; }[]; directTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; discoverableTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; } \| undefined; allowedDirectories?: string[] \| undefined; adapterConfig?: Record<string, unknown> \| undefined; }` | yes |
| `projectId` | `string \| undefined` | no |
| `prompt` | `string` | yes |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `instanceId` | `string` | yes |

### <a id="agentRuntime.spawned"></a>`agentRuntime.spawned` (event)

Emitted when an agent instance is spawned.

Subject: `agentRuntime.spawned`
Type: Event (fire-and-forget)

| Field | Type | Required |
|-------|------|----------|
| `displayName` | `string` | yes |
| `instanceId` | `string` | yes |
| `kind` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
