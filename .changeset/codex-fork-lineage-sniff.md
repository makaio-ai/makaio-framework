---
'@makaio/client-codex': patch
---

Recover Codex fork lineage from the rollout file at session start

Codex classifies a fork child next to a brand-new thread: both fire
`SessionStart` with `source: 'startup'`, and the hook payload carries no
lineage field at all (`session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model`, `permission_mode`, `source` — nothing else).
A fork child therefore never reached `startMode: 'fork'` and was registered
as a root session.

- `hook-normalizer` now carries `transcript_path` through to `transcriptPath`
  on `client.session.started`. Codex points it at the rollout JSONL file it
  materializes for the starting thread.
- New internal `fork-sniff` module performs a bounded read of the rollout
  head. The file's own metadata record is the first one and names the parent
  thread when the thread was forked; later metadata records are ancestor
  history copied into the fork and are ignored.
- `CodexClientSessionService` upgrades `startMode` from `'fresh'` to `'fork'`
  and populates `parentAdapterSessionId` when the sniff finds a parent.
  Resume is deliberately not sniffed: it appends to the thread's own rollout
  file, so a resumed fork child would be re-registered instead of rebound.
- The sniff is fail-open: a missing, unreadable, or oversized rollout head
  leaves the payload untouched and never blocks hook processing.

The `SessionStart.source` mapping is unchanged and its doc comment now states
what was verified against the pinned `rust-v0.144.1` source instead of calling
the `resume` mapping tentative.
