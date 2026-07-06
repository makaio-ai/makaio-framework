---
title: "tool"
editUrl: false
prev: false
next: false
---

# `tool`

| Field | Value |
|-------|-------|
| Prefix | `tool` |
| Namespace constant | `ToolNamespace` |
| Subjects constant | `ToolSubjects` |
| Kind | bus |
| Schema record | `ToolSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/tool/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/tool/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `completed` | [`tool.completed`](#tool.completed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/tool/schemas.ts) |
| `error` | [`tool.error`](#tool.error) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/tool/schemas.ts) |
| `execute` | [`tool.execute`](#tool.execute) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/tool/schemas.ts) |
| `list` | [`tool.list`](#tool.list) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/tool/schemas.ts) |
| `registered` | [`tool.registered`](#tool.registered) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/tool/schemas.ts) |
| `registryChanged` | [`tool.registryChanged`](#tool.registryChanged) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/tool/schemas.ts) |
| `started` | [`tool.started`](#tool.started) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/tool/schemas.ts) |

## Subject Details

### <a id="tool.completed"></a>`tool.completed` (event)

Tool execution completed successfully.

Subject: `tool.completed`
Type: Event (fire-and-forget)
Emitted when: A tool finishes execution successfully.

| Field | Type | Required |
|-------|------|----------|
| `durationMs` | `number` | yes |
| `executionId` | `string` | yes |
| `timestamp` | `number` | yes |
| `toolName` | `string` | yes |
| `toolsetName` | `string` | yes |

### <a id="tool.error"></a>`tool.error` (event)

Tool execution error.

Subject: `tool.error`
Type: Event (fire-and-forget)
Emitted when: A tool encounters an error during execution.

| Field | Type | Required |
|-------|------|----------|
| `error` | `{ code: string; message: string; details?: unknown; }` | yes |
| `executionId` | `string` | yes |
| `timestamp` | `number` | yes |
| `toolName` | `string` | yes |
| `toolsetName` | `string` | yes |

### <a id="tool.execute"></a>`tool.execute` (rpc)

Execute a tool.

Subject: `tool.execute`
Type: Request (RPC)
Purpose: Execute a tool with given input and return the result.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `adapterName` | `string \| undefined` | no |
| `contextOverrides` | `{ cwd?: string \| undefined; env?: Record<string, string> \| undefined; sessionId?: string \| undefined; agentId?: string \| undefined; adapterId?: string \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; turnId?: string \| undefined; turnContext?: Record<string, unknown> \| undefined; reasoning?: string \| undefined; toolCallId?: string \| undefined; constraints?: Record<string, unknown> \| undefined; } \| undefined` | no |
| `input` | `unknown` | yes |
| `toolName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="tool.list"></a>`tool.list` (rpc)

List all registered tools.

Subject: `tool.list`
Type: Request (RPC)
Purpose: Returns definitions for all registered tools including input schemas.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string \| undefined` | no |
| `adapterName` | `string \| undefined` | no |
| `toolsetName` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `tools` | `{ name: string; description: string; toolsetName: string; annotations?: { readOnly?: boolean \| undefined; destructive?: boolean \| undefined; idempotent?: boolean \| undefined; requiresApproval?: boolean \| undefined; } \| undefined; inputSchema?: Record<string, unknown> \| undefined; }[]` | yes |
| `toolsets` | `{ name: string; description: string; version: string; toolCount: number; configSchema?: Record<string, unknown> \| undefined; }[]` | yes |

### <a id="tool.registered"></a>`tool.registered` (event)

Toolset registered event.

Subject: `tool.registered`
Type: Event (fire-and-forget)
Emitted when: A toolset is registered with the registry.
Emits once per toolset with all tool names.

| Field | Type | Required |
|-------|------|----------|
| `toolNames` | `string[]` | yes |
| `toolsetName` | `string` | yes |
| `toolsetVersion` | `string` | yes |

### <a id="tool.registryChanged"></a>`tool.registryChanged` (event)

Tool registry changed event.

Subject: `tool.registryChanged`
Type: Event (fire-and-forget)
Emitted when: A toolset is registered or unregistered, or a plugin is loaded/unloaded.
Used by consumers (e.g., MCP server) to invalidate stale tool lists.

| Field | Type | Required |
|-------|------|----------|
| `reason` | `"toolset-registered" \| "toolset-unregistered" \| "plugin-loaded" \| "plugin-unloaded"` | yes |
| `revision` | `number` | yes |
| `toolsetName` | `string` | yes |

### <a id="tool.started"></a>`tool.started` (event)

Tool execution started.

Subject: `tool.started`
Type: Event (fire-and-forget)
Emitted when: A tool begins execution.

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `timestamp` | `number` | yes |
| `toolName` | `string` | yes |
| `toolsetName` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
