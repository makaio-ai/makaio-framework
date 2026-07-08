---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Add live activation support to `storage:session.importUpsert`, allowing hook-first external sessions to be registered as active atomically while preserving active, closed, and archived lifecycle states during later import enrichment.
