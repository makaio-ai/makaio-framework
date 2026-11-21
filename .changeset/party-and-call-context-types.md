---
'@makaio/core': minor
---

Add the types `Party`, `PartyRef`, `PartyKind`, `CallClaim`, `CallContext`,
`CallContextRecord`, `CrossHostMetadata` and `OwnWorkPurpose`, their schemas
(`PartyRefSchema`, `PartySchema`, `CallClaimSchema`, `CrossHostMetadataSchema`,
`CallContextRecordSchema`), the guards `isCallClaim` and `isInProcessCaller`,
the twelve party kind constants the core contributes, the object
`CorePartyKind` and the type `MakaioPartyKind`. This release carries the types and
schemas only: a `CallContext` can be named in signatures and passed on, but
nothing creates one yet. Minting (`bus.own`, `ctx.call`) follows in a later
release.
