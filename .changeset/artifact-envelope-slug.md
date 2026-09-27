---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Every artifact carries a `slug` in its envelope, next to `kind` and `id`. The slug is unique per kind and scope, assigned at creation (caller-supplied or derived from the kind's `titlePath` by the store), and never changes across revisions. `ArtifactRevisionSchema` requires it, the `create` request accepts it optionally, the `revise` body omits it, and `ArtifactQueryRequestSchema` filters by it. A kind registration that declares a data field named `slug` is rejected — the envelope owns the slug, so the per-kind `data.slug` plus `indexedFields`/`uniqueness` opt-in convention ends. New exports: `ArtifactSlugSchema`, `ARTIFACT_SLUG_PATTERN`, `ARTIFACT_SLUG_FIELD`, `slugify`. Breaking for stores and fixtures that build revisions without a slug.
