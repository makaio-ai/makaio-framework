---
'@makaio/framework': minor
'@makaio/contracts': minor
'@makaio/extension-artifact-patch': minor
'@makaio/extension-artifact-query': patch
---

Add a patch-based Artifact revision contract and a dedicated tool extension. A revision now costs the size of the change: callers send `$set`, `$unset`, `$push` and `$pull` instructions against a mandatory `baseRevision`, address one collection entry by field match or position, and receive the failing path plus a repair hint when a patch is rejected. A stale base revision reports the current revision — the response schema requires it on a `BASE_REVISION_CONFLICT`, so a conflict is always actionable — and says whether the patch can be resent as written — only an append at a fixed path, with no position and no filter — or has to be rebased against a fresh read. Every rejection carries a `repair` hint: the field is required, and it also states whether the failure proves nothing was persisted or leaves the outcome unknown. A patch request carries the same optional `statusPath` observation pointer a full revise does — one shared schema for both — and the host boundary receives the resolved previous revision, so a host layered over the lifecycle writer still emits status changes. The read extension now takes its prototype-safe JSON accessors from the shared contracts instead of its own copies.
