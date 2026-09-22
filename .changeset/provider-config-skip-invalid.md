---
"@makaio/framework": patch
---

Skip stale or non-conforming provider-config files instead of aborting boot.

`FileAdapterConfigRepository.loadProviderConfigs()` previously rejected the
entire load on the first non-conforming file (invalid JSON, legacy v1 schema,
unsupported version, or schema-invalid), which propagated through the adapter
subsystem — marked `critical: true` — and aborted `bootRuntime`. The loader
now skips each bad file with a per-file diagnostic warning (including the
machine-readable reason code and operator-actionable detail) and continues
loading the remaining files, matching the existing skip behaviour of
`loadAdapterConfigs()`. The `parseProviderConfig` parser's contract is
unchanged; `writeProviderConfig` still validates and throws.
