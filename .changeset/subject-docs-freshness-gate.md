---
"@makaio/framework": patch
---

Add a freshness gate for the generated bus subject documentation. `yarn validate` now runs `yarn validate:subject-docs`, which re-renders the pages under `docs/subjects/` in memory and fails when a committed page is outdated, missing, or no longer generated, naming the regeneration command and every affected page.

The rendering configuration of that documentation surface moved into a single module shared by the generator and the gate, so checked output can no longer be produced with a different configuration than committed output. Nothing is written to the working tree while checking.
