---
"@makaio/adapter-claude-agent-sdk": patch
---

Enforce the caller's tool allowlist and forward the denylist to the Claude Agent SDK.

`allowedTools` / `disallowedTools` on the connector config (for example from a
workflow `delegateToRole({ allowedTools })`) previously never reached the SDK
query, so a delegate could use every tool. With an allowlist, the SDK query now
exposes only the listed built-in tools (SDK `tools`), and the `canUseTool`
handler denies any tool call, built-in or `mcp__*`, whose name is not on the
list before central approval is asked. Listed tools are not auto-approved; they
still go through the central tool approval service. An empty allowlist denies
every tool. Allowlist entries must be plain tool names: command-specific
permission rules such as `Bash(git status)` are rejected with a configuration
error instead of being widened to the base tool. `disallowedTools` is forwarded
verbatim, rules included. Without a policy nothing changes.
