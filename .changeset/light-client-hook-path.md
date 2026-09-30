---
"@makaio/framework": patch
"@makaio/inbound-hooks": patch
"@makaio/subsystem-client": patch
---

Add dependency-light `@makaio/framework/inbound-hooks/stdio` and `@makaio/framework/inbound-hooks/fast-connection` subpaths (`connectFastHookBus`) and a non-owning `runtime.observe` subject in `@makaio/framework/clients/hook-subjects`, so CLI hook subprocesses can reach the bus without loading the full client and contracts graphs. The fast inbound-hook emit path now measures its deadline with a monotonic clock.
