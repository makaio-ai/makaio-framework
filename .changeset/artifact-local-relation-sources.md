---
'@makaio/framework': minor
'@makaio/contracts': minor
'@makaio/extension-artifact-patch': minor
---

Allow Artifact relations to originate from declared local parts with `sourceLocalId`. Validate the source against its containing revision, preserve distinct source parts in context and rendered views, and keep whole-Artifact uniqueness separate from local-source relations. Data patches reject changes that invalidate carried relation sources.
