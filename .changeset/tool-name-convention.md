---
'@makaio/adapter-claude-agent-sdk': major
'@makaio/contracts': minor
'@makaio/framework': minor
'@makaio/agent-sdk': patch
---

Tool allow/deny lists (`allowedTools`, `disallowedTools`) now name tools with the Makaio
framework tool names (`read_file`, `write_file`, `edit_file`, `glob_files`, `grep_files`,
`shell_exec`, `shell_kill`, `spawn_subagent`, `send_to_subagent`) instead of adapter-native
names. MCP tools keep the `mcp__<server>__<tool>` form. `shell_exec` entries may carry a
command rule, e.g. `shell_exec(git status)` (exact match) or `shell_exec(git log:*)`
(prefix match; never matches commands containing shell operators).

`@makaio/contracts` adds a new `tool-names` module (`resolveToolPolicy`,
`parseToolListEntry`, `matchesCommandRule`, `toNativeToolName`, `toMakaioToolName`,
`ToolNameError`) that parses, validates, and resolves these lists against a native tool
vocabulary.

`@makaio/adapter-claude-agent-sdk` now translates Makaio tool names to Claude Code's
native tool names, and supports `shell_exec(...)` command rules on its `Bash` tool.

**Breaking:** the adapter no longer accepts Claude Code tool names (`Read`, `Bash`, ...)
in `allowedTools`/`disallowedTools`; unknown names are rejected with a `ToolNameError`.
Callers must migrate their tool lists to Makaio tool names.

`@makaio/agent-sdk` keeps accepting Claude Code tool names at its Claude-compatible
`query()` surface and translates them to Makaio tool names internally.
