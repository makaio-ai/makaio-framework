---
'@makaio/ai-adapters-core': major
'@makaio/contracts': major
'@makaio/services-core': patch
---

Remove the dead host-tier locality-verdict fallback from agent rehydration. No producer ever writes a `nativeLocality` verdict onto a persisted agent record, so the fallback branch in `resolveNativeLocalityKind` could never fire — the caller's explicit `resumeAdapterSessionId` was already the only live gate, and it is now the only gate by contract. **BREAKING**: the `adapter.rehydrateAgent` request drops its `adapterSessionId` field; it was consumed solely by the removed fallback (an identity marker never implies resume, and a resumed generation adopts the resume target as its identity). Callers that evaluated locality keep passing `resumeAdapterSessionId`; callers that passed only the identity marker were already getting fresh-with-history behavior and are unaffected. If a future ownership model needs persisted locality, it will be designed as part of that model rather than revived from this fallback.
