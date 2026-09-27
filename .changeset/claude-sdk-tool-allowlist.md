---
"@makaio/adapter-claude-agent-sdk": patch
---

Forward the caller's tool allowlist and denylist to the Claude Agent SDK.

`allowedTools` / `disallowedTools` on the connector config (for example from a
workflow `delegateToRole({ allowedTools })`) previously never reached the SDK
query options, so a delegate saw every built-in tool and every call went through
`canUseTool` approval. An allowlist now maps to SDK `tools` (only these built-in
tools are available; `mcp__*` entries are excluded) and to SDK `allowedTools`
(auto-approved — the caller's grant is the approval). `disallowedTools` is
forwarded verbatim. Without a policy the query options are unchanged; an empty
allowlist disables all built-in tools.
