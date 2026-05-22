# @makaio/app-mcp-server

MCP stdio bridge for Makaio. Connects to a running Makaio bus server as a bus client and exposes its tools to any MCP-compatible host (such as Claude Desktop) over standard input/output JSON-RPC. This is a client-only surface — it does not boot a kernel or host a bus server itself; it relies on a `makaio serve` instance already running.

## Architecture Role

Surfaces sit at the top of the Kernel → Runtime → Platform → Surface layering. `@makaio/app-mcp-server` is a thin client surface: it connects outward to a hosted kernel (via `@makaio/bus-core`) and bridges inward to the MCP stdio transport provided by `@makaio/subsystem-mcp-http-server`.

```
MCP host (e.g. Claude Desktop)
  │  stdin / stdout (JSON-RPC)
  ▼
@makaio/app-mcp-server   ← client-only surface
  │  bus client (WebSocket)
  ▼
makaio serve  (hosted kernel + tools)
```

The CLI's `makaio mcp-server` command is the standard entry point for this surface; see `@makaio/cli` for invocation details.

## Features

- **MCP stdio transport** — reads JSON-RPC from stdin and writes responses to stdout, conforming to the [Model Context Protocol](https://modelcontextprotocol.io) specification.
- **Tool dispatch via bus** — forwards MCP tool-call requests through the connected Makaio bus, making all registered framework tools available to the MCP host without any per-tool wiring.
- **Session scoping** — each bridge instance operates under a unique session ID (generated as a random UUID when not supplied) so tool execution is properly scoped.
- **Graceful termination** — the bridge resolves when stdin ends or is closed, or when an `AbortSignal` is provided and aborted. The caller owns the bus lifecycle.
- **Race-safe startup** — re-checks signal and stdin state after the async server-start gap to avoid missing termination events that arrive during startup.

## Usage

The bridge is normally invoked through the CLI:

```bash
# Requires a running makaio serve instance
makaio mcp-server
```

To integrate with Claude Desktop, add an entry to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "makaio": {
      "command": "makaio",
      "args": ["mcp-server"]
    }
  }
}
```

## Key Files

| Path | Purpose |
|------|---------|
| `src/mcp-bridge.ts` | `startMcpBridge(bus, opts)` — core bridge implementation |
| `src/index.ts` | Public package entry point — re-exports `startMcpBridge` and `McpBridgeOptions` |

## Installation

Private workspace package — not published to npm. The `makaio mcp-server` CLI command in `@makaio/cli` is the intended entry point for end users.
