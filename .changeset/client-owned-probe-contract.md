---
"@makaio/client-claude-code": minor
"@makaio/client-codex": minor
---

Make provider-native hook response shapes client-owned and bind the evidence chain.

- Export `renderClaudeCodeNativeResponse` and `renderCodexNativeResponse` as the single per-client source of native hook output; both `hook.handle` composers now render through them
- Make the Claude Code renderer event-generic, so events without a permission decision render `hookSpecificOutput.additionalContext` alone instead of falling through to a no-op
- Introduce a `ClientProbeContract` seam so the evidence-capture harness derives probe sentinels from the client's own renderer rather than hand-written replicas, removing the risk of a composer drifting from the shape proven against a pinned binary
- Resolve probe contracts through a client registry instead of hardcoded provider comparisons in scenario generation
- Pin the exact native sentinel bytes per probe scenario so a renderer change cannot silently invalidate committed evidence
- Fix a latent probe-generator bug that attached `permissionDecision` to every Claude Code context-append sentinel regardless of event, which would have produced invalid native output for events without a permission decision

Central source-evidence ownership is unchanged: a client contributes how a claimed effect is rendered and observed, never which effects it may claim.
