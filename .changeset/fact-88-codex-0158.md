---
'@makaio/client-codex': minor
---

Pin Codex client detection and managed installation to Codex CLI 0.158.0,
and recover Codex fork lineage from the rollout file at session start.

- A forked Codex thread now reports `SessionStart` with `source: "fork"`
  (0.144.1 reported `startup`). It is normalized to `startMode: 'fork'`. The
  hook payload still carries no lineage field, so the parent comes from the
  rollout file.
- `hook-normalizer` carries `transcript_path` through to `transcriptPath` on
  `client.session.started`. Codex points it at the rollout JSONL file it
  materializes for the starting thread.
- The internal `fork-sniff` module performs a bounded read of the rollout
  head. The file's own metadata record is the first one and names the parent
  thread when the thread was forked; later metadata records are ancestor
  history copied into the fork and are ignored.
- `CodexClientSessionService` sniffs only `'fork'` starts and populates
  `parentAdapterSessionId` from the sniff. When no parent is found, the start
  is reported as `'fresh'`, so the event never claims a fork without a parent.
  `startup` (`'fresh'`) and `resume` are not sniffed.
- The sniff is fail-open: a missing, unreadable, or oversized rollout head
  counts as "parent not found" and never blocks hook processing.
- The `SessionEnd` and `Interrupt` hook events that Codex added in 0.156 are
  intentionally not declared. They have no consumer and no bus subject, and
  declaring them would spawn a hook process on every interrupt and every
  session end.

BREAKING: `binary.supportedVersions` and the managed-install version move from
exactly 0.144.1 to exactly 0.158.0, so detection reports any other Codex
version as unsupported.
