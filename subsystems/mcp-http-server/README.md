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

### Multiple concurrent clients

One endpoint serves many MCP clients at once. Two session concepts meet here and
must not be confused:

| Concept | Key | Lifetime |
|---------|-----|----------|
| Adapter session | `?adapterSessionId=` query param → `x-adapter-session-id` header | Registered and unregistered by the adapter; many are live concurrently |
| MCP protocol session | `Mcp-Session-Id` header | One per connected MCP client; opened by `initialize`, closed by `DELETE`, idle reaping, or endpoint shutdown |

Each MCP client gets its own transport and MCP `Server` instance, created on its
`initialize` request and disposed through a single close path. Nothing needs to
be configured for this: connect as many clients as you like.

An idle MCP session is reaped after `idleTimeoutMs` (default 10 minutes). A
session is only idle when it has **no open HTTP exchange** — a client holding
its standalone SSE stream is never idle, so long-lived interactive clients
survive indefinitely between tool calls. The MCP SDK client does not send
`DELETE` on close, so reaping is what releases sessions in practice.

| Option | Default | Meaning |
|--------|---------|---------|
| `idleTimeoutMs` | 10 minutes | Idle time with no open HTTP exchange before a session is closed |
| `sweepIntervalMs` | 60 seconds | How often the reaper looks for idle sessions |

`sweepIntervalMs` bounds how long a session can outlive its idle timeout, so a
short `idleTimeoutMs` wants a proportionally short sweep. Both must be positive
finite numbers of milliseconds and are validated when the handler is created,
not on the first request. `sweepIntervalMs` is additionally capped at
2147483647 ms because it becomes a timer delay, and longer delays are coerced
to 1 ms; `idleTimeoutMs` is plain clock arithmetic, so a month-long idle policy
is fine.

`options.onclose` is an **endpoint-level** signal. It fires once when the
endpoint stops serving; it does not fire when an individual client disconnects
or terminates its own MCP session.

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
| `createHttpMcpHandler()` | Create a mountable Node `(req, res)` MCP handler without binding a port |
| `createFetchMcpHandler()` | Create a mountable fetch-style `Request` → `Response` MCP handler |
| `createMcpServer()` | Create an MCP `Server` instance without starting a transport |
| `createMcpEndpoint()` | Assemble the transport-independent half of an endpoint (registry, context registry, close gate); the seam both HTTP handlers are built on |
| `McpTransportRegistry` | Owns one transport/server pair per MCP protocol session; used internally by both handlers |
| `McpServerBridgeService` | Bus-connected service managing the HTTP MCP server lifecycle with LRU session tracking |
| `McpContextRegistry` / `IMcpContextRegistry` | Per-adapter-session context store for routing tool calls to the correct agent |
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
