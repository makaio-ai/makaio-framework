---
"@makaio/framework": patch
"@makaio/cli": patch
---

The CLI now writes bus debug output (`MAKAIO_DEBUG=true`) to stderr for every command that connects to a running bus. Previously the WebSocket transport and bus trace lines landed on stdout, which corrupted the `makaio mcp-server` JSON-RPC stream and the hook response on the full-path fallback. The embedded runtime that `makaio workflow` boots when no server is reachable keeps its current output channel; it is tracked separately.
