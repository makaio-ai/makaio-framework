---
"@makaio/framework": major
---

Make the exported `MakaioExtension` the single source of truth for `critical`.
A `descriptor.json` that declares a `server` entrypoint may no longer declare
`critical` — one server entry can export several packages, each with its own
criticality, so a descriptor-level flag could only ever drift from what the
coordinator honours. `ExtensionDescriptorSchema` now rejects that combination,
which fails descriptor validation, filesystem discovery, and both installers.
Descriptors with no server entrypoint (detached, CLI-only, browser-only) keep
declaring the flag, because the runtime synthesizes their single package from
that metadata. The CLI's offline listing, critical check, and `packages.list`
read the flag from the exported package whenever there is one.

**Breaking:** remove `critical` from any `descriptor.json` that declares
`entrypoints.server` and declare it on the exported package instead.

This rule is enforced at discovery, install, and verify, all of which parse
`descriptor.json` through `ExtensionDescriptorSchema`. It is not enforced at
build time: the Vite build's descriptor metadata scan reads `descriptor.json`
with a plain `JSON.parse` and does not run the schema, so a build does not
fail on a descriptor that violates this invariant.
