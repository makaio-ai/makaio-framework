---
'@makaio/contracts': minor
'@makaio/framework': minor
'@makaio/storage-pg': minor
---

Agent sessions (`MakaioSessionAgent`) now carry merged `allowedTools` and `disallowedTools` grants from the agent definition. New database columns `agents.allowed_tools` and `agents.disallowed_tools` store these lists (sqlite and pg migrations included). `ToolApprovalService` check order is now `.makaioignore` → session `reject` → tool-list deny (denylist or not on allowlist) → session `full-access` → cascade, where an allowlisted tool replaces `always-ask` with an allow, while a cascade `reject` or session `always-ask` override still win. Adapters with tool vocabulary support (`claude-code`, `claude-code-cli`, `claude-code-tmux`) use this logic; others keep the old cascade. New `TOOL_VOCABULARY_BY_ADAPTER` and `toolVocabularyForAdapter` exports in `@makaio/contracts` enumerate supported tool sets per adapter. Headless agent steps no longer require an approval handler for tools on the agent's allowlist.
