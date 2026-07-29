---
'@makaio/framework': patch
---

Add a `MAKAIO_FRAMEWORK_BUILD_SKIP_DTS` switch to the framework distribution build for fast runtime-only builds. When set (`1`/`true`), all three build stages skip type-declaration emission — the dominant cold-build cost — for consumers that only execute the built `.mjs` output, such as smoke tests booting the bundled runtime. The dist verifier gains an explicit `expectDeclarations` option: in runtime-only mode it exempts exports-map declaration targets from the on-disk existence check while every runtime check (runtime export targets, self-import and bare-external scans, Postgres bans, migration chains) still runs in full. The build stamp now records whether the dist ships declarations, and `isFrameworkDistFresh` never accepts a runtime-only dist as a fresh full distribution.
