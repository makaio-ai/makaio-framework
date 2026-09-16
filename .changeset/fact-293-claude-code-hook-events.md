---
'@makaio/client-claude-code': minor
---

Add SubagentStart/SubagentStop/PreCompact hooks and move UserPromptSubmit to request mode (FACT-293)

**New hook events**

Three hook events gain first-class framework wiring:

- `SubagentStart` — mapped to `client.session.subagent.started`. Request-mode: declares `responseCapabilities: ['context.append']`. A live probe against pinned 2.1.219 proved that `hookSpecificOutput.additionalContext` returned on this event lands in the **spawned subagent's** context window, not the parent session's (`probe/subagent-start-context-append.json`). Subagent creation cannot be refused, so the interaction is non-blockable. Like `UserPromptSubmit`, this event now runs as `hook handle` and adds a synchronous round-trip per spawned subagent.
- `SubagentStop` — mapped to `client.session.subagent.completed`. Observer-only.
- `PreCompact` — mapped to `client.session.compaction.pre`. Observer-only. The probe scenario drives `/compact`, the only compaction trigger reachable without a model turn. Against pinned 2.1.219 the event fires that way (`trigger: "manual"`, payload carries `trigger` and `custom_instructions`), but not inside the probe's isolated configuration directory, where the local command returns an empty result without invoking the hook. The committed capture therefore records `hookFired: false`; the mapping rests on documentation plus the out-of-harness observation, not on committed live evidence.

**Operational change: UserPromptSubmit is now a request-mode hook**

`UserPromptSubmit` declares `responseCapabilities: ['context.append']`. This means every `UserPromptSubmit` event in a wired Claude Code session now runs as `makaio --no-launch hook handle claude-code UserPromptSubmit --timeout 1000` instead of the previous observer-only `hook received` command. Concretely:

- Every user prompt incurs a synchronous round-trip to the makaio server with a **1 s timeout** (context-only, non-blockable — see request-mode timeout policy below). If the server is unreachable or slow, Claude Code will wait up to that timeout before proceeding.
- The hook contract catalog version advances `1.1.0 → 1.3.0` (purely additive — `UserPromptSubmit` and `SubagentStart` join `supportedInteractions` as non-blockable, every 1.1.0 contributor remains valid).
- `UserPromptSubmit` is declared non-blockable: a closed-policy contributor cannot turn a failure here into a deny.

**New: PostCompact hook (raw ingress only)**

`PostCompact` is now declared in the Claude Code client definition, wired for raw ingress only (no `frameworkSubject`). Present since Claude Code 2.1.76, within the `^2.1.0` floor. The hook carries a `trigger` field. The post-compaction framework signal remains `client.session.started` with `startMode: 'compact'`. Note: Claude Code emits `PreCompact → SessionStart(compact) → PostCompact`; Codex emits `PreCompact → PostCompact → SessionStart(compact)` — consumers must not assume a fixed ordering.

**Request-mode timeout policy**

Context-only (non-blockable) interactions — `SessionStart`, `UserPromptSubmit`, `SubagentStart` — now use a **1 s timeout** (`--timeout 1000`) instead of 5 s. `hook handle` has no `--debounce-failure`, so a down server would stall every prompt and subagent spawn for the full timeout; failing fast limits the blast radius. Blockable interactions (`PreToolUse`) retain the 5 s timeout. `applyClaudeCodeWiring` migrates existing 5 s installations automatically.

**Migration**

`applyClaudeCodeWiring` migrates existing installations automatically on the next wiring apply: it removes the stale `hook received claude-code UserPromptSubmit` sentinel and installs the new `hook handle` command in its place, and replaces any `--timeout 5000` context-only commands with `--timeout 1000`. No manual intervention is required.

The change follows the same pattern as the `SessionStart` request-mode migration shipped in `claude-code-session-start-request-mode.md`.
