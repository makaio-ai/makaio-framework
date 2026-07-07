---
'@makaio/contracts': minor
'@makaio/services-core': patch
'@makaio/client-claude-code': minor
---

Register native fork children with fork lineage at SessionStart

**Contracts:**
- `ForkSessionLineageSchema.forkPointMessageId` is now nullable — hook-first
  fork registration precedes transcript analysis and cannot yet identify the
  fork point message.
- `ClientSessionStartedSchema` gains optional `startMode` and
  `parentAdapterSessionId` fields so adapter-derived emissions can carry the
  fork signal at session start.
- New extraction-exclusion metadata contract (`EXTRACTION_EXCLUSION_KEY`,
  `isExtractionExcluded`, `buildExtractionExclusionMetadata`) in
  `@makaio/contracts` session domain — downstream extraction pipelines import
  this to mark and detect sessions excluded from re-extraction.

**Claude Code client (`@makaio/client-claude-code`):**
- Hook normalizer maps the vendor `source` field (`startup` / `resume` /
  `clear` / `compact`) to `startMode` on `client.session.started` payloads.
- New `fork-sniff` module performs a bounded read of the transcript head at
  session-start time: when `startMode === 'resume'` and the transcript
  contains user messages with a foreign session ID, the service upgrades
  `startMode` to `'fork'` and populates `parentAdapterSessionId`.
- The sniff is fail-safe: any I/O or parse error falls back to plain resume.

**Observed-session ingestion:**
- `handleSessionStarted` now branches on `startMode === 'fork'` with a valid
  `parentAdapterSessionId` to register the session as `kind: 'fork'` with a
  parent link (forkPointMessageId null, enriched later by transcript import).
- Non-fork behavior (absent startMode, fresh, resume, clear, compact) is
  unchanged — all register as root sessions.

**Import handlers (drizzle + memory):**
- Fork lineage identity columns (`branchKind`, `parentExternalSessionId`) now
  use existing-wins semantics: once set by hook-first registration, later
  imports cannot overwrite them.
- `forkPointMessageId` uses fill-once semantics: null at hook-first
  registration, filled exactly once by the transcript import.
