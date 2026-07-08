---
"@makaio/contracts": patch
"@makaio/services-core": patch
"@makaio/ai-adapters-core": patch
"@makaio/subsystem-client": patch
---

Repair the hook-first ingestion race where a SessionStart hook fires before `client.runtime.started` populates the suppression gate, creating a duplicate tracking stub.

- Add `client.runtime.isAdapterManaged` query subject so the log-importer skip predicate can check runtime truth (in-memory runtime registry lookup) in addition to storage truth.
- `ObservedSessionIngestionService.handleRuntimeStarted` now reconciles (deletes) any racy tracking stub for the same `(source, adapterSessionId)` when the authoritative `client.runtime.started` signal arrives.
- `MakaioManagedSessionCache` gains `invalidate(adapterSessionId)` with generation-based stale-result protection; `BaseLogOrchestrator` subscribes to `client.runtime.started` to evict pinned false-negative verdicts.
- `createDefaultCheckMakaioManaged` accepts an optional `clientId` to enable runtime-truth lookup.
- New `isTrackingStub` predicate as the single source of truth for stub fingerprint identification.
