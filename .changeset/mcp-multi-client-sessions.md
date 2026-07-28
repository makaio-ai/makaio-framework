---
'@makaio/subsystem-mcp-http-server': major
'@makaio/framework': major
---

Serve many concurrent MCP clients from one HTTP endpoint.

The endpoint previously built a single streamable-HTTP transport for its whole
lifetime. The MCP SDK treats that as one protocol session, so the second client
to send `initialize` was rejected with `-32600 "Invalid Request: Server already
initialized"` — permanently, since closing the transport never resets its
initialized state. Any host that spawns a fresh MCP client per turn could
therefore only ever connect once.

A new `McpTransportRegistry` gives the MCP protocol session its own owner: one
transport and one MCP `Server` per `Mcp-Session-Id`, created on `initialize`,
kept alive by an activity lease held for as long as a request or SSE stream is
open, reaped once idle, and disposed through a single close path shared by
client `DELETE`, idle reaping, and endpoint shutdown. Both the Node and the
fetch handler route through it, so their session and error semantics can no
longer drift apart. Adapters need no changes: routing is by `Mcp-Session-Id`,
which is orthogonal to the `adapterSessionId` query parameter.

This also fixes a second defect with the same root cause: a client sending
`DELETE` fired the endpoint-level `onclose`, which reset the MCP server bridge
and rebound a new port while the old server was still listening, stranding every
adapter still pointed at it.

Breaking changes:

- `createMcpRequestHandler` is removed from the public surface. Its signature
  bound a handler to one transport, which is no longer expressible. Use
  `createHttpMcpHandler` or `createFetchMcpHandler`.
- `options.onclose` is re-scoped from transport-level to endpoint-level. It
  fires once when the endpoint stops serving and no longer fires when an
  individual MCP client disconnects or terminates its session.
- Transport `connect()` failures now surface as a `500` on the request that
  triggered session creation instead of rejecting at handler construction.
  Option validation stays eager, so an invalid `toolExecutionTimeoutMs` still
  rejects when the handler is created.

New options on `createHttpMcpHandler` / `createFetchMcpHandler` /
`startHttpMcpServer`: `idleTimeoutMs` (default 10 minutes) and
`sweepIntervalMs` (default 60 seconds). Both are validated eagerly and must be
positive finite numbers of milliseconds; `sweepIntervalMs` is additionally
capped at the 2147483647 ms timer ceiling, since longer delays are coerced to
1 ms.

`createMcpEndpoint` is exported as the seam both HTTP handlers are built on: it
assembles the context registry, transport registry, and idempotent close gate,
and takes only the SDK transport as a parameter. Hosts that need a third
transport flavour can reuse it instead of restating the endpoint's lifecycle.
