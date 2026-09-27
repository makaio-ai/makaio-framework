---
'@makaio/adapter-claude-agent-sdk': major
'@makaio/adapter-claude-code-cli': major
'@makaio/contracts': minor
'@makaio/framework': minor
'@makaio/agent-sdk': major
---

Tool allow/deny lists (`allowedTools`, `disallowedTools`) now name tools with the Makaio
framework tool names (`read_file`, `write_file`, `edit_file`, `glob_files`, `grep_files`,
`shell_exec`, `shell_kill`, `spawn_subagent`, `send_to_subagent`) instead of adapter-native
names. MCP tools keep the `mcp__<server>__<tool>` form and require both a non-empty server
and a non-empty tool part (`mcp__<server>__<tool>`); `mcp__`, `mcp____tool`, and `mcp__github`
are rejected as malformed. `shell_exec` entries may carry a command rule, e.g.
`shell_exec(git status)` (exact match) or `shell_exec(git log:*)` (prefix match). A `*` is
only accepted as the trailing `:*` prefix marker; any other `*` in a rule is rejected as
malformed. Allow-prefix rules never match a command that contains a shell metacharacter
(`& ; | < > \` $ ( ) { }`) or a newline, so `shell_exec(git log:*)` cannot match
`git log & rm -rf /`. Deny rules use their own, best-effort semantics: the command is split
on those same metacharacters into segments, and a deny rule (exact or prefix) denies the
call if *any* segment matches; this does not recognise indirection through `env`,
`bash -c`, or absolute paths.

`@makaio/contracts` adds a new `tool-names` module (`resolveToolPolicy`,
`parseToolListEntry`, `matchesCommandRule`, `toNativeToolName`, `toMakaioToolName`,
`ToolNameError`) that parses, validates, and resolves these lists against a native tool
vocabulary.

`@makaio/adapter-claude-agent-sdk` now translates Makaio tool names to Claude Code's
native tool names, and supports `shell_exec(...)` command rules on its `Bash` tool.
Whenever the caller passes an allowlist or a denylist, the adapter clears the provider's
own auto-approved tools, resets `queryOptions.permissionMode` to `'default'` (permission
modes like `bypassPermissions`, `acceptEdits`, `auto`, or `dontAsk` would skip `canUseTool`
checks), and does not forward `updatedPermissions` from the approval response, so a
persistent SDK-side rule can no longer skip `canUseTool` for later calls. When central
tool approval returns an approver-modified `updatedInput`, the adapter re-runs the tool
policy against that modified input and denies the call if it now fails.

**Breaking:** the adapter no longer accepts Claude Code tool names (`Read`, `Bash`, ...)
in `allowedTools`/`disallowedTools`; unknown names are rejected with a `ToolNameError`.
Callers must migrate their tool lists to Makaio tool names.

`@makaio/adapter-claude-code-cli` now translates Makaio tool names to Claude Code's native
entries for `--allowedTools`/`--disallowedTools` (`shell_exec(git log:*)` becomes
`Bash(git log:*)`); Claude Code tool names are rejected with a `ToolNameError`
(**breaking**). Its allowlist still only pre-approves tools and does not restrict availability.

`@makaio/agent-sdk` keeps accepting Claude Code tool names at its Claude-compatible
`query()` surface and translates them to Makaio tool names internally.

**Breaking:** Claude Code tool names without a Makaio equivalent (e.g. `WebFetch`,
`WebSearch`, `TodoWrite`) are no longer silently forwarded; they now throw a
`ToolNameError` when passed in `allowedTools`/`disallowedTools`. Malformed entries
(e.g. `Bash(npm run *)`, `mcp__github`, `mcp__s__*`) now throw `malformed-entry`; use
`Bash(npm run:*)` for prefix-match rules instead.
