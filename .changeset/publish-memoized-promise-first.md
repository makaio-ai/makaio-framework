---
"@makaio/framework": patch
"@makaio/runtime-node": patch
"@makaio/kernel": patch
"@makaio/utils": patch
"@makaio/service-base": patch
"@makaio/subsystem-mcp-http-server": patch
---

Publish the shared promise of a joined operation before it runs code that can call back into it. A teardown step, abort listener, `onclose` callback or lifecycle hook that called the same shutdown, `destroy()`, `init()` or `close()` from inside the operation used to start a second run, because the memoized promise was stored only after the first step had started. The isolated workflow runtime shutdown, `BaseService.init()` and `destroy()`, the MCP server close and the provider-operation supervisor shutdown now join the run already under way, through one shared `JoinedOperation` helper that the kernel shutdown sequence and the host shutdown coordinator use as well.
