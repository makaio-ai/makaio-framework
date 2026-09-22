---
"@makaio/contracts": major
"@makaio/framework": major
---

Harden the operator extension config file-name codec.

`encodeExtensionNameAsPathSegment` now escapes a **leading dot** as `%2E`, so an
extension named `.hidden` is addressable as `%2Ehidden.json` instead of a hidden
file, and a canonical segment never begins with a dot. It also answers `undefined`
when the resulting `<stem>.json` would exceed the new
`MAX_OPERATOR_CONFIG_FILE_NAME_BYTES` (255), the per-component limit percent-
encoding can blow past — `"ü".repeat(43)` encodes to 258 characters and used to
be reported as addressable, then fail at `open` with `ENAMETOOLONG`. The shared
`EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX` is exported alongside it, so the bound
and the loader agree on what a file name is.

Breaking for stems that begin with a literal dot: `.hidden.json` no longer
decodes and must be renamed to `%2Ehidden.json`. No shipped extension carries
such a name. Declared `major` because both packages are past 1.0.0, where that
is the bump a breaking change takes.
