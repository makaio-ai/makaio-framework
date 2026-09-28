---
'@makaio/client-codex': patch
---

Pin Codex client detection and managed installation to Codex CLI 0.158.0.

- `binary.supportedVersions` and the managed-install version move from exactly
  0.144.1 to exactly 0.158.0.
- A forked Codex thread now reports `SessionStart` with `source: "fork"`
  (0.144.1 reported `startup`). It is normalized to `startMode: 'fork'` using
  the rollout parent lookup, and falls back to `'fresh'` when no parent is
  found.
- The `SessionEnd` and `Interrupt` hook events that Codex added in 0.156 are
  intentionally not declared. They have no consumer and no bus subject, and
  declaring them would spawn a hook process on every interrupt and every
  session end.
