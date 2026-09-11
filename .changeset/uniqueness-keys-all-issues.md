---
'@makaio/contracts': patch
---

Fix `buildUniquenessKeys` to collect all per-rule selector issues instead of only the first: when a rule's `by` array has multiple unresolvable selectors, every issue is now pushed and no key is produced, consistent with the exhaustive reporting of `assessUniquenessSupport`.
