---
title: "mcp"
editUrl: false
prev: false
next: false
---

# `mcp`

| Field | Value |
|-------|-------|
| Prefix | `mcp` |
| Namespace constant | `McpNamespace` |
| Subjects constant | `McpSubjects` |
| Kind | bus |
| Schema record | `McpSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`packages/contracts/src/mcp/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/mcp/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `server.connected` | [`mcp.server.connected`](#mcp.server.connected) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/mcp/schemas.ts) |
| `server.disconnected` | [`mcp.server.disconnected`](#mcp.server.disconnected) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/mcp/schemas.ts) |
| `server.error` | [`mcp.server.error`](#mcp.server.error) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/mcp/schemas.ts) |
| `server.reconnecting` | [`mcp.server.reconnecting`](#mcp.server.reconnecting) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/mcp/schemas.ts) |
| `session.register` | [`mcp.session.register`](#mcp.session.register) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/mcp/schemas.ts) |
| `session.resolve` | [`mcp.session.resolve`](#mcp.session.resolve) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/mcp/schemas.ts) |
| `session.unregister` | [`mcp.session.unregister`](#mcp.session.unregister) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/mcp/schemas.ts) |
| `tools.enabled` | [`mcp.tools.enabled`](#mcp.tools.enabled) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/mcp/schemas.ts) |
| `tools.updated` | [`mcp.tools.updated`](#mcp.tools.updated) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/mcp/schemas.ts) |

## Subject Details

### <a id="mcp.server.connected"></a>`mcp.server.connected` (event)

Emitted when an MCP server successfully connects and its tools are discovered.

Subject: `mcp.server.connected`
Type: Event (fire-and-forget)

| Field | Type | Required |
|-------|------|----------|
| `serverName` | `string` | yes |
| `toolCount` | `number` | yes |

### <a id="mcp.server.disconnected"></a>`mcp.server.disconnected` (event)

Emitted when an MCP server disconnects.

Subject: `mcp.server.disconnected`
Type: Event (fire-and-forget)

| Field | Type | Required |
|-------|------|----------|
| `reason` | `string` | yes |
| `serverName` | `string` | yes |

### <a id="mcp.server.error"></a>`mcp.server.error` (event)

Emitted when an MCP server encounters an error.

Subject: `mcp.server.error`
Type: Event (fire-and-forget)

| Field | Type | Required |
|-------|------|----------|
| `error` | `string` | yes |
| `serverName` | `string` | yes |

### <a id="mcp.server.reconnecting"></a>`mcp.server.reconnecting` (event)

Emitted when an MCP server is attempting to reconnect.

Subject: `mcp.server.reconnecting`
Type: Event (fire-and-forget)

| Field | Type | Required |
|-------|------|----------|
| `attempt` | `number` | yes |
| `serverName` | `string` | yes |

### <a id="mcp.session.register"></a>`mcp.session.register` (rpc)

Register an agent session with the singleton MCP server.

Subject: `mcp.session.register`
Type: Request (RPC)
Purpose: Called by each adapter process when it spawns an MCP connection.
The bridge service stores the session mapping and returns the OS-assigned
port the singleton HTTP MCP server is listening on.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `contextOverrides` | `{ cwd?: string \| undefined; env?: Record<string, string> \| undefined; sessionId?: string \| undefined; agentId?: string \| undefined; adapterId?: string \| undefined; adapterName?: string \| undefined; turnId?: string \| undefined; turnContext?: Record<string, unknown> \| undefined; reasoning?: string \| undefined; toolCallId?: string \| undefined; constraints?: Record<string, unknown> \| undefined; }` | yes |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `port` | `number` | yes |

### <a id="mcp.session.resolve"></a>`mcp.session.resolve` (rpc)

Resolve the session context for a given session/project/profile combination.

Subject: `mcp.session.resolve`
Type: Request (RPC)
Purpose: Returns the fully resolved MCP session context including direct and
discoverable tools for the given session, project, and profile identifiers.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `profileId` | `string \| null` | yes |
| `profileMcpConfig` | `{ directTools?: string[] \| undefined; discoveryTools?: string[] \| undefined; toolExposure?: Record<string, "direct" \| "discovery" \| "hidden"> \| undefined; } \| undefined` | no |
| `projectId` | `string \| null` | yes |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `directTools` | `{ fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]` | yes |
| `discoverableTools` | `{ fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]` | yes |
| `profileId` | `string \| null` | yes |
| `projectId` | `string \| null` | yes |
| `servers` | `{ name: string; transport: { type: "stdio"; command: string; args?: string[] \| undefined; env?: Record<string, string> \| undefined; } \| { url: string; type: "sse"; headers?: Record<string, string> \| undefined; } \| { url: string; type: "http"; headers?: Record<string, string> \| undefined; }; exposureMode: "direct" \| "discovery"; }[]` | yes |
| `sessionId` | `string` | yes |

### <a id="mcp.session.unregister"></a>`mcp.session.unregister` (rpc)

Unregister an agent session from the singleton MCP server.

Subject: `mcp.session.unregister`
Type: Request (RPC)
Purpose: Called by the adapter when its MCP connection is torn down so
the bridge service can release the session mapping.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string` | yes |

**Response:**

_Empty object._

### <a id="mcp.tools.enabled"></a>`mcp.tools.enabled` (event)

Emitted when tools are enabled for a session.

Subject: `mcp.tools.enabled`
Type: Event (fire-and-forget)

| Field | Type | Required |
|-------|------|----------|
| `source` | `"discovery" \| "toolset"` | yes |
| `tools` | `string[]` | yes |

### <a id="mcp.tools.updated"></a>`mcp.tools.updated` (event)

Emitted when the tool registry changes (tools added or removed).

Subject: `mcp.tools.updated`
Type: Event (fire-and-forget)

| Field | Type | Required |
|-------|------|----------|
| `added` | `string[]` | yes |
| `removed` | `string[]` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
