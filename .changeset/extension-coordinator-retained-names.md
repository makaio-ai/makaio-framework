---
"@makaio/framework": minor
---

`ExtensionCoordinator.load()` now returns the readonly list of extension
manifests it retained, in load order — the input minus the packages excluded by
surface or environment filtering and their pruned dependents, with one entry per
name. Filtering happens inside `load()` and nowhere else, so a composition root
diagnosing what it handed in had to restate those rules and drift from them; it
returns the manifests rather than their names because a caller matching names
back against its own input would re-admit exactly the registrations an override
replaced. Boot uses the returned list for its operator config diagnostics and
for extension boot contributions. Additive: existing callers that ignore the
return value are unaffected.
