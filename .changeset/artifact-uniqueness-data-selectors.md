---
'@makaio/contracts': major
---

Extend `assessUniquenessSupport` and `buildUniquenessKeys` to derive uniqueness
keys from `data`-path selectors (FACT-141), not just `relation-target`
selectors. `buildUniquenessKeys` gains an optional third `data` parameter
(the artifact data being written); a `data` selector reads the exact scalar
value at its declared path and compares it by exact equality — no
normalization or case folding. Missing/null/non-scalar values produce a
visible `missing-value` or `unsupported-value-type` key issue instead of
being silently dropped. Mixed rules (`data` + `relation-target` selectors in
one `by` array) compose into a single key, same as multiple `relation-target`
selectors do today. `UniquenessKeyPart` is now a discriminated union of
`UniquenessRelationTargetKeyPart` (unchanged `{ type, target }` shape, still
usable as a jsonb containment probe) and the new `UniquenessDataKeyPart`
(`{ path, value }`).
