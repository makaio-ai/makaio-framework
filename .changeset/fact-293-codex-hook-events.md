---
'@makaio/client-codex': major
---

Add SubagentStart/SubagentStop/PreCompact/PostCompact hooks and extend UserPromptSubmit mapping (FACT-293)

**Breaking: `normalizeCodexHook` return type changed**

`normalizeCodexHook` is exported from `@makaio/client-codex`'s `./runtime` subpath. Its return type changed from `CodexNormalizedEvent | null` to `CodexNormalizedEvent[]`. Callers that previously checked for `null` must now iterate the array or destructure: `const [first] = normalizeCodexHook(raw)` (first element is `undefined` when the event is unknown or filtered). Any caller that iterates a single result must handle zero or multiple elements.

**New hook events**

Four hook events are added to the Codex client definition:

- `SubagentStart` — mapped to `client.session.subagent.started`. Request-capable: declares canonical `context.append`, proven live against pinned CLI 0.144.1 (`probe/subagent-start-context-append.json`). The appended context lands in the *subagent's* context window, not the parent's. Subagent creation cannot be refused (`continue: false` is parsed but ignored), so no block capability is declared and the interaction is non-blockable.
- `SubagentStop` — mapped to `client.session.subagent.completed`. Observer-only; the hook is confirmed to fire live (`probe/subagent-stop-observation.json`).
- `PreCompact` — mapped to `client.session.compaction.pre`. Observer-only; the hook is confirmed to fire live with `trigger: "auto"` (`probe/pre-compact-observation.json`).
- `PostCompact` — raw-only; no `frameworkSubject`. The post-compaction signal is delivered via a subsequent `SessionStart` hook with `source: 'compact'` (maps to `startMode: 'compact'`). `PostCompact` is wired for raw ingress only and is not emitted into the global `client.*` namespace. The hook is confirmed to fire live with `trigger: "auto"` (`probe/post-compact-observation.json`).
- `PermissionRequest` — raw-only; no `frameworkSubject`. Fires when Codex requests tool-use permission from the user. Wired for raw ingress only; the response surface is not yet proven against the pinned `rust-v0.144.1` source, so no capability is declared.

**New: `startMode` mapping on SessionStart**

The normalizer now maps the Codex CLI `SessionStart.source` field to `startMode` on the `client.session.started` payload. Mapping: `startup` → `'fresh'`, `resume` → `'resume'`, `clear` → `'clear'`, `compact` → `'compact'`. Unknown or absent source values leave `startMode` absent. When Codex emits a `SessionStart` with `source: 'compact'` after a compaction cycle, the resulting `session.started` event carries `startMode: 'compact'`, providing the post-compaction signal without a separate `compaction.post` subject.

**Contract version**

`CODEX_CONTRACT_VERSION` moves from `1.1.0` to `1.2.0`, adding `SubagentStart` to `CODEX_SUPPORTED_INTERACTIONS` as a request-capable, non-blockable interaction. Purely additive: every `1.1.0` contributor remains valid.

**Changed: UserPromptSubmit now emits two bus events**

The hook normalizer now emits `client.session.turn.started` *before* `client.session.userPrompt.submitted` when it processes a `UserPromptSubmit` hook. Subscribers that previously only saw `userPrompt.submitted` will continue to receive it unchanged; the additional `turn.started` event is new.

**Request-mode timeout policy**

`SubagentStart` is non-blockable (context-only) and now uses a **1 s timeout** (`--timeout 1000`). All other request-mode hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) are blockable and retain the 5 s timeout. `applyCodexWiring` migrates existing `SubagentStart --timeout 5000` installations automatically on the next apply.

**Subagent hook identity note**

On both `SubagentStart` and `SubagentStop`, the Codex CLI places the PARENT session id in the hook's `session_id` field. The normalizer maps this directly to `adapterSessionId` on the base — it is the parent session id, not a subagent own session id. The subagent's own identity is carried by `agentId` (required; events without it are dropped). When the Codex hook payload includes `turn_id`, the normalizer extracts it as `turnId` on both subagent events, allowing consumers to correlate the subagent lifecycle with the parent turn that spawned it.
