# @makaio/subsystem-mcp-http-server

HTTP and stdio Model Context Protocol (MCP) server bridge for the Makaio
framework. Subprocess-based adapters (e.g. `claude-agent-sdk`,
`claude-code-cli`) use this package to route tool calls and approval requests
back to the Makaio bus without knowing about the bus transport directly.

## Usage

### HTTP MCP server (adapter subprocesses)

```typescript
import { startHttpMcpServer, McpContextRegistry } from '@makaio/subsystem-mcp-http-server';

const handle = await startHttpMcpServer(bus, {
  port: 0, // OS assigns a free port
  resolveContextOverrides: (adapterSessionId) =>
    contextRegistry.resolve(adapterSessionId),
});

console.log(`MCP HTTP server listening on port ${handle.port}`);

// Register a session so tool calls are routed correctly:
handle.contextRegistry.register('adapter-session-id', {
  agentId: 'agent-1',
  adapterId: 'claude-code',
  sessionId: 'sess-abc',
});

// When done:
await handle.close();
```

### stdio MCP server (local tooling)

```typescript
import { startMcpServer } from '@makaio/subsystem-mcp-http-server';

const handle = await startMcpServer(bus, sessionId, { transport: 'stdio' });
// Reads/writes MCP protocol over stdin/stdout
await handle.close();
```

### Bus-managed service (`McpServerBridgeService`)

For production use, register the `McpServerBridgeService` as a framework
extension. It starts the HTTP MCP server lazily on the first
`mcp.session.register` bus call and manages session TTL eviction automatically.

```typescript
import { McpServerBridgeService } from '@makaio/subsystem-mcp-http-server';

// Instantiated by the extension coordinator via the adapter subsystem.
const service = new McpServerBridgeService(bus);
```

## API Overview

| Export | Description |
|--------|-------------|
| `startHttpMcpServer()` | Start an HTTP MCP server; returns `HttpMcpServerHandle` with `port`, `contextRegistry`, and `close()` |
| `startMcpServer()` | Start a stdio or HTTP MCP server; returns `StdioMcpServerHandle` or `HttpMcpServerHandle` |
| `createMcpServer()` | Create an MCP `Server` instance without starting a transport |
| `createMcpRequestHandler()` | Create the Hono/HTTP request handler for the MCP transport |
| `McpServerBridgeService` | Bus-connected service managing the HTTP MCP server lifecycle with LRU session tracking |
| `McpContextRegistry` / `IMcpContextRegistry` | Per-session context store for routing tool calls to the correct agent |
| `resolveMcpTools()` | Discover tools from extension toolsets and convert them to MCP tool definitions |
| `toolInfoToMcpTool()` | Convert a single `ToolInfo` entry to an MCP tool descriptor |
| `APPROVE_TOOL_NAME` | Constant name of the built-in tool-approval MCP tool |
| `type McpServerOptions` | `transport`, `port`, `agentContext`, `toolDiscovery` |
| `type HttpMcpServerHandle` | `port`, `contextRegistry`, `close()` |
| `type StdioMcpServerHandle` | `close()` |
| `type McpAgentContext` | Agent context shape (re-exported from `@makaio/contracts`) |
| `type McpToolEntry` | Single MCP tool definition with Zod schema |
| `type ResolveContextOverrides` | Callback signature for per-session context resolution |

## Installation

`@makaio/subsystem-mcp-http-server` is a private workspace package:

```json
{ "@makaio/subsystem-mcp-http-server": "workspace:*" }
```
