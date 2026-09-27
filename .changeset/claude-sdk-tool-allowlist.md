---
"@makaio/adapter-claude-agent-sdk": patch
---

Forward the caller's tool allowlist and denylist to the Claude Agent SDK.

`allowedTools` / `disallowedTools` on the connector config (for example from a
workflow `delegateToRole({ allowedTools })`) previously never reached the SDK
query options, so a delegate saw every built-in tool. An allowlist now maps to
SDK `tools` as an availability filter: entries are reduced to base built-in names
(`Bash(git status)` becomes `Bash`, duplicates removed, `mcp__*` entries
excluded). Allowlisted tools are not auto-approved; every call still goes through
`canUseTool` and the central tool approval service. `disallowedTools` is
forwarded verbatim. Without a policy the query options are unchanged; an empty
allowlist disables all built-in tools.
