---
"@makaio/runtime-node": minor
---

`bootMakaioRuntimeCore` reads `$MAKAIO_HOME/config/extensions/*.json` once into an
immutable operator config snapshot and hands it to the extension coordinator as the
highest-priority config layer. `CoreBootOptions.operatorConfig` lets an embedder supply
a prebuilt snapshot. Unreadable, non-JSON, or non-object files fail only the addressed
extension; a missing directory is silent, other directory read errors fail boot. The new
`@makaio/runtime-node/boot-config` subpath exposes `mergePackageConfigDefaults` so hosts
share one key-wise merge for `makaio.config.*` defaults.
