---
"@makaio/adapter-claude-agent-sdk": patch
"@makaio/adapter-claude-code-cli": patch
"@makaio/adapter-claude-code-tmux": patch
"@makaio/client-claude-code": patch
"@makaio/contracts": patch
"@makaio/framework": patch
---

Add the Claude Code tmux adapter and shared Claude process utilities, including tmux-backed interactive session control, hook/statusline correlation, prompt materialization, MCP bridge wiring, and conformance coverage.

Extend Claude Code client settings support for project `.mcp.json` management and update MCP session registration with pinned-session semantics for long-lived adapter sessions.
