---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Cap derived artifact slugs at 80 characters. `deriveArtifactSlug` cuts the slug derived from the title (or from the artifact identity fallback) at the last hyphen at or below 80 characters, hard-cuts at 80 when the first segment alone is longer, and strips trailing hyphens, so the result still satisfies `ARTIFACT_SLUG_PATTERN`. A store's collision suffix is appended after the cut, so a suffixed derived slug may exceed the cap. `slugify` stays a pure, uncapped normalization; caller-supplied slugs are not cut and `ArtifactSlugSchema` gains no length limit. New export: `ARTIFACT_DERIVED_SLUG_MAX_LENGTH`.
