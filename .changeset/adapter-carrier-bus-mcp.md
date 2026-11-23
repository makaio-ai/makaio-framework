---
"@makaio/framework": major
"@makaio/adapter-cursor-sdk": minor
"@makaio/adapter-claude-agent-sdk": patch
"@makaio/adapter-claude-code-cli": patch
"@makaio/adapter-claude-code-tmux": major
---

Adapters send their cross-namespace lifecycle requests through the carrier bus
the adapter subsystem gives them (`globalBus`) instead of the host singleton
`MakaioBus`. The caller of a send is the carrier of the bus it is sent on, so
these requests are now attributed to the adapter, not to the host. An own
context minted on the adapter's carrier (`globalBus.own(...)`) can now reach
every MCP helper; on the host singleton it threw `ForeignOwnContextError`.

- MCP session register and unregister (Cursor SDK, Claude Agent SDK, Claude
  Code CLI, Claude Code tmux), the Claude Agent SDK MCP server resolve request,
  and the tmux hook wiring and MCP settings writes send on `globalBus`.
  Teardown mints its `stop` context on the same bus.
- `ClaudeCodeAdapter` uses the required `globalBus` from its configuration and
  no longer falls back to the singleton.

Breaking changes:

- `@makaio/framework/adapter-subsystem`: `LoadedAdapter` requires `carrierBus`,
  the carrier bus of the extension that contributed the adapter, and the adapter
  factory receives it as the required `globalBus` of its init options. A tool's
  execution context bus (`ctx.bus`) is now the contributing extension's carrier
  instead of the tool registry's bus.

- `@makaio/adapter-cursor-sdk`: `CursorSdkSessionConfig` requires `globalBus`.
- `@makaio/adapter-claude-code-tmux`: `addMcpServerToProject` and
  `removeMcpServerFromProject` take the bus to send on as their first argument.
