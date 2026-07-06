---
"@makaio/framework": major
---

- Breaking: remove the legacy `session.registerExternal` registration surface; observed external sessions now register through canonical import-upsert identity.
- Add an observed-session ingestion policy provider seam so hosts can keep selected observed sessions metadata-only without importing transcript content.
