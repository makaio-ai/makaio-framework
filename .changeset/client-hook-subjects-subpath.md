---
"@makaio/framework": patch
"@makaio/subsystem-client": patch
---

Add the dependency-light `@makaio/framework/clients/hook-subjects` subpath so CLI hook subprocesses can build the raw `hook.received` and `hook.handle` subjects without loading the full client subsystem.
