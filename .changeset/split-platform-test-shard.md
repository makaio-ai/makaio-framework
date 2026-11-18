---
"@makaio/framework": patch
---

The `Platform` CI test shard is split into `Platform-Runtime` (platforms and runtimes) and `Platform-Subsystems` (subsystems, transports, clients, providers, scripts and build tooling), so each shard stays well under the test job timeout. The vitest projects, the shard coverage check and the CI workflows use the new names.
