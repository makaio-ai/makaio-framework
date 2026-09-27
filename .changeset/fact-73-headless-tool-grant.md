---
'@makaio/contracts': minor
'@makaio/framework': minor
'@makaio/storage-pg': minor
'@makaio/adapter-claude-code-cli': major
---

Agent sessions (`MakaioSessionAgent`) now carry merged `allowedTools` and `disallowedTools` grants from the agent definition. New database columns `agents.allowed_tools` and `agents.disallowed_tools` store these lists (sqlite and pg migrations included). `ToolApprovalService` check order is now `.makaioignore` → session `reject` → tool-list deny (denylist or not on allowlist) → session `full-access` → cascade, where an allowlisted tool replaces `always-ask` with an allow, while a cascade `reject` or session `always-ask` override still win. Adapters with tool vocabulary support (`claude-code`, `claude-code-cli`, `claude-code-tmux`) use this logic; others keep the old cascade. New `toolVocabularyForAdapter` export in `@makaio/contracts` returns the tool vocabulary of an adapter (undefined when it has none). Headless agent steps no longer require an approval handler for tools on the agent's allowlist.

**Breaking (`@makaio/adapter-claude-code-cli`):** `allowedTools` no longer emits `--allowedTools`, so listed tools are no longer pre-approved by the CLI. Their calls go through the permission prompt tool to `ToolApprovalService`, which grants listed tools and denies unlisted ones. `disallowedTools` still emits `--disallowedTools`. Hosts that start the CLI adapter with an allowlist need the MCP bridge (`McpServerBridgeService`) running; without it, calls that need permission are denied.
