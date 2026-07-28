---
'@makaio/client-claude-code': minor
'@makaio/ai-adapters-claude-process-shared': patch
---

Claude Code session config leases no longer own the `projects/` transcript store.

A lease directory is an ephemeral auth/settings sandbox whose lifetime is one
connector generation, but Claude Code also wrote its conversation transcripts
(`$CLAUDE_CONFIG_DIR/projects/<cwd-derived-dir>/<sessionId>.jsonl`) inside it —
so destroying a lease deleted the transcript, and `--resume`/`--fork-session`
from any successor lease (rehydration, connector swap, fork child) failed with
"No conversation found". The setup handler now links the lease's `projects/`
entry to the durable config source (`<profile config dir>/projects`, falling
back to `~/.claude/projects`) for `full` and `auth-only` inheritance, so every
lease of the same config source shares one transcript store. Lease teardown
removes only the link. `empty` inheritance deliberately keeps transcripts
lease-local.

`handleClaudeCodeSessionConfigSetup` gains an optional options parameter with
`projectsStoreDir` to redirect the durable store; the shared conformance
fixture uses it to keep test transcripts in a suite-scoped store instead of
the operator's real config home.

Note: with this change, Makaio-spawned sessions become visible to the native
`claude --resume` picker of the account's config source.
