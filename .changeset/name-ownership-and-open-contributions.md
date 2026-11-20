---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/kernel": major
"@makaio/services-core": major
"@makaio/services-package-manager": major
"@makaio/core": minor
"@makaio/test-utils": minor
---

Enforce one name-ownership rule everywhere an extension contributes a name, and add an open slot for contribution kinds that extensions declare themselves.

Breaking for consumers:

- `ExtensionContext` has a new required field `openContributions` (an `OpenContributionReader`). Contexts built by hand must supply it, or use `makeStubExtensionContext` / `makeStubNodeExtensionContext` from `@makaio/test-utils`. Hosts that implement `ExtensionContextHost` from `@makaio/kernel` must supply the new `openContributionReaderFor(name)`.
- A name that consists only of `<owner>.` (an empty local part) is now rejected in four more places: workflow block names, transition rule ids, transition action keys, and the package names of a multi-package export. Reaction names and automation trigger kinds follow the same rule.
- The package manager applies the namespace check for exported package names on the main thread, not in the import worker. A package outside the namespace whose `critical` value cannot be cloned now reports the worker's import error instead of the namespace reason; the result is still `undefined` with a warning.

Why `major` although `host-context-for-hook-contributors` used `minor` for a similar break: the new field is required on the context every host builds, so the stricter grade applies.

New:

- `@makaio/core` exports `ExtensionNameSchema`, `ContributionNameSchema`, the types `ExtensionName` and `ContributionName`, and `localContributionName(owner, name)`, which returns the part after `<owner>.` or `undefined`. Owners may contain dots (including npm-scoped owners). `@makaio/contracts` re-exports them and the `@makaio/framework` `core` subpath makes them public. `ExtensionNameSchema` carries the extension-name grammar (a plain name or `@scope/name`; no path separators, no `.` or `..` segments), and `ExtensionManifestSchema` uses it for `name`. `isOwnNameOrContribution(owner, name)` is the companion predicate: `name` is the owner itself or an owned contribution. An extension `a` next to an extension `a.b` is not decided: both own `a.b.*` today (FACT-383).
- Open slot: `MakaioExtension.openContributions` lets any extension contribute entries under a key of the form `<declaring extension>.<kind>`. Only the declaring extension reads them, through `ctx.openContributions.of(kind)`, which returns the entries of the extensions active at the time of the call; do not cache the result. The host checks only the shape of the slot (a plain object whose keys are contribution names and whose values are arrays; anything else fails activation) and does not interpret entries. The coordinator warns once per kind that has entries but no active owner. Types: `OpenContributions`, `OpenContributionReader`, `OpenContributionSet`, `OpenContributionEntryOf`, and the augmentable `MakaioContributionKinds`.
- `@makaio/kernel` exports the type `ExtensionContextBase`: the host-supplied fields of `KernelExtensionContext`, that is everything except the coordinator-owned `bus`, `identity`, `getService`, `dataDir`, `config`, `signal`, `hasExtension` and `openContributions`. It is the type of the `extensionContextBase` option of `ExtensionCoordinatorOptions`.
- `@makaio/test-utils`: `makeStubExtensionContext` accepts overrides; new `makeStubNodeExtensionContext`, `makeStubOpenContributionReader` and `stubExtensionIdentity(name)`.
